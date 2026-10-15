import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPreviewServer } from '../scripts/preview.mjs';

async function visit(server, pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path: pathname, method, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('preview serves only website files with MIME types, HEAD support and safe API fallback', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'amyo-preview-'));
  const directory = path.join(workspace, 'dist');
  await mkdir(directory);
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>AMYO</title>');
  await writeFile(path.join(directory, 'app.js'), 'const preview = true;');
  await writeFile(path.join(workspace, 'private.txt'), 'Do not expose');
  const server = createPreviewServer({ directory });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = await visit(server, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.body, /AMYO/);
    const head = await visit(server, '/app.js', 'HEAD');
    assert.equal(head.status, 200);
    assert.match(head.headers['content-type'], /^text\/javascript/);
    assert.equal(head.body, '');
    assert.equal(Number(head.headers['content-length']), 21);
    assert.equal((await visit(server, '/missing')).status, 404);
    assert.equal((await visit(server, '/app.js', 'POST')).status, 405);
    assert.equal((await visit(server, '/%2e%2e%2fprivate.txt')).status, 403);
    assert.equal((await visit(server, '/..%5cprivate.txt')).status, 400);
    assert.equal((await visit(server, '/app.js%3a%3a$DATA')).status, 400);
    assert.equal((await visit(server, '/%E0%A4%A')).status, 400);
    assert.deepEqual(JSON.parse((await visit(server, '/api/inquiries')).body), { available: false });
    assert.equal((await visit(server, '/api/inquiries', 'POST', '{}')).status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const cleanupTarget = path.resolve(workspace);
    assert.equal(path.dirname(cleanupTarget), path.resolve(tmpdir()));
    assert.ok(path.basename(cleanupTarget).startsWith('amyo-preview-'));
    await rm(cleanupTarget, { recursive: true, force: true });
  }
});
