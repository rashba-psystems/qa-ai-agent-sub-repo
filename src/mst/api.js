'use strict';

// `api mst`: straight to the server, no browser — calculator boundaries (MA01–MA30, never issue) and issuance
// with the requests the site makes (MI01–MI18: every request the server accepts is a REAL policy). МСТ and Premium.

const { apiCall } = require('../ndp/client');
const { BASE, errorText, firstMessage, pollProcess, contractById, waitEsbd } = require('../insurance/api');
const { check, unverified, eq, statusOf, integrationChecks, isEnglish, addDays, tomorrowIso, makeRules } = require('../insurance/checks');
const journal = require('../insurance/journal');
const { recoverJournal, cardUrl, client } = require('../insurance/purchase');
const { mstDictionaries, tourist, calcCases, issueApiCases } = require('./cases');
const { contractChecks } = require('./checks');
const { requirements: { rules } } = require('../../fixtures/mst.json');

const { byRule, refusalChecks } = makeRules(rules, 'fixtures/mst.json → requirements');

const calcPreview = (variant, body) => apiCall('POST', `${BASE}/calc/products/mst/variants/${variant}/preview`, body);
const createPolicy = (variant, body) => apiCall('POST', `${BASE}/mst/policies?variant=${variant}`, body);

// ---------- dictionaries: amounts belong to a zone, each variant has its own list ----------

const dictCache = {};
const dictOf = async (variant) => dictCache[variant] || (dictCache[variant] = await mstDictionaries(variant));

async function helpers(variant) {
  const [dict, standard] = await Promise.all([dictOf(variant), dictOf('standard')]);
  const zoneOf = (d, code) => (d.countries.find((c) => c.value === code) || {}).zone;
  const inZone = (d, code) => d.amounts.filter((a) => a.zone === zoneOf(d, code)).sort((a, b) => a.price - b.price);
  return {
    start: tomorrowIso(),
    amount: (code) => inZone(dict, code)[0],
    otherZoneAmount: (code) => dict.amounts.find((a) => a.zone !== zoneOf(dict, code)),
    standardAmount: (code) => inZone(standard, code)[0],
  };
}

// ---------- calculator boundaries ----------

async function buildPreviewBody(c) {
  const h = await helpers(c.variant || 'standard');
  const body = {
    period: { start_at: h.start, end_at: addDays(h.start, 7) },
    destinations: [{ country_code: 'TUR' }],
    tariff: 'base',
    sum_insured: h.amount('TUR').value,
    insureds: [{ age_code: 'adult', purpose: 'tourism', active_relax: false, covid_19: 0 }],
  };
  c.patch(body, h);
  return body;
}

// A refusal comes either as 4xx or as 200 with errors in the body and premium 0 («soft»)
function answerOf(res) {
  const d = res.data && res.data.data;
  const soft = res.status === 200 && !!d && ((d.errors && d.errors.length > 0) || !(d.total_premium > 0));
  const reason = soft ? (d.errors || []).join('; ') || 'премия 0 без объяснения' : errorText(res.data);
  return { premium: d && d.total_premium, soft, reason };
}

async function runCalcCase(c) {
  const variant = c.variant || 'standard';
  const body = await buildPreviewBody(c);
  const res = await calcPreview(variant, body);
  const a = answerOf(res);
  const result = { id: c.id, title: c.variant === 'premium' ? c.title : `МСТ: ${c.title}`, kind: 'api', variant, request: body, response: res.data, httpStatus: res.status, soft: a.soft, reason: a.reason };
  const refused = res.status >= 400 || a.soft;

  if ([401, 403].includes(res.status)) {
    result.checks = [unverified(c.title, c.expect === 'ok' ? 'расчёт' : 'отказ', `${res.status}: нет доступа — правило не проверено`, 'ui')];
  } else if (res.status >= 500) {
    result.checks = [check(c.title, false, c.expect === 'ok' ? 'расчёт' : 'отказ', `${res.status}: сервер не ответил (стенд)`, { axis: 'ui' })];
  } else if (c.expect === 'ok') {
    result.checks = [byRule(c.rule, c.title, !refused, 'расчёт, премия больше 0', refused ? `${res.status}: ${a.reason}`.slice(0, 220) : `премия ${a.premium} ₸`, 'ui')];
  } else if (!refused) {
    result.checks = [byRule(c.rule, c.title, false, 'отказ', `посчитал: премия ${a.premium} ₸`, 'ui')];
  } else {
    result.checks = refusalChecks(c, `${res.status}: ${a.reason}`, a.reason);
  }
  return result;
}

