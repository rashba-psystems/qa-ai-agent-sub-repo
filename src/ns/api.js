'use strict';

// `api ns`: straight to the server, no browser — calculator boundaries (A01–A22, never issue) and issuance
// with the same requests the site makes (I01–I18: every request the server accepts is a REAL policy).
// Also the NS dictionaries the bot picks a purchase from.

const { apiCall, apiRequest } = require('../ndp/client');
const { BASE, errorText, firstMessage, pollProcess, contractById, waitEsbd } = require('../insurance/api');
const { check, unverified, eq, statusOf, integrationChecks, isEnglish, addDays, tomorrowIso, expectedEnd } = require('../insurance/checks');
const journal = require('../insurance/journal');
const { recoverJournal, cardUrl, client } = require('../insurance/purchase');
const { byRule, refusalChecks, contractChecks } = require('./checks');
const { calcCases, issueApiCases } = require('./cases');

const calcPreview = (variant, body) => apiCall('POST', `${BASE}/calc/products/ns/variants/${variant}/preview`, body);

const createPolicy = (body) => apiCall('POST', `${BASE}/ns/policies`, body);

async function sportCodeMap() {
  const s = await apiRequest('GET', `${BASE}/ns/schema?variant=sport&locale=ru`);
  return Object.fromEntries((s.data.dictionaries.sport_types || []).map((x) => [x.label, x.value]));
}

// What the bot picks the purchase from: amounts as the form shows them and sport type names
async function nsDictionaries() {
  const s = await apiRequest('GET', `${BASE}/ns/schema?variant=sport&locale=ru`);
  const d = s.data.dictionaries || {};
  return {
    amounts: (d.amounts || []).map((a) => ({ label: a.label, value: Number(a.value) })).filter((a) => a.value > 0),
    sports: (d.sport_types || []).map((x) => x.label),
    sportCodes: Object.fromEntries((d.sport_types || []).map((x) => [x.label, x.value])),
  };
}

// ---------- calculator boundaries (`api ns`) ----------

// '+N' / '-N' in a case's period = days from today
function resolveDate(v, today) {
  const m = /^([+-])(\d+)$/.exec(v);
  return m ? addDays(today, (m[1] === '-' ? -1 : 1) * Number(m[2])) : v;
}

// A valid 12-month request for one 30-year-old, with the case's patch on top
function buildPreviewBody(c) {
  const start = tomorrowIso();
  const today = addDays(start, -1);
  const body = {
    contract_type: 'adult',
    insurance_amount_per_insured: 1000000,
    period_mode: 'months',
    period_months: 12,
    period: { start_at: start, end_at: addDays(addDays(start, 365), -1) },
    insureds: [{ age: 30 }],
  };
  if (c.variant === 'sport') {
    Object.assign(body, { program: 'complete', territory: 'worldwide', sport_types: ['football'], insureds: [{ age: 30, profession: 'athlete' }] });
  }
  Object.assign(body, JSON.parse(JSON.stringify(c.patch)));
  if (body.period) body.period = { start_at: resolveDate(body.period.start_at, today), end_at: resolveDate(body.period.end_at, today) };
  return body;
}

async function runCalcCase(c) {
  const body = buildPreviewBody(c);
  const res = await calcPreview(c.variant || 'standard', body);
  const reason = errorText(res.data);
  const result = { id: c.id, title: c.title, kind: 'api', request: body, response: res.data, httpStatus: res.status };

  if ([401, 403].includes(res.status)) {
    result.checks = [unverified(c.title, c.expect === 'ok' ? 'расчёт' : 'отказ', `${res.status}: нет доступа — правило не проверено`, 'ui')];
  } else if (res.status >= 500) {
    result.checks = [check(c.title, false, c.expect === 'ok' ? '200' : '4xx', `${res.status}: сервер упал`, { axis: 'ui' })];
  } else if (c.expect === 'ok') {
    const ok = res.status === 200;
    result.checks = [byRule(c.rule, c.title, ok, '200, расчёт', ok ? `premium=${res.data.data && res.data.data.total_premium}` : `${res.status}: ${reason}`.slice(0, 220), 'ui')];
  } else if (res.status === 200) {
    result.checks = [byRule(c.rule, c.title, false, '4xx, отказ', `premium=${res.data.data && res.data.data.total_premium}`, 'ui')];
  } else {
    result.checks = refusalChecks(c, `${res.status}: ${reason}`, reason);
  }
  return result;
}

