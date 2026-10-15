import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const ADMIN_EMAIL = 'amyoconstruction@gmail.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['new', 'contacted', 'quoted', 'won', 'closed']);
const ACCESS = '__Host-amyo_access';
const REFRESH = '__Host-amyo_refresh';
const PKCE = '__Host-amyo_pkce';
const MAX_BYTES = 16384;
const MAX_SESSION_SECONDS = 8 * 60 * 60;
const ITEM_FIELDS = ['request_id', 'created_at', 'service', 'property_type', 'location', 'timeline', 'budget', 'description', 'name', 'email', 'phone', 'consent', 'consent_at', 'consent_version', 'status', 'admin_notes', 'updated_at', 'updated_by'];
function publicItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid enquiry');
  return Object.fromEntries(ITEM_FIELDS.filter((key) => Object.hasOwn(item, key)).map((key) => [key, item[key]]));
}

class AdminError extends Error {
  constructor(status, code, message, extra = {}) { super(message); Object.assign(this, { status, code, extra }); }
}
const denied = () => new AdminError(401, 'UNAUTHENTICATED', 'Please sign in to the AMYO administrator account.');
const invalid = (message = 'Please check the supplied details.') => new AdminError(400, 'VALIDATION_ERROR', message);
const header = (req, name) => typeof req.headers?.[name] === 'string' ? req.headers[name] : '';

function configFor(env) {
  try {
    const url = new URL(env.SUPABASE_URL);
    const origin = new URL(env.ALLOWED_ORIGIN);
    if ([url, origin].some((value) => value.protocol !== 'https:' || value.username || value.password || value.pathname !== '/' || value.search || value.hash)) return null;
    const key = env.SUPABASE_SECRET_KEY?.trim();
    if (!key) return null;
    let legacy = false;
    if (!/^sb_secret_[A-Za-z0-9_-]{16,}$/.test(key)) {
      const parts = key.split('.');
      if (parts.length !== 3 || parts.some((value) => !/^[A-Za-z0-9_-]+$/.test(value)) || JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role !== 'service_role') return null;
      legacy = true;
    }
    return { url: url.origin, origin: origin.origin, host: origin.host, key, legacy };
  } catch { return null; }
}

function reply(res, status, value, extras = {}) {
  res.statusCode = status;
  for (const [key, content] of Object.entries({
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private',
    'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...extras,
  })) res.setHeader(key, content);
  res.end(JSON.stringify(value));
}

function cookie(res, name, value, seconds, sameSite = 'Strict') {
  const existing = res.getHeader?.('Set-Cookie') || [];
  const cookies = Array.isArray(existing) ? existing : [existing];
  res.setHeader('Set-Cookie', [...cookies, `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${Math.max(0, Math.floor(seconds))}`]);
}
function clearSession(res) { cookie(res, ACCESS, '', 0); cookie(res, REFRESH, '', 0); }
function readCookies(req) {
  const raw = header(req, 'cookie');
  if (raw.length > 24000) throw denied();
  const output = {};
  for (const entry of raw.split(';')) {
    const index = entry.indexOf('=');
    if (index < 0) continue;
    const name = entry.slice(0, index).trim();
    if (![ACCESS, REFRESH, PKCE].includes(name)) continue;
    if (Object.hasOwn(output, name)) throw denied();
    try { output[name] = decodeURIComponent(entry.slice(index + 1)); } catch { throw denied(); }
  }
  return output;
}
function claims(token) {
  try {
    if (typeof token !== 'string' || token.length > 6000) throw denied();
    const parts = token.split('.');
    if (parts.length !== 3) throw denied();
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!UUID.test(value.sub || '') || !UUID.test(value.session_id || '')) throw denied();
    return value;
  } catch { throw denied(); }
}
function signature(value, key) { return createHmac('sha256', key).update(`amyo-admin-pkce-v1:${value}`).digest('base64url'); }
function signedVerifier(verifier, key, now) {
  const value = Buffer.from(JSON.stringify({ verifier, issued: now })).toString('base64url');
  return `${value}.${signature(value, key)}`;
}
function verifierFrom(value, key, now) {
  try {
    const parts = value.split('.');
    if (parts.length !== 2 || parts[1].length !== 43) throw denied();
    const expected = Buffer.from(signature(parts[0], key));
    const received = Buffer.from(parts[1]);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw denied();
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (!Number.isFinite(data.issued) || data.issued > now || now - data.issued > 600000 || !/^[A-Za-z0-9_-]{43}$/.test(data.verifier)) throw denied();
    return data.verifier;
  } catch { throw new AdminError(401, 'LINK_EXPIRED', 'Open a new sign-in link in the same browser that requested it.'); }
}

