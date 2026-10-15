import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler, validateInquiry } from '../api/inquiries.js';

const env = {
  SUPABASE_URL: 'https://amyo-test.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_example_test_key_never_a_real_credential',
  ALLOWED_ORIGIN: 'https://amyoconstruction.com',
  NODE_ENV: 'production',
  VERCEL: '1',
};

function enquiry(overrides = {}) {
  return {
    service: 'Renovation', propertyType: 'Residential', location: 'Quezon City',
    timeline: 'Within 3 months', budget: 'To be discussed',
    description: 'Please inspect and renovate our kitchen.',
    name: 'Example Client', email: 'client@example.com', phone: '+63 917 000 1234',
    consent: true, website: '', requestId: 'd0480e35-0b6f-4d4a-a790-1f505a376d3e',
    ...overrides,
  };
}

async function invoke({ method = 'POST', body = enquiry(), headers = {}, environment = env, fetchImpl } = {}) {
  const req = {
    method, body,
    headers: { origin: 'https://amyoconstruction.com', host: 'amyoconstruction.com', 'content-type': 'application/json', 'x-vercel-forwarded-for': '203.0.113.1', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
  await createHandler({ env: environment, fetchImpl: fetchImpl || (async () => { throw new Error('Unexpected network request'); }) })(req, res);
  return res;
}

test('GET exposes availability only, and is unavailable without configured secrets', async () => {
  const ready = await invoke({ method: 'GET' });
  assert.deepEqual(ready.body, { available: true });
  const absent = await invoke({ method: 'GET', environment: {} });
  assert.deepEqual(absent.body, { available: false });
  assert.equal(absent.headers['cache-control'], 'no-store');
});

test('POST fails safely when not configured and never requests storage', async () => {
  const result = await invoke({ environment: {} });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'UNAVAILABLE');
  assert.match(result.body.error, /Amyoconstruction@gmail\.com/);
});

test('normalizes valid payload and permits optional budget while requiring phone', () => {
  const result = validateInquiry(enquiry({ name: '  Example Client ', email: 'CLIENT@EXAMPLE.COM', budget: undefined }));
  assert.equal(result.payload.name, 'Example Client');
  assert.equal(result.payload.email, 'client@example.com');
  assert.equal(result.payload.phone, '+63 917 000 1234');
  assert.equal(result.payload.budget, '');
});

test('requires a valid phone for every new public enquiry', async () => {
  for (const phone of [undefined, '', ' ', '123', '+63 abc 1234567890']) {
    const result = await invoke({ body: enquiry({ phone }) });
    assert.equal(result.statusCode, 400);
    assert.ok(result.body.fields.phone);
  }
});

test('rejects missing consent, string consent, malformed identity and invalid fields', async () => {
  for (const body of [enquiry({ consent: false }), enquiry({ consent: 'true' }), enquiry({ email: 'wrong' }), enquiry({ phone: 'abc' }), enquiry({ requestId: 'not-a-uuid' }), enquiry({ description: 'tiny' }), enquiry({ service: 'a'.repeat(101) }), enquiry({ unexpected: 'field' }), []]) {
    const result = await invoke({ body });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, 'VALIDATION_ERROR');
  }
});

test('rejects unsupported content types, oversized bodies and invalid JSON', async () => {
  assert.equal((await invoke({ headers: { 'content-type': 'text/plain' } })).statusCode, 415);
  assert.equal((await invoke({ headers: { 'content-length': '16385' } })).statusCode, 413);
  assert.equal((await invoke({ body: enquiry({ description: 'a'.repeat(17000) }) })).statusCode, 413);
  assert.equal((await invoke({ body: '{invalid' })).body.code, 'INVALID_JSON');
});

test('requires exact configured same origin, rejecting absent or spoofed origins', async () => {
  for (const headers of [{ origin: '' }, { origin: 'https://evil.example' }, { origin: 'https://amyoconstruction.com.evil.example' }, { host: 'evil.example' }, { origin: 'null' }]) {
    const result = await invoke({ headers });
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.code, 'INVALID_ORIGIN');
  }
});

test('preview access is opt-in and restricted to the exact Vercel deployment', async () => {
  const environment = { ...env, ALLOW_VERCEL_PREVIEWS: 'true', VERCEL_ENV: 'preview', VERCEL_URL: 'amyo-a123.vercel.app' };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ status: 'created' }) });
  const allowed = await invoke({ environment, headers: { origin: 'https://amyo-a123.vercel.app', host: 'amyo-a123.vercel.app' }, fetchImpl });
  assert.equal(allowed.statusCode, 201);
  assert.equal((await invoke({ environment, headers: { origin: 'https://another.vercel.app', host: 'another.vercel.app' }, fetchImpl })).statusCode, 403);
  assert.equal((await invoke({ environment: { ...environment, ALLOW_VERCEL_PREVIEWS: 'false' }, headers: { origin: 'https://amyo-a123.vercel.app', host: 'amyo-a123.vercel.app' }, fetchImpl })).statusCode, 403);
});