// Across all answers: language and the way refusals come; the same request gives the same price
async function calcSummaryChecks(results) {
  const refusals = results.filter((r) => r.httpStatus >= 400 || r.soft);
  const english = refusals.filter((r) => isEnglish(r.soft ? r.reason : firstMessage(r.response)));
  const ways = new Set(refusals.map((r) => (r.soft ? '200 с ошибкой в ответе и премией 0' : `${r.httpStatus}`)));
  const base = calcCases[0];
  const [one, two] = await Promise.all([1, 2].map(async () => answerOf(await calcPreview('standard', await buildPreviewBody(base))).premium));
  return [
    byRule('errors-russian', 'Сообщения об ошибках на русском', english.length === 0, 'русский текст', `${english.length} из ${refusals.length} на английском, напр. «${english[0] ? (english[0].soft ? english[0].reason : firstMessage(english[0].response)) : ''}»`),
    byRule('errors-format', 'Сервер отказывает одним способом', ways.size <= 1, 'один способ (4xx)', [...ways].join(' + ')),
    eq('Одинаковый запрос — одинаковая цена', two, one),
  ];
}

// ---------- issuance straight through the API ----------

const ageCode = (born, on) => {
  const b = new Date(`${born}T00:00:00Z`);
  const d = new Date(`${on}T00:00:00Z`);
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) age--;
  return age <= 3 ? 'infant' : age <= 74 ? 'adult' : 'elder';
};
const phoneFormatted = (p) => `+7(${p.slice(0, 3)})${p.slice(3, 6)}-${p.slice(6, 8)}-${p.slice(8)}`;

// Saves a person in ESBD as the site does before issuing (kdp/save -> the ESBD client id). МСТ needs the passport
// as the document: the shared test client may last have been saved with the ID card (by another product) —
// then the server refuses with «тип документа должен быть "rk_passport", получен "rk_id"». The stand sometimes
// answers 503 here, so up to three tries.
async function saveClient(p) {
  const ru = (iso) => iso.split('-').reverse().join('.');
  const body = {
    id: p.id || 0, resident_bool: 1, born: ru(p.born), document_type: 'rk_passport', document_number: p.docNumber, document_date: ru(p.docDate),
    document_issued_by: p.issuedBy, first_name: p.firstName, last_name: p.lastName, iin: p.iin, first_name_eng: p.firstNameLatin,
    last_name_eng: p.lastNameLatin, ...(p.address ? { address: p.address } : {}),
  };
  let res = null;
  let failure = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await apiCall('POST', `${BASE}/kdp/save`, body).catch((e) => ({ status: 0, data: { message: e.message } }));
    const id = res.data && res.data.data && res.data.data.client_id;
    if (id) return id;
    failure = `kdp/save ${res.status || 'нет ответа'}: ${errorText(res.data).slice(0, 120)}`;
    if (res.status >= 400 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`клиент ${p.iin} не сохранён в ЕСБД (${failure})`);
}

async function saveTourist(t) {
  const id = await saveClient({
    iin: t.iin, born: t.birthDate, docNumber: t.docNumber, docDate: t.docDate, issuedBy: 'МВД РК', firstName: t.firstName, lastName: t.lastName,
    firstNameLatin: t.firstNameLatin, lastNameLatin: t.lastNameLatin,
  });
  return {
    iin: t.iin, full_name_latin: `${t.lastNameLatin} ${t.firstNameLatin}`, born_date: t.birthDate, esbd_client_id: id,
    passport_number: t.docNumber, passport_issued_date: t.docDate, passport_issued_by: 'МВД РК', gender: t.gender,
  };
}

