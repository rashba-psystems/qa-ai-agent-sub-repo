'use strict';

// Everything the NS tests do straight through the NDP API, no browser.
//   calls:       calculator  POST /calc/products/ns/variants/{variant}/preview
//                issuance    POST /ns/policies -> { process_instance_id } -> GET /ns/policies/{id}/status
//                contract    GET /contracts/{policy id}, GET /contracts?search=..., GET /contracts/{number}/integrations
//   calculator:  boundary values (A01–A22) — never issues a policy
//   issuance:    the same requests the site makes (I01–I18) — every request the server accepts is a REAL policy

const { apiCall, apiRequest, listContracts } = require('../ndp/client');
const {
  check, unverified, eq, byRule, refusalChecks, contractChecks, integrationChecks, isEnglish, addDays, tomorrowIso, expectedEnd,
} = require('./checks');
const { client } = require('../../fixtures/ns.json');

// journal.js uses the calls below, so it is loaded on first use instead of at the top
const journal = () => require('./journal');

const BASE = '/v1/ui/policy/v1';
const FINAL = new Set(['completed', 'failed', 'error', 'rejected', 'cancelled', 'canceled']);
const isFinal = (status) => FINAL.has(String(status).toLowerCase());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How long / how often to poll the issuance process (overridable for the offline tests)
const POLL_TIMEOUT_MS = Number(process.env.NS_POLL_TIMEOUT_MS) || 120000;
const POLL_INTERVAL_MS = Number(process.env.NS_POLL_INTERVAL_MS) || 3000;

// "Validation failed; insurance_amount: invalid" — the whole error, for matching the expected reason
function errorText(data) {
  if (!data) return '';
  const parts = [data.message || ''];
  if (data.errors && typeof data.errors === 'object') {
    for (const [k, v] of Object.entries(data.errors)) parts.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
  return parts.filter(Boolean).join('; ');
}

// The first human-readable error message (for the language check)
function firstMessage(data) {
  const errs = data && data.errors;
  if (errs && typeof errs === 'object') {
    const v = Object.values(errs)[0];
    return Array.isArray(v) ? v[0] : String(v);
  }
  return (data && data.message) || '';
}

const calcPreview = (variant, body) => apiCall('POST', `${BASE}/calc/products/ns/variants/${variant}/preview`, body);
const createPolicy = (body) => apiCall('POST', `${BASE}/ns/policies`, body);
const processStatus = (processId) => apiCall('GET', `${BASE}/ns/policies/${processId}/status`);

// Follows one issuance process until it ends — the only link between a run and its contract
async function pollProcess(processId, timeoutMs = POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const history = [];
  let last = null;
  while (Date.now() < deadline) {
    const res = await processStatus(processId).catch(() => null);
    last = (res && res.ok && res.data && res.data.data) || last;
    if (last && history[history.length - 1] !== last.Status) history.push(last.Status);
    if (last && isFinal(last.Status)) return { last, history, final: true };
    await sleep(POLL_INTERVAL_MS);
  }
  return { last, history, final: false };
}

// Contract card by policy id (= Status.ID) + fields only the list endpoint has (policyholder, contacts)
async function contractById(policyId, contractNumber) {
  const card = await apiRequest('GET', `${BASE}/contracts/${encodeURIComponent(policyId)}`).then((r) => r.data, () => null);
  if (!card) return null;
  const list = await listContracts({ product: 'ns', search: contractNumber, perPage: 5 }).catch(() => null);
  const item = ((list && list.items) || []).find((c) => c.contract_number === contractNumber) || {};
  return {
    ...item,
    ...card,
    policyholder: item.policyholder,
    delivery_phone: item.delivery_phone || card.delivery_phone,
    delivery_email: item.delivery_email || card.delivery_email,
  };
}

async function integrations(contractNumber) {
  const res = await apiCall('GET', `${BASE}/contracts/${encodeURIComponent(contractNumber)}/integrations`).catch(() => null);
  const list = res && res.ok && res.data ? res.data.data : null;
  return Array.isArray(list) ? list : null; // anything else = «не удалось получить»
}

// Waits until ESBD has answered for this contract (success or failed), up to timeoutMs
async function waitEsbd(contractNumber, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let list = null;
  while (Date.now() < deadline) {
    list = await integrations(contractNumber);
    const esbd = list && list.find((i) => i.system === 'esbd');
    if (esbd && ['success', 'failed'].includes(esbd.status)) break;
    await sleep(POLL_INTERVAL_MS);
  }
  return list;
}

const findNsContracts = (iin) => listContracts({ product: 'ns', search: iin, perPage: 10 });

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
  const entry = await journal().begin({ caseId: c.id, channel: 'api', iin: client.iin, expectsIssue: c.expect === 'issue' });
  let post;
  try {
    post = await createPolicy(body);
  } catch (e) {
    await journal().unanswered(entry, 'network', e.message);
    throw e;
  }
  const processId = post.ok && post.data && post.data.data && post.data.data.process_instance_id;
  if (processId) await journal().submitted(entry, processId);
  else if (post.status >= 400 && post.status < 500) await journal().resolve(entry, { status: `rejected_${post.status}`, error: errorText(post.data).slice(0, 300) });
  else await journal().unanswered(entry, post.status, errorText(post.data));
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

  const proc = await pollProcess(processId);
  out.statusHistory = proc.history.join(' → ');
  if (!proc.final) {
    checks.push(unverified('Выписка завершена (NDP)', 'completed', `процесс не завершился за 2 мин (${out.statusHistory}); итог выяснится по журналу`, 'issue'));
    return { checks, out };
  }
  const st = proc.last;
  await journal().resolve(entry, { status: st.Status, contractNumber: st.ContractNumber, policyId: st.ID, exact: true });
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
  const proc = await pollProcess(processId);
  out.statusHistory = proc.history.join(' → ');
  const st = proc.last;
  if (proc.final) await journal().resolve(entry, { status: st.Status, contractNumber: st.ContractNumber || null, policyId: st.ID, exact: true });

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

module.exports = {
  errorText, firstMessage, isFinal,
  calcPreview, createPolicy, processStatus, pollProcess, contractById, integrations, waitEsbd, findNsContracts, sportCodeMap, nsDictionaries,
  runCalcCase, calcSummaryChecks, runIssueCase, buildPolicyBody,
};
