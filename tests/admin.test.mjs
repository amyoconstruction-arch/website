import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAdminHandler, ADMIN_EMAIL } from '../api/admin.js';

const NOW = Date.parse('2026-10-15T10:00:00Z');
const USER_ID = 'b80b172d-c935-4f15-961d-c4ed845a0564';
const SESSION_ID = '6a2adb9e-2396-4c96-bbb7-71a38efc3041';
const REQUEST_ID = 'ea76d0e5-674f-4ef8-831d-35d12376ac75';
const env = { SUPABASE_URL: 'https://amyo-test.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_admin_test_not_a_real_credential', ALLOWED_ORIGIN: 'https://amyoconstruction.com', VERCEL: '1' };
const user = { id: USER_ID, email: ADMIN_EMAIL, email_confirmed_at: '2026-10-15T09:00:00Z', is_anonymous: false };
const item = { request_id: REQUEST_ID, status: 'new', admin_notes: '', updated_at: '2026-10-15T09:30:00.123456+00:00', name: 'Synthetic Client', phone: '+63 917 000 1234', request_fingerprint: 'must-not-leak', future_private_column: 'must-not-leak' };
function jwt(overrides = {}) {
  return `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: USER_ID, session_id: SESSION_ID, role: 'authenticated', exp: NOW / 1000 + 3600, ...overrides })).toString('base64url')}.synthetic_signature`;
}
const tokens = () => ({ access_token: jwt(), refresh_token: 'synthetic_refresh_token' });
const sessionCookies = (access = jwt(), refresh = 'synthetic_refresh_token') => `__Host-amyo_access=${access}; __Host-amyo_refresh=${refresh}`;
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fakeUpstream(override) {
  const calls = [];
  const usedCodes = new Set();
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const call = { path: parsed.pathname + parsed.search, options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const custom = await override?.(call, calls);
    if (custom !== undefined) return custom;
    if (call.path === '/rest/v1/rpc/admin_rate_limit') return response({ allowed: true });
    if (call.path === '/rest/v1/rpc/admin_session_active') return response({ active: true, expiresAt: new Date(NOW + 7200000).toISOString() });
    if (call.path.startsWith('/auth/v1/otp?')) return response({});
    if (call.path === '/auth/v1/token?grant_type=pkce') {
      if (usedCodes.has(call.body.auth_code)) return response({}, 400);
      usedCodes.add(call.body.auth_code);
      return response(tokens());
    }
    if (call.path.startsWith('/auth/v1/token?')) return response(tokens());
    if (call.path === '/auth/v1/user') return response(user);
    if (call.path === '/rest/v1/rpc/admin_revoke_session') return response({ ok: true });
    if (call.path === '/auth/v1/logout?scope=local') return response({}, 204);
    if (call.path === '/rest/v1/rpc/admin_list_inquiries') return response({ items: [item], total: 1, page: call.body.p_page, pageSize: 25 });
    if (call.path === '/rest/v1/rpc/admin_update_inquiry') return response({ status: 'updated', item: { ...item, status: call.body.p_status, admin_notes: call.body.p_notes } });
    throw new Error(`Unexpected test request ${call.path}`);
  };
  return { calls, fetchImpl };
}

async function invoke({ action = 'session', method = 'GET', body, cookies = '', headers = {}, environment = env, upstream = fakeUpstream(), now = NOW, query = '' } = {}) {
  const req = { method, url: `/api/admin?action=${action}${query}`, body, headers: { host: 'amyoconstruction.com', origin: env.ALLOWED_ORIGIN, 'content-type': 'application/json', cookie: cookies, 'x-vercel-forwarded-for': '203.0.113.12', ...headers }, socket: { remoteAddress: '127.0.0.1' } };
  const res = {
    headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    getHeader(key) { return this.headers[key.toLowerCase()]; }, end(value) { this.body = JSON.parse(value); },
  };
  await createAdminHandler({ env: environment, fetchImpl: upstream.fetchImpl, now: () => now })(req, res);
  return res;
}
function cookieFrom(res, name) { return (res.headers['set-cookie'] || []).find((entry) => entry.startsWith(`${name}=`))?.split(';')[0]; }

test('all protected reads require authentication and no configuration is exposed', async () => {
  const upstream = fakeUpstream();
  const absent = await invoke({ upstream });
  assert.equal(absent.statusCode, 401);
  assert.equal(upstream.calls.length, 0);
  assert.match(absent.headers['cache-control'], /no-store/);
  assert.equal((await invoke({ environment: {} })).statusCode, 503);
  assert.equal((await invoke({ action: 'inquiries' })).statusCode, 401);
});