// The body the site sends (captured from dev), with the case's changes on top
async function buildPolicyBody(c) {
  const variant = c.variant || 'standard';
  const h = await helpers(variant);
  const p = client.person;
  const purpose = c.purpose || 'tourism';
  const holderId = await saveClient({
    id: Number(p.esbd_client_id), iin: p.iin, born: p.born_date, docNumber: p.document_number, docDate: p.document_date, issuedBy: p.document_issued_by,
    firstName: p.first_name, lastName: p.last_name, firstNameLatin: p.first_name_eng, lastNameLatin: p.last_name_eng, address: p.address,
  });
  const people = [
    { iin: p.iin, full_name_latin: `${p.last_name_eng} ${p.first_name_eng}`, born_date: p.born_date, esbd_client_id: holderId,
      passport_number: p.document_number, passport_issued_date: p.document_date, passport_issued_by: p.document_issued_by, gender: p.gender },
  ];
  for (let i = 0; i < (c.extra || 0); i++) people.push(await saveTourist(tourist('adult', i + 1)));
  const body = {
    variant,
    policyholder: {
      type: 'person', full_name: p.full_name, address: p.address, residency: 'KAZ', resident: true, economic_activity_type: '18',
      economic_sector_code: '9', is_public_official: false, phone: phoneFormatted(client.phone), identifier: p.iin, esbd_client_id: holderId,
    },
    is_pdl: false,
    country_codes: ['TUR'],
    tariff: 'base',
    sum_insured: h.amount('TUR').value,
    start_at: h.start,
    end_at: addDays(h.start, 7),
    purpose,
    insureds_count: people.length,
    delivery_method: 'email',
    delivery_email: client.email,
    delivery_phone: `7${client.phone}`,
    phone: phoneFormatted(client.phone),
    active_relax: false,
    covid_19: 0,
    city: 'Almaty',
    payment_method: 'cash',
    insureds: people.map((x) => ({
      ...x, purpose, active_relax: false, covid_19: 0, economic_activity_type: '18', economic_sector_code: '9',
      citizenship: 'KAZ', resident: true, residency: 'KAZ', is_pdl: false, ...(c.sport || {}),
    })),
  };
  if (c.patch) c.patch(body, h);
  return { body, amount: h.amount('TUR') };
}

// The premium the calculator gives for the same request — what the contract must carry
async function calculatorPremium(body) {
  const preview = {
    period: { start_at: body.start_at, end_at: body.end_at },
    destinations: (body.country_codes || []).map((code) => ({ country_code: code })),
    tariff: body.tariff,
    sum_insured: body.sum_insured,
    insureds: body.insureds.map((i) => ({
      age_code: ageCode(i.born_date, body.start_at), purpose: i.purpose, active_relax: i.active_relax, covid_19: i.covid_19,
      ...(i.sport ? { sport: i.sport, sport_level: i.sport_level } : {}),
    })),
  };
  const res = await calcPreview(body.variant, preview).catch(() => null);
  if (!res || res.status !== 200) return null;
  const a = answerOf(res);
  return a.soft ? null : a.premium;
}

