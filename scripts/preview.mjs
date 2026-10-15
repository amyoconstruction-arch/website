import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../api/inquiries.js';
import { createAdminHandler } from '../api/admin.js';

const STATIC_ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function plain(req, res, status, message, headers = {}) {
  const body = `${message}\n`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createPreviewServer({ directory = STATIC_ROOT, apiHandler = createHandler({ env: {} }), adminHandler = createAdminHandler({ env: {} }) } = {}) {
  const root = path.resolve(directory);
  return createServer(async (req, res) => {
    try {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      } catch {
        return plain(req, res, 400, 'Invalid URL.');
      }
      if (/[\0\\:]/.test(pathname)) return plain(req, res, 400, 'Invalid path.');
      if (pathname === '/api/inquiries') return await apiHandler(req, res);
      if (pathname === '/api/admin') return await adminHandler(req, res);
      if (!['GET', 'HEAD'].includes(req.method)) return plain(req, res, 405, 'Method not allowed.', { Allow: 'GET, HEAD' });

      let file = path.resolve(root, `.${pathname}`);
      if (!inside(root, file)) return plain(req, res, 403, 'Path is outside the website.');
      let information = await stat(file);
      if (information.isDirectory()) {
        file = path.join(file, 'index.html');
        information = await stat(file);
      }
      if (!information.isFile()) return plain(req, res, 404, 'File not found.');
      // Resolve links too: a symlink inside dist must not expose files outside it.
      const [actualRoot, actualFile] = await Promise.all([realpath(root), realpath(file)]);
      if (!inside(actualRoot, actualFile)) return plain(req, res, 403, 'Path is outside the website.');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': information.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(actualFile);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      return plain(req, res, ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500, ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'File not found.' : 'Unable to load this file.');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT === undefined ? 4173 : Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('PORT must be an integer from 0 to 65535.');
    process.exitCode = 1;
  } else {
    const enableEnquiries = process.env.PREVIEW_ENABLE_INQUIRIES === 'true';
    const environment = enableEnquiries ? process.env : {};
    const server = createPreviewServer({ apiHandler: createHandler({ env: environment }), adminHandler: createAdminHandler({ env: environment }) });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.on('error', (error) => {
      console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT to another value and try again.` : `Preview could not start (${error.code || 'unknown error'}).`);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`AMYO preview: http://127.0.0.1:${server.address().port}`);
      console.log(enableEnquiries ? 'Enquiry API enabled explicitly using local environment settings.' : 'Preview uses the email fallback; no database credentials are loaded.');
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
  }
}