// Across all calculator answers: language and shape of the error messages
function calcSummaryChecks(results) {
  const rejected = results.filter((r) => r.httpStatus >= 400 && r.response);
  const english = rejected.filter((r) => isEnglish(firstMessage(r.response)));
  const shapes = new Set(rejected.map((r) => {
    const v = r.response.errors && Object.values(r.response.errors)[0];
    return Array.isArray(v) ? 'array' : typeof v;
  }));
  return [
    byRule('errors-russian', 'Сообщения об ошибках API на русском', english.length === 0, 'русский текст', `${english.length} из ${rejected.length} на английском, напр. «${english[0] ? firstMessage(english[0].response) : ''}»`),
    byRule('errors-format', 'Единый формат поля errors', shapes.size <= 1, 'один формат', [...shapes].join(' + ')),
  ];
}

// ---------- issuance straight through the API (`api ns`) ----------

function ageOn(bornIso, onIso) {
  const b = new Date(`${bornIso}T00:00:00Z`);
  const d = new Date(`${onIso}T00:00:00Z`);
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

// The body the site sends (captured from dev), with the case's changes on top.
// c: { variant, contractType, amountValue, months | days, sportCodes, profession, insureds, patch }
function buildPolicyBody(c) {
  const start = tomorrowIso();
  const term = c.days ? `${c.days} дней` : `${c.months || 12} месяцев`;
  const body = {
    variant: c.variant || 'standard',
    contract_type: c.contractType || 'adult',
    insurance_amount: c.amountValue || 1000000,
    period_mode: c.days ? 'custom_dates' : 'months',
    period_months: c.days ? null : c.months || 12,
    start_at: start,
    end_at: expectedEnd(start, term),
    phone: `+7${client.phone}`,
    phone_verified: true,
    delivery_method: 'email',
    delivery_email: client.email,
    delivery_phone: `+7${client.phone}`,
    city: 'Almaty',
    payment_method: 'cash',
    policyholder: { ...client.person },
    insureds: (c.insureds || [client.person]).map((p) => ({ ...p })),
  };
  if (body.variant === 'sport') {
    Object.assign(body, { program: 'complete', territory: 'worldwide', sport_types: c.sportCodes || ['football'] });
    body.insureds = body.insureds.map((p) => ({ ...p, profession: c.profession || 'athlete' }));
  }
  if (c.patch) c.patch(body, { start });
  return body;
}

// The premium the calculator gives for the same request — what the contract must carry
async function calculatorPremium(body) {
  const preview = {
    contract_type: body.contract_type,
    insurance_amount_per_insured: body.insurance_amount,
    period_mode: body.period_mode,
    period_months: body.period_months,
    period: { start_at: body.start_at, end_at: body.end_at },
    insureds: body.insureds.map((p) => ({ age: ageOn(p.born_date, body.start_at), ...(p.profession ? { profession: p.profession } : {}) })),
  };
  if (body.variant === 'sport') Object.assign(preview, { program: body.program, territory: body.territory, sport_types: body.sport_types });
  const res = await calcPreview(body.variant, preview).catch(() => null);
  return res && res.status === 200 ? res.data.data.total_premium : null;
}

// Sends the request with the journal around it. Only a process id or a 4xx closes the journal entry;
// 5xx, a network failure or an odd 2xx leave it open (the server may have created a policy anyway).
async function submit(c, body) {
  const entry = await journal.begin({ caseId: c.id, channel: 'api', iin: client.iin, expectsIssue: c.expect === 'issue' });
  let post;
  try {
    post = await createPolicy(body);
  } catch (e) {
    await journal.unanswered(entry, 'network', e.message);
    throw e;
  }
  const processId = post.ok && post.data && post.data.data && post.data.data.process_instance_id;
  if (processId) await journal.submitted(entry, processId);
  else if (post.status >= 400 && post.status < 500) await journal.resolve(entry, { status: `rejected_${post.status}`, error: errorText(post.data).slice(0, 300) });
  else await journal.unanswered(entry, post.status, errorText(post.data));
  return { post, processId, entry };
}

async function runPositive(c) {
  const checks = [];
  const out = {};
  const body = buildPolicyBody(c);
  const premium = await calculatorPremium(body);
  const { post, processId, entry } = await submit(c, body);
  checks.push(check('POST /ns/policies принят', post.status === 201, 201, `${post.status}${post.ok ? '' : `: ${errorText(post.data).slice(0, 200)}`}`, { axis: 'issue' }));
  if (!processId) return { checks, out };
  out.processId = processId;

  const proc = await pollProcess(processId, 'ns');
  out.statusHistory = proc.history.join(' → ');
  if (!proc.final) {
    checks.push(unverified('Выписка завершена (NDP)', 'completed', `процесс не завершился за 2 мин (${out.statusHistory}); итог выяснится по журналу`, 'issue'));
    return { checks, out };
  }
  const st = proc.last;
  await journal.resolve(entry, { status: st.Status, contractNumber: st.ContractNumber, policyId: st.ID, exact: true });
  checks.push(eq('Выписка завершена (NDP)', st.Status, 'completed', { axis: 'issue' }));
  if (st.Status !== 'completed') return { checks, out };
  Object.assign(out, { contractNumber: st.ContractNumber, policyId: st.ID });
  checks.push(eq('Оплата отмечена (CheckoutStatus)', st.CheckoutStatus, 'paid', { axis: 'issue' }));
  checks.push(eq('Премия = калькулятор', st.TotalPremium, premium, { noExpected: 'калькулятор не ответил' }));
  checks.push(eq('TotalPremiumFinal = TotalPremium', st.TotalPremiumFinal, st.TotalPremium));

  const contract = await contractById(st.ID, st.ContractNumber);
  const exp = {
    contractNumber: st.ContractNumber, variant: body.variant, contractType: body.contract_type, amountValue: body.insurance_amount,
    startDate: body.start_at, endDate: body.end_at, holderIin: body.policyholder.iin, insuredIins: body.insureds.map((i) => i.iin),
    sportCodes: body.sport_types, phone: client.phone, email: client.email,
  };
  checks.push(...contractChecks({ exp, contract }));
  if (contract) checks.push(eq('Договор: total_premium = калькулятор', contract.total_premium, premium, { noExpected: 'калькулятор не ответил' }));
  checks.push(...integrationChecks({ list: await waitEsbd(st.ContractNumber), contract }));
  return { checks, out };
}

// Negative case: the server must refuse FOR THE EXPECTED REASON. Not being issued is not enough:
// a hang, a refusal without a reason or for another reason leaves the rule unverified.
async function runNegative(c) {
  const body = buildPolicyBody(c);
  const out = {};
  const { post, processId, entry } = await submit(c, body);

  if (!processId) {
    const reason = errorText(post.data);
    if ([401, 403].includes(post.status)) return { checks: [unverified(c.title, 'отказ по правилу', `${post.status}: нет доступа — правило не проверено`, 'ui')], out };
    if (post.status >= 500 || post.status < 400) return { checks: [unverified(c.title, 'отказ по правилу', `сервер ответил ${post.status} без ID процесса — итог неизвестен`, 'ui')], out };
    return { checks: refusalChecks(c, `${post.status}: ${reason}`, reason), out };
  }

  out.processId = processId;
  const proc = await pollProcess(processId, 'ns');
  out.statusHistory = proc.history.join(' → ');
  const st = proc.last;
  if (proc.final) await journal.resolve(entry, { status: st.Status, contractNumber: st.ContractNumber || null, policyId: st.ID, exact: true });

  if (st && st.Status === 'completed') {
    Object.assign(out, { contractNumber: st.ContractNumber, policyId: st.ID });
    return { checks: [byRule(c.rule, c.title, false, 'отказ', `выписан ${st.ContractNumber}, премия ${st.TotalPremium}`, 'ui')], out };
  }
  if (!proc.final) {
    return {
      checks: [
        unverified(c.title, 'отказ по правилу', `процесс завис в «${st ? st.Status : '?'}» > 2 мин — отказа нет`, 'ui'),
        check('Некорректная заявка отклонена сразу (422), а не зависла', false, '422 или статус failed', `принята (201), процесс ${processId} висит в «${st ? st.Status : '?'}» > 2 мин без ошибки`, { axis: 'ui' }),
      ],
      out,
    };
  }
  const reason = st.LastError ? (typeof st.LastError === 'string' ? st.LastError : JSON.stringify(st.LastError)) : '';
  if (!reason) {
    return {
      checks: [
        unverified(c.title, 'отказ по правилу', `процесс завершился «${st.Status}» без LastError — причина отказа неизвестна`, 'ui'),
        check('Причина отказа сохранена (LastError)', false, 'текст ошибки', '(пусто)', { severity: 'note', axis: 'ui' }),
      ],
      out,
    };
  }
  return { checks: refusalChecks(c, `не выписан: ${st.Status} (${reason})`, reason), out };
}

async function runIssueCase(c) {
  const r = { id: c.id, title: c.title, kind: 'api-issue', expect: c.expect, checks: [] };
  try {
    const { checks, out } = c.expect === 'issue' ? await runPositive(c) : await runNegative(c);
    r.checks = checks;
    Object.assign(r, out);
  } catch (e) {
    r.error = `${e.name}: ${e.message.split('\n')[0]}`;
  }
  return r;
}

// ---------- the whole `api ns` run ----------

// Calculator first (never issues), then issuance; an issuance case whose earlier request is still open is not re-run
async function runApiSuite({ onProgress = async () => {} } = {}) {
  const total = calcCases.length + issueApiCases.length;
  const results = [];
  let done = 0;
  await onProgress({ done, total, current: 'проверяю незавершённые заявки прошлых запусков' });
  const rec = await recoverJournal({ channel: 'api' });
  if (rec.row) results.push({ ...rec.row, product: 'ns' });

  await onProgress({ done, total, current: `калькулятор: ${calcCases.length} проверок` });
  const calcResults = [];
  for (const c of calcCases) {
    const r = await runCalcCase(c).catch((e) => ({ id: c.id, title: c.title, kind: 'api', checks: [], error: e.message }));
    calcResults.push({ ...r, product: 'ns', status: statusOf(r.checks, r.error) });
    done++;
  }
  const summary = { id: 'A--', title: 'Калькулятор: общие наблюдения', kind: 'api', product: 'ns', checks: calcSummaryChecks(calcResults) };
  summary.status = statusOf(summary.checks);
  results.push(...calcResults, summary);

  for (const c of issueApiCases) {
    if (rec.blocked.has(c.id) || rec.blocked.has('*')) {
      const why = rec.blocked.has('*') ? 'журнал заявок повреждён' : 'прошлая заявка этого сценария ещё не завершилась';
      results.push({ id: c.id, title: c.title, kind: 'api-issue', expect: c.expect, product: 'ns', checks: [], status: 'error', error: `${why} — новый запуск не выполнялся, чтобы не создать лишний полис (см. R--)` });
      done++;
      continue;
    }
    await onProgress({ done, total, current: `${c.id} ${c.title}` });
    const r = await runIssueCase(c);
    if (r.policyId) r.cardUrl = cardUrl(r.policyId);
    results.push({ ...r, product: 'ns', status: statusOf(r.checks, r.error) });
    done++;
  }
  return results;
}

module.exports = { runApiSuite, nsDictionaries, sportCodeMap, calcPreview, buildPolicyBody };