// Sends the request with the journal around it. Only a process id or a 4xx closes the journal entry.
async function submit(c, body) {
  const entry = await journal.begin({ caseId: c.id, channel: 'api', product: 'mst', iin: client.iin, expectsIssue: c.expect === 'issue' });
  let post;
  try {
    post = await createPolicy(body.variant, body);
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
  const { body, amount } = await buildPolicyBody(c);
  const premium = await calculatorPremium(body);
  const { post, processId, entry } = await submit(c, body);
  checks.push(check('POST /mst/policies принят', post.status === 201, 201, `${post.status}${post.ok ? '' : `: ${errorText(post.data).slice(0, 200)}`}`, { axis: 'issue' }));
  if (!processId) return { checks, out };
  out.processId = processId;

  const proc = await pollProcess(processId, 'mst');
  out.statusHistory = proc.history.join(' → ');
  if (!proc.final) {
    checks.push(unverified('Выписка завершена (NDP)', 'completed', `процесс не завершился за 2 мин (${out.statusHistory}); итог выяснится по журналу`, 'issue'));
    return { checks, out };
  }
  const st = proc.last;
  await journal.resolve(entry, { status: st.Status, contractNumber: st.ContractNumber, policyId: st.ID, exact: true });
  checks.push(eq('Выписка завершена (NDP)', st.Status, 'completed', { axis: 'issue' }));
  if (st.Status !== 'completed') return { checks, out };
  out.contractNumber = st.ContractNumber;
  checks.push(eq('Оплата отмечена (CheckoutStatus)', st.CheckoutStatus, 'paid', { axis: 'issue' }));
  checks.push(eq('Премия = калькулятор', st.TotalPremium, premium, { noExpected: 'калькулятор не ответил' }));

  // right after «completed» the tourists' sums may not be written yet — read again for up to 10 s
  let contract = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    contract = await contractById(null, st.ContractNumber, 'mst');
    const ins = contract && contract.details && contract.details.insureds;
    if (Array.isArray(ins) && ins.length && ins.every((i) => i.sum_insured_in_currency)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (contract) Object.assign(out, { policyId: contract.policy_id, cardUrl: cardUrl(contract.policy_id) });
  const exp = {
    contractNumber: st.ContractNumber, countryCode: 'TUR', startDate: body.start_at, endDate: body.end_at, purpose: body.purpose,
    count: body.insureds.length, ageCode: 'adult', insuredIins: body.insureds.map((i) => i.iin), amountPrice: amount.price, currency: amount.currency,
    sportCode: c.sport && c.sport.sport, levelCode: c.sport && c.sport.sport_level,
  };
  checks.push(...contractChecks({ exp, contract }));
  if (contract) checks.push(eq('Договор: total_premium = калькулятор', contract.total_premium, premium, { noExpected: 'калькулятор не ответил' }));
  checks.push(...integrationChecks({ list: await waitEsbd(st.ContractNumber), contract }));
  return { checks, out };
}

// Negative case: the server must refuse FOR THE EXPECTED REASON. Not being issued is not enough.
async function runNegative(c) {
  const { body } = await buildPolicyBody(c);
  const out = {};
  const { post, processId, entry } = await submit(c, body);

  if (!processId) {
    const reason = errorText(post.data);
    if ([401, 403].includes(post.status)) return { checks: [unverified(c.title, 'отказ по правилу', `${post.status}: нет доступа — правило не проверено`, 'ui')], out };
    if (post.status >= 500 || post.status < 400) return { checks: [unverified(c.title, 'отказ по правилу', `сервер ответил ${post.status} без ID процесса — итог неизвестен`, 'ui')], out };
    return { checks: refusalChecks(c, `${post.status}: ${reason}`, reason), out };
  }

  out.processId = processId;
  const proc = await pollProcess(processId, 'mst');
  out.statusHistory = proc.history.join(' → ');
  const st = proc.last;
  if (proc.final) await journal.resolve(entry, { status: st.Status, contractNumber: st.ContractNumber || null, policyId: st.ID, exact: true });

  if (st && st.Status === 'completed') {
    out.contractNumber = st.ContractNumber;
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
        unverified(c.title, 'отказ по правилу', `процесс завершился «${st.Status}» без причины — причина отказа неизвестна`, 'ui'),
        check('Причина отказа сохранена', false, 'текст ошибки', '(пусто)', { severity: 'note', axis: 'ui' }),
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

// ---------- the whole `api mst` run ----------

// Calculator first (never issues), then issuance; a case whose earlier request is still open is not re-run
async function runApiSuite({ onProgress = async () => {} } = {}) {
  const total = calcCases.length + issueApiCases.length;
  const results = [];
  let done = 0;
  await onProgress({ done, total, current: 'проверяю незавершённые заявки прошлых запусков' });
  const rec = await recoverJournal({ channel: 'api', product: 'mst' });
  if (rec.row) results.push({ ...rec.row, product: 'mst' });

  await onProgress({ done, total, current: `калькулятор: ${calcCases.length} проверок` });
  const calcResults = [];
  for (const c of calcCases) {
    const r = await runCalcCase(c).catch((e) => ({ id: c.id, title: c.title, kind: 'api', checks: [], error: e.message }));
    calcResults.push({ ...r, product: 'mst', status: statusOf(r.checks, r.error) });
    done++;
  }
  const summary = { id: 'A--', title: 'Калькулятор: общие наблюдения', kind: 'api', product: 'mst', checks: await calcSummaryChecks(calcResults) };
  summary.status = statusOf(summary.checks);
  results.push(...calcResults, summary);

  for (const c of issueApiCases) {
    if (rec.blocked.has(c.id) || rec.blocked.has('*')) {
      const why = rec.blocked.has('*') ? 'журнал заявок повреждён' : 'прошлая заявка этого сценария ещё не завершилась';
      results.push({ id: c.id, title: c.title, kind: 'api-issue', expect: c.expect, product: 'mst', checks: [], status: 'error', error: `${why} — новый запуск не выполнялся, чтобы не создать лишний полис (см. R--)` });
      done++;
      continue;
    }
    await onProgress({ done, total, current: `${c.id} ${c.title}` });
    const r = await runIssueCase(c);
    results.push({ ...r, product: 'mst', status: statusOf(r.checks, r.error) });
    done++;
  }
  return results;
}

module.exports = { runApiSuite, runCalcCase, runIssueCase, calcSummaryChecks, calcPreview, buildPolicyBody };
