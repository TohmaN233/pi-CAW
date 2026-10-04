import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const web = new URL('../web/', import.meta.url);
export async function openWorkbench(service) {
  const token = randomBytes(32).toString('hex');
  let origin;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
    try {
      if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin) return send(403, { error: 'Workbench origin mismatch' });
      const path = new URL(request.url, origin).pathname;
      if (path === '/api' && request.method === 'POST') {
        const provided = Buffer.from(String(request.headers.authorization ?? ''));
        const expected = Buffer.from(`Bearer ${token}`);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return send(403, { error: 'Workbench authorization required' });
        if (!String(request.headers['content-type']).startsWith('application/json')) return send(415, { error: 'JSON request required' });
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 72 * 1024 * 1024) return send(413, { error: 'Request exceeds package limit' }); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await service.call(body.operation, body.args ?? {}, { human: true });
        return send(200, { result });
      }
      const files = { '/': ['index.html', 'text/html'], '/workflows': ['index.html', 'text/html'],
        '/workflows.js': ['workflows.js', 'text/javascript'], '/workflows.css': ['workflows.css', 'text/css'],
        '/i18n.js': ['i18n.js', 'text/javascript'] };
      if (request.method !== 'GET' || !files[path]) return send(404, { error: 'Not found' });
      const [name, type] = files[path];
      response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); response.end(await readFile(new URL(name, web)));
    } catch (error) { send(error.code === 'REVISION_CONFLICT' ? 409 : 400, { error: error.message, code: error.code ?? 'PI_CAW_WORKBENCH', details: error.details ?? error.validation ?? error.issues ?? null }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { url: `${origin}/#${token}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
