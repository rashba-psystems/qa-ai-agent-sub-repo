'use strict';

// Durable record of every issuance attempt, so a crash or restart never leads to a blind re-issue.
//   submitting  — about to press the final button / send POST (no process id yet)
//   submitted   — the server answered with a process id
//   resolved    — final outcome known (contract number or failure), or released by a person
// One JSON file per attempt in data/insurance-runs/ (shared by НС and МСТ, mounted in Docker/k8s so it survives restarts).
//
// The rule throughout: only a definite answer closes an entry. «No answer», «still processing»,
// «API unavailable» or «unreadable file» keep it open, and an open entry blocks a new issuance.

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { processStatus, findContracts, isFinal } = require('./api');

const DIR = process.env.JOURNAL_DIR || path.resolve(__dirname, '../../data/insurance-runs');
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/; // a record id is a file name in DIR — nothing that can leave it

const file = (id) => path.join(DIR, `${id}.json`);

// Atomic: write a temp file, flush it, then rename over the target. A crash leaves either the old
// version or the new one — never half a file. Leftover *.tmp files are ignored on read.
async function write(entry) {
  await fs.ensureDir(DIR);
  entry.updatedAt = new Date().toISOString();
  const target = file(entry.id);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const fd = await fs.open(tmp, 'w');
  try {
    await fs.write(fd, JSON.stringify(entry, null, 1));
    await fs.fsync(fd);
  } finally {
    await fs.close(fd);
  }
  await fs.rename(tmp, target);
  return entry;
}

// expectsIssue: the case is supposed to create a policy (a repeat would be a duplicate)
async function begin({ caseId, channel, iin, expectsIssue = true, product = 'ns' }) {
  return write({ id: crypto.randomUUID(), caseId, channel, product, iin, expectsIssue, state: 'submitting', createdAt: new Date().toISOString() });
}

async function submitted(entry, processId) {
  Object.assign(entry, { state: 'submitted', processId });
  return write(entry);
}

// The server answered but without a process id (5xx, timeout, odd 2xx): keep the attempt open
async function unanswered(entry, httpStatus, error) {
  Object.assign(entry, { lastHttpStatus: httpStatus, lastError: String(error || '').slice(0, 300) });
  return write(entry);
}

async function resolve(entry, outcome) {
  Object.assign(entry, { state: 'resolved', outcome });
  return write(entry);
}

// Open entries. An unreadable file is returned as { state: 'corrupt' } — never silently skipped.
async function pending() {
  if (!(await fs.pathExists(DIR))) return [];
  const names = (await fs.readdir(DIR)).filter((n) => n.endsWith('.json'));
  const out = [];
  for (const n of names) {
    const p = path.join(DIR, n);
    let e;
    try {
      e = JSON.parse(await fs.readFile(p, 'utf8'));
      if (!e || typeof e !== 'object' || !e.id || !e.state) throw new Error('нет полей id/state');
    } catch (err) {
      out.push({ id: n.replace(/\.json$/, ''), state: 'corrupt', file: p, error: err.message, caseId: '*', createdAt: (await fs.stat(p)).mtime.toISOString() });
      continue;
    }
    if (e.state !== 'resolved') out.push(e);
  }
  return out;
}

// Find out what happened to an open attempt. Never issues anything; closes an entry only on a definite answer.
async function recover(entry) {
  if (entry.state === 'corrupt') {
    return { entry, known: false, note: `файл журнала повреждён (${entry.error}) — неизвестно, какая заявка в нём была` };
  }
  if (entry.processId) {
    const res = await processStatus(entry.processId, entry.product || 'ns').catch((e) => ({ error: e.message }));
    const st = res && res.ok && res.data && res.data.data;
    if (!st) return { entry, known: false, note: `статус процесса ${entry.processId} не получен (${res && res.error ? res.error : `HTTP ${res && res.status}`})` };
    if (!isFinal(st.Status)) {
      const minutes = Math.round((Date.now() - new Date(entry.createdAt).getTime()) / 60000);
      return { entry, known: false, stuck: true, note: `процесс ${entry.processId} всё ещё «${st.Status}» (${minutes} мин)` };
    }
    const outcome = { status: st.Status, contractNumber: st.ContractNumber || null, policyId: st.ID, exact: true };
    await resolve(entry, outcome);
    return { entry, known: true, outcome };
  }

  // Crashed between the click and the server's answer, or the server failed (5xx) without a process id.
  // Contracts found by IIN + time are only CANDIDATES: the test client is shared, so a colleague's policy
  // can match too. Neither «found» nor «not found» proves anything — the entry stays open for a person.
  const from = new Date(entry.createdAt).getTime() - 5000;
  const to = from + 5 * 60 * 1000;
  let list;
  try {
    list = await findContracts(entry.iin, entry.product || 'ns');
  } catch (e) {
    return { entry, known: false, note: `поиск договоров недоступен (${e.message.slice(0, 80)}) — итог неизвестен` };
  }
  const hits = (list.items || []).filter((c) => {
    const t = new Date(c.created_at).getTime();
    return t >= from && t <= to;
  });
  const why = entry.lastHttpStatus ? `сервер ответил ${entry.lastHttpStatus} без ID процесса` : 'ID процесса не сохранён';
  if (!hits.length) {
    return { entry, known: false, note: `${why}, договор не найден; без ID нельзя доказать, что заявка не создалась` };
  }
  return {
    entry,
    known: false,
    candidates: hits.map((h) => h.contract_number),
    note: `${why}; в это время на этот ИИН созданы ${hits.map((h) => h.contract_number).join(', ')} — какой из них от этой заявки (и от неё ли), не доказать`,
  };
}

// Manual release by a person (from the bot: `web ns снять <id>` or `api ns снять <id>`). A corrupt file is moved aside.
async function release(id, who) {
  if (!ID.test(String(id))) return { ok: false, note: `«${String(id).slice(0, 40)}» — не ID записи журнала (его показывает test ns journal)` };
  const p = file(id);
  if (path.dirname(p) !== DIR) return { ok: false, note: 'недопустимый ID' };
  if (!(await fs.pathExists(p))) return { ok: false, note: `записи ${id} нет` };
  let e;
  try {
    e = JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    const aside = `${p}.corrupt-${Date.now()}`;
    await fs.move(p, aside);
    return { ok: true, note: `повреждённый файл перенесён в ${path.basename(aside)}` };
  }
  if (e.state === 'resolved') return { ok: false, note: `запись ${id} уже закрыта (${e.outcome && e.outcome.status})` };
  await resolve(e, { status: 'released_manually', by: who, at: new Date().toISOString(), previousState: e.state, processId: e.processId || null });
  return { ok: true, note: `запись ${id} (${e.caseId}) закрыта вручную` };
}

module.exports = { begin, submitted, unanswered, resolve, pending, recover, release, DIR };
