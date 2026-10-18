#!/usr/bin/env node
// Browser Bridge: MCP server (stdio) + localhost WebSocket hub for the browser extension.
// The first server process owns the port ("hub"). Later ones (other client sessions) join it as clients.

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';

const PORT = Number(process.env.CBB_PORT) || 17333;
const DIR = path.join(os.homedir(), '.browser-bridge');
const TOKEN_FILE = path.join(DIR, 'token');

function loadToken() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('hex') + '\n', { mode: 0o600 });
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}
const TOKEN = loadToken();

if (process.argv.includes('--token')) {
  console.log(TOKEN);
  process.exit(0);
}

const log = (...a) => console.error('[bridge]', ...a); // stdout is reserved for MCP

function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- backend: hub or client ----------

let nextId = 1;
const pending = new Map(); // id -> {res, rej, t}
let ext = null; // hub: the extension socket
let hubWss = null;
let clientWs = null; // client mode: socket to the hub
let mode = null; // 'hub' | 'client'

function track(id, timeoutMs) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('timed out waiting for the browser')); }, timeoutMs);
    pending.set(id, { res, rej, t });
  });
}
function settle(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.t);
  if (msg.error) p.rej(new Error(msg.error));
  else p.res(msg.result);
}

const NOT_CONNECTED = 'The browser extension is not connected. Open the extension settings in Chromium, paste the token (run: node ' + new URL(import.meta.url).pathname + ' --token), and tick "Allow remote control of this browser".';

function startHub() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((_q, s) => { s.writeHead(404); s.end(); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

    srv.on('upgrade', (req, socket, head) => {
      // Refuse web pages: only the extension (chrome-extension://) or a non-browser client (no Origin) may connect.
      const origin = req.headers.origin;
      if (origin && !origin.startsWith('chrome-extension://')) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    });

    wss.on('connection', ws => {
      let role = null;
      const authTimer = setTimeout(() => { if (!role) ws.close(); }, 5000);
      ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (!role) {
          if (msg.auth && safeEq(msg.auth, TOKEN) && (msg.role === 'ext' || msg.role === 'client')) {
            role = msg.role;
            clearTimeout(authTimer);
            if (role === 'ext') {
              if (ext && ext !== ws) { try { ext.close(); } catch (e) {} }
              ext = ws;
              log('extension connected');
            }
            ws.send(JSON.stringify({ authed: true }));
          } else {
            ws.send(JSON.stringify({ authError: true }));
            ws.close();
          }
          return;
        }
        if (msg.ping) return;
        if (role === 'ext') { settle(msg); return; }
        // role === client: forward its request to the extension
        if (msg.method) {
          if (!ext || ext.readyState !== WebSocket.OPEN) { ws.send(JSON.stringify({ id: msg.id, error: NOT_CONNECTED })); return; }
          const id = nextId++;
          track(id, 120000).then(
            result => ws.readyState === 1 && ws.send(JSON.stringify({ id: msg.id, result })),
            err => ws.readyState === 1 && ws.send(JSON.stringify({ id: msg.id, error: err.message })),
          );
          ext.send(JSON.stringify({ id, method: msg.method, params: msg.params }));
        }
      });
      ws.on('close', () => { clearTimeout(authTimer); if (ext === ws) { ext = null; log('extension disconnected'); } });
    });

    srv.once('error', reject);
    srv.listen(PORT, '127.0.0.1', () => { hubWss = wss; mode = 'hub'; log('hub listening on 127.0.0.1:' + PORT); resolve(); });
  });
}

function startClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    const fail = e => reject(e instanceof Error ? e : new Error('hub connection failed'));
    ws.once('error', fail);
    ws.once('open', () => ws.send(JSON.stringify({ auth: TOKEN, role: 'client' })));
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.authed) { clientWs = ws; mode = 'client'; log('joined existing hub'); resolve(); return; }
      if (msg.authError) { fail(new Error('hub rejected token')); return; }
      settle(msg);
    });
    ws.on('close', () => { if (clientWs === ws) { clientWs = null; mode = null; } });
  });
}

async function ensureBackend() {
  if (mode === 'hub' || (mode === 'client' && clientWs && clientWs.readyState === WebSocket.OPEN)) return;
  mode = null;
  try { await startHub(); } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    await startClient();
  }
}

async function call(method, params = {}) {
  await ensureBackend();
  const timeout = method === 'wait_for' ? ((params.timeout_s || 15) + 10) * 1000 : 120000;
  if (mode === 'hub') {
    if (!ext || ext.readyState !== WebSocket.OPEN) throw new Error(NOT_CONNECTED);
    const id = nextId++;
    const p = track(id, timeout);
    ext.send(JSON.stringify({ id, method, params }));
    return p;
  }
  const id = nextId++;
  const p = track(id, timeout);
  clientWs.send(JSON.stringify({ id, method, params }));
  return p;
}

