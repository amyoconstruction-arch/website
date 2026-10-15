import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';

const MAX_BODY_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = new Set(['service', 'propertyType', 'location', 'timeline', 'budget', 'description', 'name', 'email', 'phone', 'consent', 'website', 'requestId']);

class RequestError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    Object.assign(this, { status, code, fields });
  }
}

function header(req, name) {
  const value = req.headers?.[name];
  return typeof value === 'string' ? value : '';
}

function originValue(value, allowLocal = false) {
  try {
    const url = new URL(value);
    const local = allowLocal && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function configuration(env) {
  const origin = originValue(env.ALLOWED_ORIGIN, env.NODE_ENV !== 'production');
  let url;
  try {
    url = new URL(env.SUPABASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  } catch {
    return null;
  }
  const key = env.SUPABASE_SECRET_KEY?.trim();
  if (!key || !origin) return null;
  // New opaque keys belong only on apikey. Legacy service_role JWTs also
  // require Authorization; reject an accidentally supplied anon JWT locally.
  let legacy = false;
  if (!/^sb_secret_[A-Za-z0-9_-]{16,}$/.test(key)) {
    try {
      const segments = key.split('.');
      if (segments.length !== 3 || segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
      if (JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')).role !== 'service_role') return null;
      legacy = true;
    } catch {
      return null;
    }
  }
  const origins = new Set([origin]);
  // Never trust an arbitrary Host header or all vercel.app domains.
  if (env.ALLOW_VERCEL_PREVIEWS === 'true' && env.VERCEL === '1' && env.VERCEL_ENV === 'preview') {
    const preview = env.VERCEL_URL;
    if (typeof preview === 'string' && /^[a-z0-9-]+\.vercel\.app$/i.test(preview)) origins.add(`https://${preview.toLowerCase()}`);
  }
  return { url: url.origin, key, legacy, origins };
}

async function readBody(req) {
  const declared = header(req, 'content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new RequestError(413, 'TOO_LARGE', 'Please shorten your enquiry and try again.');
  }
  let body = req.body;
  if (body === undefined) {
    const parts = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) throw new RequestError(413, 'TOO_LARGE', 'Please shorten your enquiry and try again.');
      parts.push(buffer);
    }
    body = Buffer.concat(parts);
  }
  try {
    const serialized = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (!serialized || Buffer.byteLength(serialized) > MAX_BODY_BYTES) {
      throw new RequestError(413, 'TOO_LARGE', 'Please shorten your enquiry and try again.');
    }
    return JSON.parse(serialized.toString());
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'INVALID_JSON', 'Please send a valid enquiry form.');
  }
}

export function validateInquiry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RequestError(400, 'VALIDATION_ERROR', 'Please complete the enquiry form.');
  }
  const errors = {};
  if (Object.keys(input).some((key) => !FIELDS.has(key))) errors.form = 'Unexpected form fields.';
  const text = (key, min, max, optional = false) => {
    if (optional && (input[key] === undefined || input[key] === '')) return '';
    if (typeof input[key] !== 'string') {
      errors[key] = `Please enter ${key}.`;
      return '';
    }
    const value = input[key].trim().normalize('NFC');
    if (value.length < min || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
      errors[key] = `${key} must contain ${min}-${max} characters.`;
    }
    return value;
  };
  const payload = {
    service: text('service', 2, 100),
    propertyType: text('propertyType', 2, 80),
    location: text('location', 2, 160),
    timeline: text('timeline', 2, 100),
    budget: text('budget', 0, 100, true),
    description: text('description', 10, 4000),
    name: text('name', 2, 120),
    email: text('email', 3, 254).toLowerCase(),
    phone: text('phone', 7, 30),
    consent: input.consent === true,
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) errors.email = 'Please enter a valid email address.';
  if (!/^[+\d\s().-]+$/.test(payload.phone) || !/^\d{7,15}$/.test(payload.phone.replace(/\D/g, ''))) errors.phone = 'Please enter a valid phone number.';
  if (input.consent !== true) errors.consent = 'Please agree to being contacted about this enquiry.';
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) errors.requestId = 'Please refresh the form and try again.';
  if (input.website !== undefined && (typeof input.website !== 'string' || input.website.length > 2000)) errors.website = 'Invalid form field.';
  if (Object.keys(errors).length) throw new RequestError(400, 'VALIDATION_ERROR', 'Please check your enquiry details.', errors);
  return { payload, requestId: input.requestId.toLowerCase() };
}