test('mutations require the exact origin and host with no cross-origin permission', async () => {
  for (const headers of [{ origin: '' }, { origin: 'https://evil.example' }, { host: 'evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    const upstream = fakeUpstream();
    const result = await invoke({ action: 'login', method: 'POST', body: { email: ADMIN_EMAIL, password: 'example' }, headers, upstream });
    assert.equal(result.statusCode, 403);
    assert.equal(upstream.calls.length, 0);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
});

test('only the exact normalized AMYO account may request a link or password login', async () => {
  for (const action of ['send-link', 'login']) {
    const upstream = fakeUpstream();
    const result = await invoke({ action, method: 'POST', body: action === 'login' ? { email: 'someone@example.com', password: 'example' } : { email: 'someone@example.com' }, upstream });
    assert.equal(result.statusCode, 403);
    assert.equal(upstream.calls.length, 0);
  }
});

test('send-link builds PKCE, fixed callback and server-only short-lived verifier', async () => {
  const upstream = fakeUpstream();
  const result = await invoke({ action: 'send-link', method: 'POST', body: { email: 'Amyoconstruction@gmail.com' }, upstream });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: true });
  const sent = upstream.calls.find((call) => call.path.startsWith('/auth/v1/otp?'));
  assert.equal(new URL(`https://x${sent.path}`).searchParams.get('redirect_to'), 'https://amyoconstruction.com/admin/');
  assert.equal(sent.body.email, ADMIN_EMAIL);
  assert.equal(sent.body.create_user, true);
  assert.equal(sent.body.code_challenge_method, 's256');
  assert.equal(sent.options.headers.Authorization, undefined);
  const saved = result.headers['set-cookie'][0];
  assert.match(saved, /HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
  assert.doesNotMatch(JSON.stringify(result.body), /verifier|challenge|token/);
  const exchange = await invoke({ action: 'exchange-code', method: 'POST', body: { code: 'synthetic_authorization_code' }, cookies: cookieFrom(result, '__Host-amyo_pkce'), upstream });
  assert.equal(exchange.statusCode, 200);
  const exchanged = upstream.calls.find((call) => call.path.endsWith('grant_type=pkce'));
  assert.equal(createHash('sha256').update(exchanged.body.code_verifier).digest('base64url'), sent.body.code_challenge);
});

test('PKCE missing, tampered and expired browser state cannot exchange a code', async () => {
  const upstream = fakeUpstream();
  const link = await invoke({ action: 'send-link', method: 'POST', body: { email: ADMIN_EMAIL }, upstream });
  const state = cookieFrom(link, '__Host-amyo_pkce');
  for (const [cookies, now] of [['', NOW], [`${state}tamper`, NOW], [state, NOW + 601000]]) {
    const before = upstream.calls.length;
    const result = await invoke({ action: 'exchange-code', method: 'POST', body: { code: 'synthetic_code' }, cookies, now, upstream });
    assert.equal(result.statusCode, 401);
    assert.equal(result.body.code, 'LINK_EXPIRED');
    assert.equal(upstream.calls.length, before);
  }
});

test('PKCE replay and invalid authorization codes never establish a new session', async () => {
  const upstream = fakeUpstream((call) => call.body?.auth_code === 'invalid_code' ? response({}, 400) : undefined);
  const link = await invoke({ action: 'send-link', method: 'POST', body: { email: ADMIN_EMAIL }, upstream });
  const cookies = cookieFrom(link, '__Host-amyo_pkce');
  const options = { action: 'exchange-code', method: 'POST', cookies, upstream };
  assert.equal((await invoke({ ...options, body: { code: 'invalid_code' } })).statusCode, 401);
  assert.equal((await invoke({ ...options, body: { code: 'once_only_code' } })).statusCode, 200);
  assert.equal((await invoke({ ...options, body: { code: 'once_only_code' } })).statusCode, 401);
});

test('password login checks remote verified identity and returns only secure cookie credentials', async () => {
  const upstream = fakeUpstream();
  const result = await invoke({ action: 'login', method: 'POST', body: { email: ADMIN_EMAIL, password: 'a private test password' }, upstream });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: true, user: { email: ADMIN_EMAIL } });
  assert.equal(result.headers['set-cookie'].length, 2);
  for (const value of result.headers['set-cookie']) assert.match(value, /Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=7200$/);
  assert.ok(upstream.calls.some((call) => call.path === '/auth/v1/user' && call.options.headers.Authorization === `Bearer ${jwt()}`));
  assert.ok(upstream.calls.some((call) => call.path === '/rest/v1/rpc/admin_session_active'));
  assert.doesNotMatch(JSON.stringify(result.body), /access_token|refresh_token|private test|synthetic_signature/);
});