// ---------- MCP tools ----------

const tabId = z.number().int().describe('Tab id from tabs_list or tab_create');
const ref = z.string().optional().describe('Element ref from read_page, e.g. ref_12');
const xy = { x: z.number().optional().describe('X in CSS px (screenshot space)'), y: z.number().optional().describe('Y in CSS px (screenshot space)') };

const TOOLS = {
  status: ['Check the bridge and extension connection.', {}],
  tabs_list: ['List every open tab (id, title, url). Call this first.', {}],
  tab_create: ['Open a new tab, optionally at a URL.', { url: z.string().optional(), active: z.boolean().optional() }],
  tab_close: ['Close a tab.', { tabId }],
  tab_activate: ['Bring a tab to the front (some sites need focus).', { tabId }],
  navigate: ['Go to a URL, or "back", "forward", "reload".', { tabId, url: z.string() }],
  read_page: ['Return interactive elements as "[ref_N] role "name"" lines. Use refs with click/type/form_input. filter "all" also lists headings, paragraphs, images. "query" narrows to matching elements (use it like find).', { tabId, filter: z.enum(['interactive', 'all']).optional(), query: z.string().optional(), max_chars: z.number().optional() }],
  get_text: ['Return the visible text of the page.', { tabId, max_chars: z.number().optional() }],
  screenshot: ['Screenshot of the tab viewport (or the whole page with full_page). Coordinates for click/hover/drag are in this image space.', { tabId, full_page: z.boolean().optional() }],
  click: ['Real mouse click (trusted event) on a ref or x,y.', { tabId, ref, ...xy, button: z.enum(['left', 'right', 'middle']).optional(), count: z.number().int().min(1).max(3).optional().describe('2 = double click') }],
  hover: ['Move the mouse over a ref or x,y.', { tabId, ref, ...xy }],
  drag: ['Drag from one point to another.', { tabId, from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number() }],
  type: ['Type text into the focused element, or into ref (it is clicked first). Newlines become Shift+Enter.', { tabId, text: z.string(), ref }],
  key: ['Press keys, space separated, e.g. "Enter", "ctrl+a", "ctrl+Enter", "Tab Tab".', { tabId, keys: z.string() }],
  scroll: ['Scroll the page or an element. direction up/down/left/right, or "to" with a ref to bring it into view.', { tabId, direction: z.enum(['up', 'down', 'left', 'right', 'to']).optional(), amount: z.number().optional(), ref, ...xy }],
  form_input: ['Set a field value: text, select option (by value or label), checkbox (true/false).', { tabId, ref: z.string(), value: z.union([z.string(), z.boolean(), z.number()]) }],
  eval_js: ['Run JavaScript in the page and return the result (awaits promises).', { tabId, expression: z.string() }],
  console_logs: ['Console output captured since the tab was first used. Filter with a regex pattern.', { tabId, pattern: z.string().optional(), clear: z.boolean().optional(), limit: z.number().optional() }],
  network_requests: ['Network requests captured since the tab was first used. Filter with a regex url_pattern.', { tabId, url_pattern: z.string().optional(), clear: z.boolean().optional(), limit: z.number().optional() }],
  wait_for: ['Wait until text appears on the page (or just wait timeout_s seconds if no text).', { tabId, text: z.string().optional(), timeout_s: z.number().optional() }],
  upload_file: ['Attach local files to a file input ref. Paths must be readable by the browser process.', { tabId, ref: z.string(), paths: z.array(z.string()) }],
  resize_window: ['Resize the browser window holding the tab.', { tabId, width: z.number(), height: z.number() }],
  detach: ['Release the debugger from a tab (removes the "debugging this browser" bar).', { tabId }],
};

const server = new McpServer({ name: 'browser-bridge', version: '1.0.0' });

for (const [name, [description, shape]] of Object.entries(TOOLS)) {
  server.tool(name, description, shape, async args => {
    try {
      const r = await call(name, args);
      if (r && r.image) {
        return { content: [{ type: 'image', data: r.image, mimeType: r.mime || 'image/jpeg' }, { type: 'text', text: r.text || '' }] };
      }
      if (r && typeof r === 'object' && typeof r.text === 'string' && r.url) {
        // read_page / get_text: put the header on top, content below
        const head = `url: ${r.url}\ntitle: ${r.title}` + (r.viewport ? `\nviewport: ${r.viewport.w}x${r.viewport.h} scrollY: ${r.scrollY}` : '');
        return { content: [{ type: 'text', text: head + '\n\n' + r.text }] };
      }
      return { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });
}

await server.connect(new StdioServerTransport());
ensureBackend().catch(e => log('backend start failed:', e.message));