test('honeypot submissions do not call storage', async () => {
  const result = await invoke({ body: enquiry({ website: 'https://spam.example' }) });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: true });
});

test('new Supabase secret uses apikey only and stores a hash instead of the client IP', async () => {
  let sent;
  const result = await invoke({ fetchImpl: async (url, options) => {
    sent = { url, ...options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ status: 'created' }) };
  } });
  assert.equal(result.statusCode, 201);
  assert.equal(result.body.requestId, enquiry().requestId);
  assert.equal(sent.url, 'https://amyo-test.supabase.co/rest/v1/rpc/submit_inquiry');
  assert.equal(sent.headers.apikey, env.SUPABASE_SECRET_KEY);
  assert.equal(sent.headers.Authorization, undefined);
  assert.match(sent.body.p_client_hash, /^[a-f0-9]{64}$/);
  assert.match(sent.body.p_fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(sent.body).includes('203.0.113.1'));
  assert.equal(sent.body.p_payload.website, undefined);
  assert.equal(sent.redirect, 'error');
});

test('legacy service_role JWT uses both headers, while anon keys are rejected', async () => {
  const jwt = (role) => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.example_signature`;
  const secret = jwt('service_role');
  let authorization;
  const result = await invoke({ environment: { ...env, SUPABASE_SECRET_KEY: secret }, fetchImpl: async (_url, options) => {
    authorization = options.headers.Authorization;
    return { ok: true, json: async () => ({ status: 'created' }) };
  } });
  assert.equal(result.statusCode, 201);
  assert.equal(authorization, `Bearer ${secret}`);
  assert.deepEqual((await invoke({ method: 'GET', environment: { ...env, SUPABASE_SECRET_KEY: jwt('anon') } })).body, { available: false });
});

test('identical retries reuse the same ID/fingerprint and return success without another created result', async () => {
  const stored = new Map();
  let created = 0;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const previous = stored.get(body.p_request_id);
    let status;
    if (previous) status = previous === body.p_fingerprint ? 'duplicate' : 'conflict';
    else { stored.set(body.p_request_id, body.p_fingerprint); created += 1; status = 'created'; }
    return { ok: true, json: async () => ({ status }) };
  };
  const first = await invoke({ fetchImpl });
  const retry = await invoke({ fetchImpl });
  assert.equal(first.statusCode, 201);
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(first.body, retry.body);
  assert.equal(created, 1);
  const conflict = await invoke({ fetchImpl, body: enquiry({ description: 'This is a different project request.' }) });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, 'REQUEST_CONFLICT');
});

test('persistent storage rate-limit result produces 429 with Retry-After', async () => {
  const result = await invoke({ fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'rate_limited', retryAfter: 712 }) }) });
  assert.equal(result.statusCode, 429);
  assert.equal(result.body.code, 'RATE_LIMITED');
  assert.equal(result.headers['retry-after'], '712');
});

test('database rejection, timeout, invalid JSON and unexpected results do not leak upstream errors', async () => {
  const cases = [
    async () => ({ ok: false, text: async () => 'sensitive database failure' }),
    async () => { throw new Error(`secret ${env.SUPABASE_SECRET_KEY}`); },
    async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }),
    async () => ({ ok: true, json: async () => ({ unknown: 'sensitive' }) }),
  ];
  for (const fetchImpl of cases) {
    const result = await invoke({ fetchImpl });
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.code, 'UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result.body), /sensitive|sb_secret|bad JSON/);
  }
});

test('unsupported methods cannot read stored enquiries', async () => {
  for (const method of ['PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    const result = await invoke({ method });
    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.allow, 'GET, POST');
  }
});

test('streamed JSON is accepted and an oversized stream is rejected before storage', async () => {
  for (const [raw, expected] of [[JSON.stringify(enquiry()), 201], [JSON.stringify(enquiry({ description: 'x'.repeat(17000) })), 413]]) {
    const req = Readable.from([Buffer.from(raw)]);
    req.method = 'POST';
    req.headers = { origin: env.ALLOWED_ORIGIN, host: 'amyoconstruction.com', 'content-type': 'application/json' };
    const res = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
    let storageCalls = 0;
    await createHandler({ env, fetchImpl: async () => {
      storageCalls += 1;
      return { ok: true, json: async () => ({ status: 'created' }) };
    } })(req, res);
    assert.equal(res.statusCode, expected);
    assert.equal(storageCalls, expected === 201 ? 1 : 0);
  }
});

test('non-Vercel callers cannot change their rate-limit identity with forwarded headers', async () => {
  const hashes = [];
  const fetchImpl = async (_url, options) => {
    hashes.push(JSON.parse(options.body).p_client_hash);
    return { ok: true, json: async () => ({ status: 'created' }) };
  };
  for (const address of ['203.0.113.1', '198.51.100.20']) {
    await invoke({ environment: { ...env, VERCEL: undefined }, headers: { 'x-vercel-forwarded-for': address, 'x-forwarded-for': address }, fetchImpl });
  }
  assert.equal(hashes[0], hashes[1]);
});