test('metadata cannot substitute for the exact verified account email', async () => {
  for (const candidate of [{ ...user, email: 'attacker@example.com', user_metadata: { email: ADMIN_EMAIL } }, { ...user, email_confirmed_at: null }, { ...user, is_anonymous: true }]) {
    const upstream = fakeUpstream((call) => call.path === '/auth/v1/user' ? response(candidate) : undefined);
    assert.equal((await invoke({ cookies: sessionCookies(), upstream })).statusCode, 401);
    assert.ok(!upstream.calls.some((call) => call.path.includes('admin_list')));
  }
});

test('revoked or eight-hour-expired server sessions cannot read private enquiries', async () => {
  for (const state of [{ active: false }, { active: true, expiresAt: new Date(NOW - 1).toISOString() }]) {
    const upstream = fakeUpstream((call) => call.path === '/rest/v1/rpc/admin_session_active' ? response(state) : undefined);
    const result = await invoke({ action: 'inquiries', cookies: sessionCookies(), upstream });
    assert.equal(result.statusCode, 401);
    assert.ok(!upstream.calls.some((call) => call.path.includes('admin_list')));
  }
});

test('expired access refreshes only a live matching session and never extends its absolute lifetime', async () => {
  const oldToken = jwt({ exp: NOW / 1000 - 10 });
  const upstream = fakeUpstream((call) => call.path === '/auth/v1/user' && call.options.headers.Authorization === `Bearer ${oldToken}` ? response({}, 401) : undefined);
  const result = await invoke({ cookies: sessionCookies(oldToken), upstream });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { authenticated: true, user: { email: ADMIN_EMAIL } });
  assert.match(result.headers['set-cookie'][0], /Max-Age=7200$/);
  assert.ok(upstream.calls.some((call) => call.path.endsWith('grant_type=refresh_token')));
  assert.equal(upstream.calls.filter((call) => call.path === '/auth/v1/user').length, 2);
  const mismatched = fakeUpstream((call) => {
    if (call.path === '/auth/v1/user' && call.options.headers.Authorization === `Bearer ${oldToken}`) return response({}, 401);
    if (call.path.endsWith('grant_type=refresh_token')) return response({ ...tokens(), access_token: jwt({ session_id: REQUEST_ID }) });
  });
  assert.equal((await invoke({ cookies: sessionCookies(oldToken), upstream: mismatched })).statusCode, 401);
});

test('revoked sessions are not sent to the refresh endpoint', async () => {
  const upstream = fakeUpstream((call) => {
    if (call.path === '/auth/v1/user') return response({}, 401);
    if (call.path === '/rest/v1/rpc/admin_session_active') return response({ active: false });
  });
  assert.equal((await invoke({ cookies: sessionCookies(), upstream })).statusCode, 401);
  assert.ok(!upstream.calls.some((call) => call.path.includes('grant_type=refresh_token')));
});

test('rate-limit rejection stops link delivery and login attempts before Auth', async () => {
  for (const action of ['send-link', 'login']) {
    const upstream = fakeUpstream((call) => call.path === '/rest/v1/rpc/admin_rate_limit' ? response({ allowed: false, retryAfter: 60 }) : undefined);
    const result = await invoke({ action, method: 'POST', body: action === 'login' ? { email: ADMIN_EMAIL, password: 'test' } : { email: ADMIN_EMAIL }, upstream });
    assert.equal(result.statusCode, 429);
    assert.equal(result.headers['retry-after'], '60');
    assert.ok(upstream.calls.every((call) => call.path.startsWith('/rest/')));
    assert.match(upstream.calls[0].body.p_client_hash, /^[a-f0-9]{64}$/);
  }
});