async function bodyOf(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(header(req, 'content-type')) || (header(req, 'content-encoding') && header(req, 'content-encoding') !== 'identity')) throw new AdminError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the form as JSON.');
  const length = header(req, 'content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new AdminError(413, 'TOO_LARGE', 'The request is too large.');
  let raw = req.body;
  if (raw === undefined) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BYTES) throw new AdminError(413, 'TOO_LARGE', 'The request is too large.');
      chunks.push(bytes);
    }
    raw = Buffer.concat(chunks);
  }
  try {
    const text = typeof raw === 'string' || Buffer.isBuffer(raw) ? raw.toString() : JSON.stringify(raw);
    if (!text || Buffer.byteLength(text) > MAX_BYTES) throw new AdminError(413, 'TOO_LARGE', 'The request is too large.');
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw invalid();
    return value;
  } catch (error) { if (error instanceof AdminError) throw error; throw invalid('Send a valid JSON form.'); }
}
function only(body, keys) { if (Object.keys(body).some((key) => !keys.includes(key))) throw invalid(); }
function restrictedEmail(email) {
  if (typeof email !== 'string' || email.trim().toLowerCase() !== ADMIN_EMAIL) throw new AdminError(403, 'FORBIDDEN', 'Administrator access is restricted to the AMYO account.');
  return ADMIN_EMAIL;
}
function clientHash(req, env, key) {
  const forwarded = env.VERCEL === '1' ? (header(req, 'x-vercel-forwarded-for') || header(req, 'x-forwarded-for')).split(',')[0].trim() : '';
  let ip = isIP(forwarded) ? forwarded : req.socket?.remoteAddress;
  if (ip?.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  if (!isIP(ip || '')) ip = 'unknown';
  return createHmac('sha256', key).update(`amyo-admin-ip-v1:${ip}`).digest('hex');
}

export function createAdminHandler({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  return async function adminHandler(req, res) {
    const config = configFor(env);
    if (!config) return reply(res, 503, { ok: false, code: 'UNAVAILABLE', error: 'Administrator sign-in is unavailable.' });
    try {
      const url = new URL(req.url || '/api/admin', config.origin);
      const action = url.searchParams.get('action') || 'session';
      const methods = { session: 'GET', 'send-link': 'POST', 'exchange-code': 'POST', login: 'POST', logout: 'POST', 'set-password': 'POST', inquiries: 'GET', inquiry: 'PATCH' };
      if (!Object.hasOwn(methods, action)) throw new AdminError(404, 'NOT_FOUND', 'Unknown administrator action.');
      if (req.method !== methods[action]) return reply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed.' }, { Allow: methods[action] });
      if (header(req, 'host').toLowerCase() !== config.host || (req.method !== 'GET' && header(req, 'origin') !== config.origin)) throw new AdminError(403, 'INVALID_ORIGIN', 'Use the AMYO administrator website.');
      if (header(req, 'sec-fetch-site') === 'cross-site') throw new AdminError(403, 'INVALID_ORIGIN', 'Use the AMYO administrator website.');

      async function remote(endpoint, { method = 'POST', body, token, database = false } = {}) {
        const headers = { apikey: config.key, 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        else if (config.legacy) headers.Authorization = `Bearer ${config.key}`;
        const response = await fetchImpl(`${config.url}${endpoint}`, {
          method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(6000), redirect: 'error', cache: 'no-store',
        });
        if (!response.ok) {
          if (database || response.status >= 500) throw new AdminError(503, 'UNAVAILABLE', 'The administrator service is temporarily unavailable.');
          if (response.status === 429) throw new AdminError(429, 'RATE_LIMITED', 'Please wait before trying again.', { retryAfter: 900 });
          throw denied();
        }
        if (response.status === 204) return {};
        return await response.json();
      }
      const rpc = (name, body) => remote(`/rest/v1/rpc/${name}`, { body, database: true });
      async function limit(kind) {
        const result = await rpc('admin_rate_limit', { p_kind: kind, p_client_hash: clientHash(req, env, config.key) });
        if (result?.allowed !== true) throw new AdminError(429, 'RATE_LIMITED', 'Please wait before trying again.', { retryAfter: Math.min(3600, Math.max(1, Number(result?.retryAfter) || 900)) });
      }
      async function sessionRow(userId, sessionId) {
        const result = await rpc('admin_session_active', { p_user_id: userId, p_session_id: sessionId });
        const expires = Date.parse(result?.expiresAt);
        if (result?.active !== true || !Number.isFinite(expires) || expires <= now()) throw denied();
        return Math.min(MAX_SESSION_SECONDS, Math.floor((expires - now()) / 1000));
      }
      async function verifyAccess(access, suppliedUser) {
        // JWT decoding only selects the row to check. Supabase /user validates
        // the actual token before any private data or privilege is granted.
        const user = suppliedUser || await remote('/auth/v1/user', { method: 'GET', token: access });
        const data = claims(access);
        if (!user || user.id !== data.sub || !UUID.test(user.id) || typeof user.email !== 'string'
          || user.email.toLowerCase() !== ADMIN_EMAIL || !Number.isFinite(Date.parse(user.email_confirmed_at))
          || user.is_anonymous === true || data.role !== 'authenticated'
          || !Number.isFinite(data.exp) || data.exp * 1000 <= now()) throw denied();
        const remaining = await sessionRow(user.id, data.session_id);
        return { user: { email: ADMIN_EMAIL }, userId: user.id, sessionId: data.session_id, access, remaining };
      }
      function setTokens(tokens, session) {
        if (typeof tokens.access_token !== 'string' || tokens.access_token.length > 6000 || typeof tokens.refresh_token !== 'string' || tokens.refresh_token.length > 2000) throw denied();
        cookie(res, ACCESS, tokens.access_token, session.remaining);
        cookie(res, REFRESH, tokens.refresh_token, session.remaining);
      }
      async function establish(tokens) {
        const session = await verifyAccess(tokens?.access_token);
        setTokens(tokens, session);
        return session;
      }
      async function authenticate() {
        const cookies = readCookies(req);
        if (!cookies[ACCESS]) throw denied();
        let user;
        try { user = await remote('/auth/v1/user', { method: 'GET', token: cookies[ACCESS] }); }
        catch (error) {
          if (error.status !== 401 || !cookies[REFRESH]) throw error;
          const old = claims(cookies[ACCESS]);
          // Do not refresh a revoked or expired overall session. These claims
          // are not authorization; the refresh token and new /user check are.
          await sessionRow(old.sub, old.session_id);
          const tokens = await remote('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: cookies[REFRESH] } });
          const session = await verifyAccess(tokens?.access_token);
          if (session.userId !== old.sub || session.sessionId !== old.session_id) throw denied();
          setTokens(tokens, session);
          return session;
        }
        return verifyAccess(cookies[ACCESS], user);
      }

      if (action === 'send-link') {
        const body = await bodyOf(req); only(body, ['email']);
        const email = restrictedEmail(body.email);
        await limit('send-link');
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        await remote(`/auth/v1/otp?redirect_to=${encodeURIComponent(`${config.origin}/admin/`)}`, {
          body: { email, create_user: true, code_challenge: challenge, code_challenge_method: 's256' },
        });
        cookie(res, PKCE, signedVerifier(verifier, config.key, now()), 600, 'Lax');
        return reply(res, 200, { ok: true });
      }
      if (action === 'exchange-code') {
        const body = await bodyOf(req); only(body, ['code']);
        const cookies = readCookies(req);
        cookie(res, PKCE, '', 0, 'Lax');
        const verifier = verifierFrom(cookies[PKCE] || '', config.key, now());
        if (typeof body.code !== 'string' || body.code.length < 8 || body.code.length > 2048 || /\s/.test(body.code)) throw invalid('This sign-in link is invalid.');
        await limit('authenticate');
        const tokens = await remote('/auth/v1/token?grant_type=pkce', { body: { auth_code: body.code, code_verifier: verifier } });
        const session = await establish(tokens);
        return reply(res, 200, { ok: true, user: session.user });
      }
      if (action === 'login') {
        const body = await bodyOf(req); only(body, ['email', 'password']);
        const email = restrictedEmail(body.email);
        if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 256) throw invalid('Please enter your password.');
        await limit('authenticate');
        const tokens = await remote('/auth/v1/token?grant_type=password', { body: { email, password: body.password } });
        const session = await establish(tokens);
        return reply(res, 200, { ok: true, user: session.user });
      }
      if (action === 'logout') {
        try {
          const session = await authenticate();
          await rpc('admin_revoke_session', { p_user_id: session.userId, p_session_id: session.sessionId });
          // Application revocation has already succeeded; upstream sign-out is
          // best-effort and cannot make the access JWT usable by this API again.
          try { await remote('/auth/v1/logout?scope=local', { token: session.access }); } catch { /* App session remains revoked. */ }
        } catch (error) { if (error.status !== 401) throw error; }
        finally { clearSession(res); cookie(res, PKCE, '', 0, 'Lax'); }
        return reply(res, 200, { ok: true });
      }
      const session = await authenticate();
      if (action === 'session') return reply(res, 200, { authenticated: true, user: session.user });
      if (action === 'set-password') {
        const body = await bodyOf(req); only(body, ['password']);
        if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128 || /[\u0000-\u001f\u007f]/.test(body.password)) throw invalid('Choose a password with 12–128 characters.');
        await limit('authenticate');
        await remote('/auth/v1/user', { method: 'PUT', token: session.access, body: { password: body.password } });
        return reply(res, 200, { ok: true });
      }
      if (action === 'inquiries') {
        const pageText = url.searchParams.get('page') || '1';
        const status = url.searchParams.get('status') || 'all';
        const q = (url.searchParams.get('q') || '').trim();
        if (!/^\d{1,5}$/.test(pageText) || Number(pageText) < 1 || Number(pageText) > 10000 || (status !== 'all' && !STATUSES.has(status)) || q.length > 120 || /[\u0000-\u001f\u007f]/.test(q)) throw invalid('Please check the search filters.');
        const result = await rpc('admin_list_inquiries', { p_page: Number(pageText), p_status: status, p_q: q });
        if (!Array.isArray(result?.items) || !Number.isFinite(result.total)) throw new Error('Invalid list response');
        return reply(res, 200, { items: result.items.map(publicItem), total: result.total, page: Number(pageText), pageSize: 25 });
      }
      const body = await bodyOf(req); only(body, ['requestId', 'status', 'notes', 'updatedAt']);
      if (typeof body.requestId !== 'string' || !UUID.test(body.requestId) || !STATUSES.has(body.status) || typeof body.notes !== 'string' || body.notes.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.notes)
        || typeof body.updatedAt !== 'string' || body.updatedAt.length > 64 || !/(Z|[+-]\d{2}:\d{2})$/.test(body.updatedAt) || !Number.isFinite(Date.parse(body.updatedAt))) throw invalid('Please check the status and notes.');
      const result = await rpc('admin_update_inquiry', { p_request_id: body.requestId, p_status: body.status, p_notes: body.notes, p_updated_at: body.updatedAt });
      if (result?.status === 'not_found') throw new AdminError(404, 'NOT_FOUND', 'This enquiry could not be found.');
      if (result?.status === 'conflict') throw new AdminError(409, 'CONFLICT', 'This enquiry was changed by another session. Reload the saved version before trying again.', { item: publicItem(result.item) });
      if (result?.status !== 'updated' || !result.item) throw new Error('Invalid update response');
      return reply(res, 200, { item: publicItem(result.item) });
    } catch (error) {
      if (error.status === 401) clearSession(res);
      if (error instanceof AdminError) {
        const headers = error.extra.retryAfter ? { 'Retry-After': String(Math.ceil(error.extra.retryAfter)) } : {};
        return reply(res, error.status, { ok: false, code: error.code, error: error.message, ...error.extra }, headers);
      }
      return reply(res, 503, { ok: false, code: 'UNAVAILABLE', error: 'The administrator service is temporarily unavailable. Please try again.' });
    }
  };
}

export default createAdminHandler();