function clientHash(req, env, secret) {
  // Vercel overwrites forwarded client-IP headers. Outside Vercel, only trust
  // the socket, so a caller cannot pick a new rate-limit key via a header.
  const forwarded = env.VERCEL === '1' ? (header(req, 'x-vercel-forwarded-for') || header(req, 'x-forwarded-for')).split(',')[0].trim() : '';
  let address = isIP(forwarded) ? forwarded : req.socket?.remoteAddress;
  if (address?.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
  if (!isIP(address || '')) address = 'unknown';
  return createHmac('sha256', secret).update(`amyo-inquiry-ip-v1:${address}`).digest('hex');
}

function reply(res, status, value, extras = {}) {
  res.statusCode = status;
  for (const [name, content] of Object.entries({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extras,
  })) res.setHeader(name, content);
  res.end(JSON.stringify(value));
}

export function createHandler({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async function handler(req, res) {
    const config = configuration(env);
    if (req.method === 'GET') return reply(res, 200, { available: Boolean(config) });
    if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Use the enquiry form to submit your request.' }, { Allow: 'GET, POST' });
    if (!config) return reply(res, 503, { ok: false, code: 'UNAVAILABLE', error: 'Online enquiries are unavailable. Please email Amyoconstruction@gmail.com.' });
    try {
      const origin = originValue(header(req, 'origin'), env.NODE_ENV !== 'production');
      const requestHost = header(req, 'host').toLowerCase();
      if (!origin || !config.origins.has(origin) || new URL(origin).host !== requestHost) {
        throw new RequestError(403, 'INVALID_ORIGIN', 'Please submit the form from the AMYO website.');
      }
      if (!/^application\/json(?:\s*;|$)/i.test(header(req, 'content-type')) || (header(req, 'content-encoding') && header(req, 'content-encoding') !== 'identity')) {
        throw new RequestError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Please use the enquiry form to send your request.');
      }
      const body = await readBody(req);
      // Ignore the hidden bot field without writing a record or returning any
      // information about the database. Legitimate forms leave it empty.
      if (body && typeof body.website === 'string' && body.website.trim()) return reply(res, 200, { ok: true });
      const { payload, requestId } = validateInquiry(body);
      const headers = { 'Content-Type': 'application/json', apikey: config.key };
      if (config.legacy) headers.Authorization = `Bearer ${config.key}`;
      const upstream = await fetchImpl(`${config.url}/rest/v1/rpc/submit_inquiry`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_request_id: requestId,
          p_payload: payload,
          p_fingerprint: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
          p_client_hash: clientHash(req, env, config.key),
        }),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
      if (!upstream.ok) throw new Error('Storage unavailable');
      const result = await upstream.json();
      if (result?.status === 'rate_limited') {
        const retryAfter = Math.min(1800, Math.max(1, Number(result.retryAfter) || 1800));
        return reply(res, 429, { ok: false, code: 'RATE_LIMITED', error: 'Too many enquiries were sent recently. Please try again later or email Amyoconstruction@gmail.com.' }, { 'Retry-After': String(Math.ceil(retryAfter)) });
      }
      if (result?.status === 'conflict') throw new RequestError(409, 'REQUEST_CONFLICT', 'This enquiry reference was already used. Start a new enquiry to send different details.');
      if (!['created', 'duplicate'].includes(result?.status)) throw new Error('Unexpected storage response');
      return reply(res, result.status === 'created' ? 201 : 200, { ok: true, requestId });
    } catch (error) {
      if (error instanceof RequestError) {
        return reply(res, error.status, { ok: false, code: error.code, error: error.message, ...(error.fields ? { fields: error.fields } : {}) });
      }
      // Do not disclose database errors, credentials, submitted personal data,
      // or raw upstream responses to visitors or application logs.
      return reply(res, 503, { ok: false, code: 'UNAVAILABLE', error: 'We could not confirm your enquiry was saved. Please retry with the same form or email Amyoconstruction@gmail.com.' });
    }
  };
}

export default createHandler();
