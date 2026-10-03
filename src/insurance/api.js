'use strict';

// NDP API calls every product shares: the issuance process, the contract, the ESBD integration.
//   issuance:  POST /<product>/policies -> { process_instance_id } -> GET /<product>/policies/{id}/status
//   contract:  GET /contracts/{policy id}, GET /contracts?search=..., GET /contracts/{number}/integrations
// Product calls (calculator, dictionaries, the `api ns` suites) are in src/<product>/.

const { apiCall, apiRequest, listContracts } = require('../ndp/client');

const BASE = '/v1/ui/policy/v1';

const FINAL = new Set(['completed', 'failed', 'error', 'rejected', 'cancelled', 'canceled']);

const isFinal = (status) => FINAL.has(String(status).toLowerCase());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long / how often to poll the issuance process (overridable for the offline tests)
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS) || 120000;

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3000;

// "Validation failed; insurance_amount: invalid" — the whole error, for matching the expected reason
function errorText(data) {
  if (!data) return '';
  const parts = [data.message || ''];
  if (data.errors && typeof data.errors === 'object') {
    for (const [k, v] of Object.entries(data.errors)) parts.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
  // a nested answer (e.g. «calculate: nomad returned 422: {…}») keeps its Cyrillic as \uXXXX escapes
  return parts.filter(Boolean).join('; ').replace(/\\+u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\+"/g, '"');
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

// NS answers in PascalCase (Status, ID, ContractNumber…), MST in snake_case — callers read the NS names
function normalizeStatus(d) {
  if (!d || d.Status !== undefined) return d;
  return {
    ...d, Status: d.status, ID: d.policy_id || d.ID, ContractNumber: d.contract_number, TotalPremium: d.total_premium,
    TotalPremiumFinal: d.total_premium_final, CheckoutStatus: d.checkout_status, LastError: d.last_error,
  };
}

const processStatus = (processId, product) => apiCall('GET', `${BASE}/${product}/policies/${processId}/status`).then((res) => {
  if (res && res.data && res.data.data) res.data.data = normalizeStatus(res.data.data);
  return res;
});

// Follows one issuance process until it ends — the only link between a run and its contract
async function pollProcess(processId, product, timeoutMs = POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const history = [];
  let last = null;
  while (Date.now() < deadline) {
    const res = await processStatus(processId, product).catch(() => null);
    last = (res && res.ok && res.data && res.data.data) || last;
    if (last && history[history.length - 1] !== last.Status) history.push(last.Status);
    if (last && isFinal(last.Status)) return { last, history, final: true };
    await sleep(POLL_INTERVAL_MS);
  }
  return { last, history, final: false };
}

// Contract card by policy id (= Status.ID) + fields only the list endpoint has (policyholder, contacts)
async function contractById(policyId, contractNumber, product) {
  const list = await listContracts({ product, search: contractNumber, perPage: 5 }).catch(() => null);
  const item = ((list && list.items) || []).find((c) => c.contract_number === contractNumber) || {};
  // MST's process status has no policy id — the contract list has it
  const id = policyId || item.policy_id;
  if (!id) return null;
  const card = await apiRequest('GET', `${BASE}/contracts/${encodeURIComponent(id)}`).then((r) => r.data, () => null);
  if (!card) return null;
  return {
    ...item,
    ...card,
    listInsureds: item.insureds, // the contract list keeps fields the contract itself drops (MST sport type and level)
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

const findContracts = (iin, product) => listContracts({ product, search: iin, perPage: 10 });

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

module.exports = {
  BASE, errorText, firstMessage, isFinal, processStatus, pollProcess, contractById, integrations, waitEsbd, findContracts, saveClient,
};
