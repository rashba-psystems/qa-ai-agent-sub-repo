'use strict';

const BASE_URL = process.env.MYNDP_BASE_URL || 'https://api-dev.myndp.kz/api';
const LOGIN = process.env.MYNDP_LOGIN;
const PASSWORD = process.env.MYNDP_PASSWORD;

let cachedToken = null;
let tokenExpiresAt = 0;

function decodeJwtExpiry(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const { exp } = JSON.parse(json);
    return exp ? exp * 1000 : null;
  } catch {
    return null;
  }
}

async function login() {
  if (!LOGIN || !PASSWORD) {
    throw new Error('MYNDP_LOGIN / MYNDP_PASSWORD не заданы в .env');
  }

  const res = await fetch(`${BASE_URL}/v1/ui/iam/v1/auth/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`NDP login failed (${res.status}): ${body.message || 'unknown error'}`);
  }

  const token = body && body.data && body.data.access;
  if (!token) throw new Error('NDP login: токен не найден в ответе');

  cachedToken = token;
  // JWT TTL is short (~15 min) — fall back to a conservative guess if it can't be decoded.
  tokenExpiresAt = decodeJwtExpiry(token) || Date.now() + 10 * 60 * 1000;
  return token;
}

async function getToken() {
  const SAFETY_MARGIN_MS = 15 * 1000;
  if (cachedToken && Date.now() < tokenExpiresAt - SAFETY_MARGIN_MS) return cachedToken;
  return login();
}

// Raw call: never throws on HTTP errors — returns { status, data } (used by negative API checks).
async function apiCall(method, path, body, { retry = true } = {}) {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retry) {
    cachedToken = null;
    return apiCall(method, path, body, { retry: false });
  }

  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function apiRequest(method, path, body) {
  const { status, ok, data } = await apiCall(method, path, body);
  if (!ok) {
    const detail = data.errors ? JSON.stringify(data.errors) : data.message;
    throw new Error(`NDP API ${method} ${path} -> ${status}: ${detail || 'unknown error'}`);
  }
  return data;
}

async function listContracts({ product, search, perPage = 10 } = {}) {
  // The server's own `product` query param is a no-op (confirmed live against
  // api-dev.myndp.kz: filtering by ns/mst/ogpo_vts all return the identical,
  // unfiltered list) — so we over-fetch and filter by `item.product` client-side.
  // With ~27 contracts total in dev this covers everything; revisit if dev grows.
  const fetchSize = product ? Math.max(perPage * 5, 50) : perPage;
  const params = new URLSearchParams({ per_page: String(fetchSize), sort: '-created_at' });
  if (search) params.set('search', search);
  const { data } = await apiRequest('GET', `/v1/ui/policy/v1/contracts?${params}`);
  let items = data.items || [];
  if (product) items = items.filter((c) => c.product === product);
  return { items: items.slice(0, perPage), pagination: data.pagination || null };
}

async function getContractByNumber(contractNumber) {
  const { data } = await apiRequest(
    'GET',
    `/v1/ui/policy/v1/contracts/${encodeURIComponent(contractNumber)}`
  );
  return data;
}

module.exports = {
  getToken,
  apiCall,
  apiRequest,
  listContracts,
  getContractByNumber,
};