test('list filters are bounded and response fields exclude internal and future columns', async () => {
  const upstream = fakeUpstream();
  const result = await invoke({ action: 'inquiries', cookies: sessionCookies(), query: '&page=2&status=new&q=Kitchen', upstream });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.page, 2);
  assert.equal(result.body.pageSize, 25);
  assert.equal(result.body.items[0].request_fingerprint, undefined);
  assert.equal(result.body.items[0].future_private_column, undefined);
  assert.deepEqual(upstream.calls.at(-1).body, { p_page: 2, p_status: 'new', p_q: 'Kitchen' });
  for (const query of ['&page=0', '&page=10001', '&status=deleted', `&q=${'a'.repeat(121)}`]) assert.equal((await invoke({ action: 'inquiries', cookies: sessionCookies(), query })).statusCode, 400);
});

test('status/notes update passes precise version and returns safe conflict item without overwriting', async () => {
  const body = { requestId: REQUEST_ID, status: 'contacted', notes: 'Called client.', updatedAt: item.updated_at };
  const upstream = fakeUpstream();
  const saved = await invoke({ action: 'inquiry', method: 'PATCH', body, cookies: sessionCookies(), upstream });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.item.admin_notes, 'Called client.');
  assert.equal(upstream.calls.at(-1).body.p_updated_at, item.updated_at);
  const conflict = fakeUpstream((call) => call.path.includes('admin_update_inquiry') ? response({ status: 'conflict', item }) : undefined);
  const result = await invoke({ action: 'inquiry', method: 'PATCH', body, cookies: sessionCookies(), upstream: conflict });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, 'CONFLICT');
  assert.equal(result.body.item.status, 'new');
  assert.equal(result.body.item.future_private_column, undefined);
  for (const changes of [{ status: 'deleted' }, { notes: 'x'.repeat(4001) }, { updatedAt: 'yesterday' }, { email: 'extra@example.com' }]) assert.equal((await invoke({ action: 'inquiry', method: 'PATCH', body: { ...body, ...changes }, cookies: sessionCookies() })).statusCode, 400);
});

test('logout revokes the application session before clearing cookies even if Auth logout fails', async () => {
  const upstream = fakeUpstream((call) => call.path.includes('/auth/v1/logout') ? response({}, 500) : undefined);
  const result = await invoke({ action: 'logout', method: 'POST', cookies: sessionCookies(), upstream });
  assert.equal(result.statusCode, 200);
  assert.ok(upstream.calls.findIndex((call) => call.path.includes('admin_revoke_session')) < upstream.calls.findIndex((call) => call.path.includes('/auth/v1/logout')));
  assert.ok(result.headers['set-cookie'].every((value) => value.includes('Max-Age=0')));
});

test('setting a password requires a valid session and sends it only to authenticated Auth user endpoint', async () => {
  assert.equal((await invoke({ action: 'set-password', method: 'POST', body: { password: 'new strong passphrase' } })).statusCode, 401);
  const upstream = fakeUpstream();
  const result = await invoke({ action: 'set-password', method: 'POST', body: { password: 'new strong passphrase' }, cookies: sessionCookies(), upstream });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: true });
  const sent = upstream.calls.find((call) => call.path === '/auth/v1/user' && call.options.method === 'PUT');
  assert.equal(sent.options.headers.Authorization, `Bearer ${jwt()}`);
  assert.deepEqual(sent.body, { password: 'new strong passphrase' });
  assert.equal((await invoke({ action: 'set-password', method: 'POST', body: { password: 'short' }, cookies: sessionCookies() })).statusCode, 400);
});

test('legacy service key headers work, but never replace the authenticated user token', async () => {
  const key = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"role":"service_role"}').toString('base64url')}.signature`;
  const upstream = fakeUpstream();
  assert.equal((await invoke({ cookies: sessionCookies(), environment: { ...env, SUPABASE_SECRET_KEY: key }, upstream })).statusCode, 200);
  assert.equal(upstream.calls[0].options.headers.Authorization, `Bearer ${jwt()}`);
  assert.equal(upstream.calls[1].options.headers.Authorization, `Bearer ${key}`);
});

test('oversized requests, unknown actions and upstream failures are safe', async () => {
  assert.equal((await invoke({ action: 'send-link', method: 'POST', body: { email: 'x'.repeat(17000) } })).statusCode, 413);
  assert.equal((await invoke({ action: 'verify-code', method: 'POST', body: {} })).statusCode, 404);
  assert.equal((await invoke({ action: 'login', method: 'GET' })).statusCode, 405);
  const upstream = fakeUpstream(() => { throw new Error(`private details ${env.SUPABASE_SECRET_KEY}`); });
  const result = await invoke({ cookies: sessionCookies(), upstream });
  assert.equal(result.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(result.body), /sb_secret|private details/);
  assert.match(result.headers['cache-control'], /no-store/);
});
