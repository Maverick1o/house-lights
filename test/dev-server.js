// Local test server: serves public/ and the real API (in-memory store, fake
// LIFX accounts). Used to test the whole app in a browser before deploying.
//   node test/dev-server.js   →  http://localhost:8787

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/server.js';
import { createMemoryStore } from '../lib/store.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 8787);

const strip = (id, label, count, group, hue) => ({
  id, label, power: 'on', brightness: 0.8, connected: true,
  color: { hue, saturation: 1, kelvin: 3500 },
  zones: { count, zones: Array.from({ length: count }, (_, zone) => ({ zone, hue, saturation: 1, kelvin: 3500, brightness: 0.8 })) },
  group, location: { id: 'loc', name: 'Home' },
  product: { name: 'LIFX Permanent Outdoor US', capabilities: { has_color: true, has_multizone: true } },
});
const ACCOUNTS = {
  'tok-home': [
    strip('h1', 'Front South', 15, { id: 'g-holiday', name: 'Holiday' }, 0),
    strip('h2', 'Garage Eave', 30, { id: 'g-holiday', name: 'Holiday' }, 120),
  ],
  'tok-parents': [strip('p1', 'Roofline', 40, { id: 'g-parents', name: 'Christmas Lights' }, 225)],
};
export const lifxLog = [];

async function fakeLifx(url, init) {
  const token = init.headers.authorization.replace('Bearer ', '');
  lifxLog.push({ token, method: init.method, url });
  if (!ACCOUNTS[token]) return new Response('{"error":"Invalid token"}', { status: 401 });
  if (init.method === 'GET') return new Response(JSON.stringify(ACCOUNTS[token]), { status: 200 });
  return new Response('{"results":[]}', { status: 207 });
}

const app = createApp({
  store: createMemoryStore(),
  env: { LIFX_TOKEN_HOME: 'tok-home', LIFX_TOKEN_MOM_AND_DAD: 'tok-parents', SETUP_CODE: 'test-code', ALLOW_LOCALHOST: '1' },
  fetchImpl: fakeLifx,
});

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/__lifxlog') { res.end(JSON.stringify(lifxLog)); return; }
  if (url.pathname === '/__fake-passkey.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(await fs.readFile(path.join(root, '..', 'test', 'browser-fake-passkey.js')));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const response = await app(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`House Lights test server on http://localhost:${PORT}`));
