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

const VERSION = '3.0.0';
const PROTOCOL = 3;
const PORT = Number(process.env.CBB_PORT) || 17333;
const DIR = path.join(os.homedir(), '.browser-bridge');
const TOKEN_FILE = path.join(DIR, 'token');
const PIN_FILE = path.join(DIR, 'extension-pin.json');
const AUDIT_FILE = path.join(DIR, 'audit.log');
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_WAIT = 15 * 60 * 1000;

function newToken() { return crypto.randomBytes(24).toString('hex'); }

function ensureDir() { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); try { fs.chmodSync(DIR, 0o700); } catch (e) {} }

function loadToken() {
  ensureDir();
  if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, newToken() + '\n', { mode: 0o600 });
  try { // the token must not be readable by other accounts on this machine
    const mode = fs.statSync(TOKEN_FILE).mode & 0o077;
    if (mode) { fs.chmodSync(TOKEN_FILE, 0o600); console.error('[bridge] tightened permissions on', TOKEN_FILE); }
  } catch (e) {}
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}

const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log(`Browser Bridge MCP server ${VERSION}
  node server.js                 run as an MCP stdio server (the first instance also hosts the hub)
  node server.js --hub-only      host the hub without an MCP client
  node server.js --token         print the secret token
  node server.js --rotate-token  replace the token (paste the new one into the extension afterwards)
  node server.js --reset-pin     forget the pinned extension id (use after loading the extension from a new folder)
  node server.js --audit [n]     print the last n audit entries (default 50)
  node server.js --follow        watch calls live, like tail -f (add --json for raw lines)
  Environment: CBB_PORT sets the port (default 17333). CBB_LOG=1 also prints every call to stderr as it happens.`);
  process.exit(0);
}
if (args.has('--rotate-token')) {
  ensureDir();
  fs.writeFileSync(TOKEN_FILE, newToken() + '\n', { mode: 0o600 });
  console.log(fs.readFileSync(TOKEN_FILE, 'utf8').trim());
  console.error('Token replaced. Paste it into the extension settings; restart running bridge servers.');
  process.exit(0);
}
if (args.has('--reset-pin')) {
  try { fs.unlinkSync(PIN_FILE); console.error('Extension pin cleared. The next extension to authenticate will be pinned.'); } catch (e) { console.error('No pin was set.'); }
  process.exit(0);
}
if (args.has('--audit')) {
  const n = Number(process.argv[process.argv.indexOf('--audit') + 1]) || 50;
  try { console.log(fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').slice(-n).join('\n')); } catch (e) { console.error('No audit log yet.'); }
  process.exit(0);
}

// One readable line per audit entry, used by --follow and CBB_LOG.
const color = process.stdout.isTTY || process.env.FORCE_COLOR;
const paint = (c, t) => (color ? `\x1b[${c}m${t}\x1b[0m` : t);
const clean = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '); // agents and pages control some of these fields
function prettyLine(raw) {
  let e;
  try { e = JSON.parse(raw); } catch (x) { return clean(raw); }
  const time = new Date(e.ts).toTimeString().slice(0, 8) + '.' + String(new Date(e.ts).getMilliseconds()).padStart(3, '0');
  const mark = e.ok ? paint('32', 'ok ') : paint('31', 'ERR');
  const a = e.args && Object.keys(e.args).length ? ' ' + clean(JSON.stringify(e.args)).slice(0, 110) : '';
  return `${paint('2', time)} ${mark} ${paint('1', clean(e.tool).padEnd(16))} ${String(Number(e.ms) || 0).padStart(5)}ms ${paint('2', clean(e.client))}${a}${e.error ? ' ' + paint('33', clean(e.error)) : ''}`;
}
if (args.has('--follow')) {
  const json = args.has('--json');
  const out = l => console.log(json ? l : prettyLine(l));
  let pos = 0;
  try { const txt = fs.readFileSync(AUDIT_FILE, 'utf8'); txt.trim().split('\n').filter(Boolean).slice(-15).forEach(out); pos = Buffer.byteLength(txt); } catch (e) {}
  console.error(paint('2', 'Watching ' + AUDIT_FILE + ' (Ctrl+C to stop)'));
  let buf = '';
  setInterval(() => {
    try {
      const size = fs.statSync(AUDIT_FILE).size;
      if (size < pos) pos = 0; // rotated
      if (size === pos) return;
      const fd = fs.openSync(AUDIT_FILE, 'r'); const b = Buffer.alloc(size - pos); fs.readSync(fd, b, 0, b.length, pos); fs.closeSync(fd); pos = size;
      buf += b.toString('utf8'); const parts = buf.split('\n'); buf = parts.pop(); parts.filter(Boolean).forEach(out);
    } catch (e) {}
  }, 200);
  await new Promise(() => {});
}

const TOKEN = loadToken();
if (args.has('--token')) { console.log(TOKEN); process.exit(0); }

const log = (...a) => console.error('[bridge]', ...a); // stdout is reserved for MCP

function safeEq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// Both sides prove they know the token without ever sending it, so a rogue process squatting the port learns nothing.
const mac = (...parts) => crypto.createHmac('sha256', TOKEN).update(parts.join('|')).digest('hex');
const nonce = () => crypto.randomBytes(16).toString('hex');

// ---------- pinning, throttling, audit ----------

function readPin() { try { return JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')).origin || null; } catch (e) { return null; } }
function writePin(origin) { ensureDir(); fs.writeFileSync(PIN_FILE, JSON.stringify({ origin, pinnedAt: new Date().toISOString() }) + '\n', { mode: 0o600 }); }

const authFails = [];
let lockedUntil = 0;
function noteAuthFailure(why) {
  const now = Date.now();
  authFails.push(now);
  while (authFails.length && now - authFails[0] > 60000) authFails.shift();
  log('authentication failed:', why);
  if (authFails.length >= 8) { lockedUntil = now + 60000; log('too many failed attempts; refusing connections for 60s'); }
}

const REDACT = { type: ['text'], key: ['keys'], form_input: ['value'], fill_form: ['fields'], eval_js: ['expression'], handle_dialog: ['text'] };
const noQuery = u => String(u).replace(/[?#].*$/, '?...'); // query strings and fragments often carry tokens
function redact(method, params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if ((REDACT[method] || []).includes(k)) {
      // what was typed, pressed or run can be a password or a secret, so keep only its size (and a short fingerprint of scripts)
      const str = typeof v === 'string' ? v : JSON.stringify(v);
      out[k] = method === 'eval_js' ? `[${str.length} chars sha256:${crypto.createHash('sha256').update(str).digest('hex').slice(0, 12)}]` : `[${str.length} chars]`;
    }
    else if ((k === 'url' || k === 'origin') && typeof v === 'string') out[k] = noQuery(v).slice(0, 200);
    else if (k === 'urls' && Array.isArray(v)) out[k] = v.map(u => noQuery(u).slice(0, 200)).slice(0, 40);
    else if (method === 'wait_for' && k === 'text') out[k] = `[${String(v).length} chars]`;
    else out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '...' : v;
  }
  return out;
}
function audit(entry) {
  try {
    ensureDir();
    try { if (fs.statSync(AUDIT_FILE).size > AUDIT_MAX_BYTES) fs.renameSync(AUDIT_FILE, AUDIT_FILE + '.1'); } catch (e) {}
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(AUDIT_FILE, line + '\n', { mode: 0o600 });
    if (process.env.CBB_LOG) console.error('[call]', prettyLine(line));
  } catch (e) {}
}

// ---------- backend: hub or client ----------

let nextId = 1;
const pending = new Map(); // id -> {res, rej, t}
const relay = new Map(); // hub: extension-facing id -> { ws, id } of the client that asked
let ext = null; // hub: the extension socket
let clientWs = null; // client mode: socket to the hub
let mode = null; // 'hub' | 'client'

function cancelRemote(id) { // the caller no longer waits: do not let the browser run the command later
  try {
    if (mode === 'hub' && ext && ext.readyState === WebSocket.OPEN) ext.send(JSON.stringify({ cancel: id }));
    else if (mode === 'client' && clientWs && clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify({ cancel: id }));
  } catch (e) {}
}
function arm(id, ms) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.t);
  p.t = setTimeout(() => { pending.delete(id); cancelRemote(id); p.rej(new Error('timed out waiting for the browser (it may be paused by the person)')); }, ms);
}
function track(id, timeoutMs) {
  return new Promise((res, rej) => {
    pending.set(id, { res, rej, t: null });
    arm(id, timeoutMs);
  });
}
// Resolves with { result, alerts } so every reply can carry the extension's open alerts.
function settle(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  if (msg.held) { arm(msg.id, MAX_WAIT); return; } // the person paused the browser: keep waiting
  pending.delete(msg.id);
  clearTimeout(p.t);
  if (msg.error) { const e = new Error(msg.error); e.alerts = msg.alerts || []; p.rej(e); }
  else p.res({ result: msg.result, alerts: msg.alerts || [] });
}

const NOT_CONNECTED = 'The browser extension is not connected. Open its settings in the browser, paste the token (run: node ' + new URL(import.meta.url).pathname + ' --token), and tick "Allow remote control of this browser".';

const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

function startHub() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((_q, s) => { s.writeHead(404); s.end(); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

    srv.on('upgrade', (req, socket, head) => {
      const refuse = why => { log('refused connection:', why); socket.destroy(); };
      if (Date.now() < lockedUntil) return refuse('locked after failed attempts');
      // DNS-rebinding guard: the Host header must be the loopback address we listen on.
      if (!HOSTS.has(String(req.headers.host || '').toLowerCase())) return refuse('unexpected Host header ' + req.headers.host);
      // Web pages are never allowed: only the extension (chrome-extension://) or a non-browser client (no Origin).
      const origin = req.headers.origin;
      if (origin && !origin.startsWith('chrome-extension://')) return refuse('web origin ' + origin);
      wss.handleUpgrade(req, socket, head, ws => { ws.origin = origin || null; wss.emit('connection', ws); });
    });

    wss.on('connection', ws => {
      let role = null;
      const sn = nonce();
      const authTimer = setTimeout(() => { if (!role) ws.close(); }, 5000);
      ws.send(JSON.stringify({ hello: sn, protocol: PROTOCOL, version: VERSION }));
      const reject = (why, reason) => { noteAuthFailure(why); try { ws.send(JSON.stringify({ authError: true, reason })); } catch (e) {} ws.close(); };

      ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (!role) {
          if (typeof msg.cn !== 'string' || msg.cn.length > 64 || !(msg.role === 'ext' || msg.role === 'client') || msg.protocol !== PROTOCOL) {
            return reject('bad handshake', msg.protocol !== PROTOCOL ? 'protocol mismatch: update the extension and the server together' : 'bad handshake');
          }
          if (!safeEq(msg.auth || '', mac('cli', msg.role, sn, msg.cn))) return reject('wrong token', 'token rejected');
          if (msg.role === 'ext') {
            if (!ws.origin) return reject('extension without a browser origin', 'not a browser extension');
            const pin = readPin();
            if (pin && pin !== ws.origin) return reject('extension id mismatch ' + ws.origin, 'a different extension is pinned (run: node server.js --reset-pin)');
            if (!pin) { writePin(ws.origin); log('pinned extension', ws.origin); }
          } else if (ws.origin) return reject('client with a browser origin', 'not allowed');
          role = msg.role;
          clearTimeout(authTimer);
          if (role === 'ext') {
            if (ext && ext !== ws) { try { ext.close(); } catch (e) {} for (const id of [...pending.keys()]) settle({ id, error: 'The browser extension reconnected before answering.' }); }
            ext = ws;
            log('extension connected');
          }
          ws.send(JSON.stringify({ authed: true, proof: mac('srv', sn, msg.cn), version: VERSION }));
          return;
        }
        if (msg.ping) return;
        if (role === 'client' && msg.cancel != null) {
          for (const [hid, r] of relay) if (r.ws === ws && r.id === msg.cancel) { relay.delete(hid); if (ext && ext.readyState === WebSocket.OPEN) ext.send(JSON.stringify({ cancel: hid })); settle({ id: hid, error: 'cancelled' }); }
          return;
        }
        if (role === 'ext') {
          if (msg.held) { const r = relay.get(msg.id); if (r && r.ws.readyState === 1) r.ws.send(JSON.stringify({ id: r.id, held: true })); }
          else relay.delete(msg.id);
          settle(msg);
          return;
        }
        // role === client: forward its request to the extension
        if (msg.method) {
          if (!ext || ext.readyState !== WebSocket.OPEN) { ws.send(JSON.stringify({ id: msg.id, error: NOT_CONNECTED })); return; }
          const id = nextId++;
          relay.set(id, { ws, id: msg.id });
          track(id, Math.min(Number(msg.timeout) || 120000, MAX_WAIT)).then(
            r => ws.readyState === 1 && ws.send(JSON.stringify({ id: msg.id, result: r.result, alerts: r.alerts })),
            err => { relay.delete(id); if (ws.readyState === 1) ws.send(JSON.stringify({ id: msg.id, error: err.message, alerts: err.alerts })); },
          );
          ext.send(JSON.stringify({ id, method: msg.method, params: msg.params, client: msg.client }));
        }
      });
      ws.on('close', () => {
        clearTimeout(authTimer);
        if (ext === ws) { // fail waiting calls now instead of letting them sit until their timeout
          ext = null; log('extension disconnected');
          for (const id of [...pending.keys()]) settle({ id, error: 'The browser extension disconnected before answering.' });
        } for (const [k, v] of [...relay]) if (v.ws === ws) { relay.delete(k); if (ext && ext.readyState === WebSocket.OPEN) ext.send(JSON.stringify({ cancel: k })); settle({ id: k, error: 'client disconnected' }); }
      });
    });

    srv.once('error', reject);
    srv.listen(PORT, '127.0.0.1', () => { mode = 'hub'; log(`hub ${VERSION} listening on 127.0.0.1:${PORT}`); resolve(); });
  });
}

function startClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    const fail = e => { try { ws.close(); } catch (x) {} reject(e instanceof Error ? e : new Error('hub connection failed')); };
    let cn = null;
    ws.once('error', fail);
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.hello) {
        cn = nonce();
        ws.send(JSON.stringify({ role: 'client', cn, protocol: PROTOCOL, auth: mac('cli', 'client', msg.hello, cn) }));
        ws._sn = msg.hello;
        return;
      }
      if (msg.authed) {
        if (!safeEq(msg.proof || '', mac('srv', ws._sn, cn))) return fail(new Error('the process on the port did not prove it knows the token'));
        clientWs = ws; mode = 'client'; log('joined existing hub'); resolve(); return;
      }
      if (msg.authError) return fail(new Error('hub rejected us: ' + (msg.reason || 'token')));
      settle(msg);
    });
    ws.on('close', () => { if (clientWs === ws) { clientWs = null; mode = null; for (const id of [...pending.keys()]) settle({ id, error: 'Lost the connection to the bridge hub.' }); } });
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

function timeoutFor(method, params) {
  if (method === 'wait_for') return ((params.timeout_s || 15) + 10) * 1000;
  if (method === 'ask_human') return (Math.min(params.timeout_s || 300, 300) + 30) * 1000;
  if (method === 'check_links') return 300000;
  return 120000;
}

function clientName() {
  try { const v = server.server.getClientVersion(); return v ? `${v.name}${v.version ? ' ' + v.version : ''}` : 'unknown client'; } catch (e) { return 'unknown client'; }
}

async function call(method, params = {}) {
  await ensureBackend();
  const timeout = Math.min(timeoutFor(method, params), MAX_WAIT);
  const id = nextId++;
  const client = clientName();
  const t0 = Date.now();
  const done = (ok, extra) => audit({ client, tool: method, ok, ms: Date.now() - t0, args: redact(method, params), ...extra });
  let p;
  if (mode === 'hub') {
    if (!ext || ext.readyState !== WebSocket.OPEN) { done(false, { error: 'not connected' }); throw new Error(NOT_CONNECTED); }
    p = track(id, timeout);
    ext.send(JSON.stringify({ id, method, params, client }));
  } else {
    p = track(id, timeout);
    clientWs.send(JSON.stringify({ id, method, params, timeout, client }));
  }
  try { const r = await p; done(true); return r; }
  catch (e) { done(false, { error: String(e.message).slice(0, 200) }); throw e; }
}

// ---------- MCP tools ----------

const tabId = z.number().int().describe('Tab id from tabs_list, tab_create or tabs_open_many');
const ref = z.string().optional().describe('Element ref from read_page, e.g. ref_12');
const xy = { x: z.number().optional().describe('X in CSS px (screenshot space)'), y: z.number().optional().describe('Y in CSS px (screenshot space)') };

const TOOLS = {
  // overview and tabs
  status: ['Bridge and extension state: paused or running, permissions, scope, open alerts and tabs locked by a CAPTCHA. Check this when a call is held or refused.', {}],
  tabs_list: ['List every open tab in every window (id, window, title, url). Call this first.', {}],
  windows_list: ['List all browser windows with their tabs.', {}],
  window_create: ['Open a new window (background by default). Useful to keep automated tabs away from the person\'s own.', { url: z.string().optional(), width: z.number().optional(), height: z.number().optional(), focused: z.boolean().optional() }],
  window_close: ['Close a whole window.', { windowId: z.number().int() }],
  tab_create: ['Open one new tab and wait for it to load.', { url: z.string().optional(), active: z.boolean().optional(), windowId: z.number().int().optional() }],
  tabs_open_many: ['Open many URLs in parallel as background tabs and wait for all to load. Best way to start a multi-page task.', { urls: z.array(z.string()).min(1).max(40), windowId: z.number().int().optional(), active: z.boolean().optional() }],
  tab_duplicate: ['Duplicate a tab.', { tabId }],
  group_tabs: ['Group tabs under a title and colour (grey, blue, red, yellow, green, pink, purple, cyan, orange).', { tabIds: z.array(z.number().int()).min(1), title: z.string().optional(), color: z.string().optional() }],
  tab_close: ['Close a tab.', { tabId }],
  tab_activate: ['Bring a tab to the front (some sites need focus).', { tabId }],
  navigate: ['Go to a URL, or "back", "forward", "reload". Also checks the page for a CAPTCHA.', { tabId, url: z.string() }],
  // reading
  read_page: ['Interactive elements as "[ref_N] role "name"" lines (through shadow DOM and same-origin iframes). Use refs with click/type/form_input. filter "all" also lists headings, paragraphs, images. "query" narrows to matching elements.', { tabId, filter: z.enum(['interactive', 'all']).optional(), query: z.string().optional(), max_chars: z.number().optional() }],
  get_text: ['Visible text of the page.', { tabId, max_chars: z.number().optional() }],
  get_links: ['All links on the page (href, text, rel, internal). Feed the hrefs to check_links.', { tabId, scope: z.enum(['all', 'internal', 'external']).optional(), limit: z.number().optional() }],
  screenshot: ['Screenshot of the tab viewport (or the whole page with full_page, or just one element with ref). Works on background tabs. Coordinates for click/hover/drag are in this image space.', { tabId, full_page: z.boolean().optional(), ref }],
  extract: ['Read structured data without parsing text: elements matching a CSS selector (text plus the attrs you list, e.g. href, src, value), or every row of a table when selector points at a table.', { tabId, selector: z.string(), attrs: z.array(z.string()).optional(), limit: z.number().int().min(1).max(1000).optional() }],
  emulate: ['Change how a tab renders: viewport size, device scale, mobile mode, user agent. Use reset: true to undo. Good for responsive checks.', { tabId, width: z.number().optional(), height: z.number().optional(), scale: z.number().optional(), mobile: z.boolean().optional(), user_agent: z.string().optional(), reset: z.boolean().optional() }],
  // input
  click: ['Real mouse click (trusted event) on a ref or x,y. If the person enabled approvals, clicks on buttons like Post/Send/Submit/Delete/Pay pause for their OK. Refused on a tab locked by a CAPTCHA.', { tabId, ref, ...xy, button: z.enum(['left', 'right', 'middle']).optional(), count: z.number().int().min(1).max(3).optional().describe('2 = double click') }],
  hover: ['Move the mouse over a ref or x,y.', { tabId, ref, ...xy }],
  drag: ['Drag from one point to another.', { tabId, from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number() }],
  type: ['Type text into the focused element, or into ref (clicked first). Newlines become Shift+Enter.', { tabId, text: z.string(), ref }],
  key: ['Press keys, space separated, e.g. "Enter", "ctrl+a", "ctrl+Enter", "Tab Tab".', { tabId, keys: z.string() }],
  scroll: ['Scroll the page or an element. direction up/down/left/right, or "to" with a ref to bring it into view.', { tabId, direction: z.enum(['up', 'down', 'left', 'right', 'to']).optional(), amount: z.number().optional(), ref, ...xy }],
  form_input: ['Set one field: text, select option (by value or label), checkbox (true/false).', { tabId, ref: z.string(), value: z.union([z.string(), z.boolean(), z.number()]) }],
  fill_form: ['Set many fields in one call. Returns ok or an error per field.', { tabId, fields: z.array(z.object({ ref: z.string(), value: z.union([z.string(), z.boolean(), z.number()]) })).min(1) }],
  upload_file: ['Attach local files to a file input ref. Paths must be readable by the browser process.', { tabId, ref: z.string(), paths: z.array(z.string()) }],
  eval_js: ['Run JavaScript in the page and return the result (awaits promises).', { tabId, expression: z.string() }],
  handle_dialog: ['Accept or dismiss a JavaScript alert/confirm/prompt that is blocking a tab.', { tabId, accept: z.boolean().optional(), text: z.string().optional() }],
  // monitoring
  events: ['Browser timeline across all tabs: tab opened (with opener, so popups show), navigations, loads, closes, dialogs, downloads, HTTP errors, CAPTCHAs, human prompts. Pass the previous "latest" as since.', { since: z.number().optional(), types: z.array(z.string()).optional(), limit: z.number().optional() }],
  console_logs: ['Console output captured since the tab was first used. Filter with a regex pattern.', { tabId, pattern: z.string().optional(), clear: z.boolean().optional(), limit: z.number().optional() }],
  network_requests: ['Network requests captured since the tab was first used. Filter with a regex url_pattern.', { tabId, url_pattern: z.string().optional(), clear: z.boolean().optional(), limit: z.number().optional() }],
  wait_for: ['Wait until text appears, a CSS selector matches, or the URL contains a string (set gone: true to wait for text or selector to disappear). With no condition it just waits timeout_s seconds.', { tabId, text: z.string().optional(), selector: z.string().optional(), url_contains: z.string().optional(), gone: z.boolean().optional(), timeout_s: z.number().optional() }],
  downloads_list: ['Recent downloads and their state.', { limit: z.number().optional() }],
  // human in the loop
  detect_captcha: ['Check whether a tab shows a CAPTCHA or human-verification challenge. Detection also happens automatically and locks the tab.', { tabId }],
  ask_human: ['Show a prompt on the tab, bring it to the front, and wait for the person to answer. kind "captcha": they solve the challenge and press Done (use this whenever a CAPTCHA or "are you human" check appears; never try to solve it yourself). kind "confirm": approval before something irreversible. Returns the button they pressed.', { tabId, message: z.string().max(600).optional(), kind: z.enum(['info', 'confirm', 'captcha']).optional(), buttons: z.array(z.string().max(40)).max(4).optional(), timeout_s: z.number().min(5).max(300).optional() }],
  // SEO and web checks
  seo_audit: ['On-page SEO audit of a loaded tab: title, description, headings, canonical, robots, hreflang, Open Graph, JSON-LD types, images, links, word count, timings, HTTP status and headers, redirect chain, plus a list of issues.', { tabId }],
  seo_site_check: ['Site-level checks for an origin: robots.txt, sitemap.xml, llms.txt, home page status, HTTPS and HSTS.', { origin: z.string() }],
  fetch_url: ['Fetch a URL from the browser (no cookies, CORS-free) and return status, final URL, headers and the start of the body.', { url: z.string(), method: z.enum(['GET', 'HEAD']).optional(), max_chars: z.number().optional() }],
  check_links: ['Check many URLs in parallel for status codes, redirects and failures.', { urls: z.array(z.string()).min(1), concurrency: z.number().optional() }],
  // window and housekeeping
  resize_window: ['Resize the browser window holding the tab.', { tabId, width: z.number(), height: z.number() }],
  detach: ['Release the debugger from a tab (removes the "debugging this browser" bar).', { tabId }],
  reload_extension: ['Reload the extension (after updating its files). The connection returns in a few seconds.', {}],
};

const INSTRUCTIONS = `Controls the person's own browser through an extension. Rules:
- Start with tabs_list. Prefer opening your own tabs (tabs_open_many, window_create) and leave the person's tabs alone unless asked.
- Work in parallel: tool calls for different tabs run concurrently, and calls for one tab run in order. Use tabs_open_many to load many pages at once and batch to run many operations at once. Use events to monitor new tabs, popups, dialogs and errors.
- Every reply may end with an ALERTS block. Handle it first: a dialog needs handle_dialog; a CAPTCHA needs ask_human.
- CAPTCHAs and human-verification checks: never try to solve, bypass or click through them. The tab is locked for input until the person solves it. Call ask_human with kind "captcha", wait for the answer, then continue.
- Posting, sending, purchasing, deleting or submitting: show the person the exact content first and get a clear yes in chat. The extension may also pause risky clicks for approval; if the person denies, stop and report.
- Never enter passwords, payment details or one-time codes yourself. Ask the person to do it on the page.
- After typing into a composer or form, take a screenshot and read the page to verify before submitting.
- The person can pause or stop you at any time. A call that is held means they paused: wait, do not retry in a loop. A refusal that names a permission, blocked site or scope is a decision, not a glitch: report it and ask, do not look for a way around it.`;

const server = new McpServer({ name: 'browser-bridge', version: VERSION }, { instructions: INSTRUCTIONS });

function alertBlock(alerts) {
  return alerts && alerts.length ? [{ type: 'text', text: 'ALERTS:\n- ' + alerts.join('\n- ') }] : [];
}

// Turns an extension result into MCP content blocks.
function toContent(label, r) {
  const out = [];
  const pre = label ? label + '\n' : '';
  if (r && r.image) {
    out.push({ type: 'image', data: r.image, mimeType: r.mime || 'image/jpeg' }, { type: 'text', text: pre + (r.text || '') });
  } else if (r && typeof r === 'object' && typeof r.text === 'string' && r.url) {
    const head = `url: ${r.url}\ntitle: ${r.title}` + (r.viewport ? `\nviewport: ${r.viewport.w}x${r.viewport.h} scrollY: ${r.scrollY}` : '');
    out.push({ type: 'text', text: pre + head + '\n\n' + r.text });
  } else {
    out.push({ type: 'text', text: pre + (typeof r === 'string' ? r : JSON.stringify(r, null, 2)) });
  }
  return out;
}

for (const [name, [description, shape]] of Object.entries(TOOLS)) {
  server.tool(name, description, shape, async args => {
    try {
      const { result, alerts } = await call(name, args);
      return { content: [...toContent('', result), ...alertBlock(alerts)] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }, ...alertBlock(e.alerts)] };
    }
  });
}

// Fan out many operations at once. Operations on different tabs run in parallel in the browser.
server.tool(
  'batch',
  'Run many tool calls at once and get every result back. Operations on different tabs run in parallel; operations on the same tab run in order. Example: screenshot or read_page on ten tabs in one call. Not for ask_human.',
  {
    ops: z.array(z.object({ tool: z.string(), args: z.record(z.any()).optional() })).min(1).max(60),
    concurrency: z.number().int().min(1).max(20).optional().describe('Max operations in flight (default 10)'),
  },
  async ({ ops, concurrency = 10 }) => {
    const content = [];
    const allAlerts = new Set();
    const results = new Array(ops.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, ops.length) }, async () => {
      while (next < ops.length) {
        const i = next++;
        const { tool, args = {} } = ops[i];
        if (!Object.hasOwn(TOOLS, tool) || tool === 'ask_human') { results[i] = { error: `unknown or unsupported tool ${tool}` }; continue; }
        const check = z.strictObject(TOOLS[tool][1]).safeParse(args); // batch must not skip the argument checks a direct call gets
        if (!check.success) { results[i] = { error: `invalid arguments for ${tool}: ${check.error.issues.map(x => x.path.join('.') + ' ' + x.message).join('; ').slice(0, 200)}` }; continue; }
        try {
          const r = await call(tool, args);
          r.alerts.forEach(a => allAlerts.add(a));
          results[i] = { result: r.result };
        } catch (e) {
          (e.alerts || []).forEach(a => allAlerts.add(a));
          results[i] = { error: e.message };
        }
      }
    }));
    ops.forEach((op, i) => {
      const label = `#${i + 1} ${op.tool}${op.args && op.args.tabId ? ' tab ' + op.args.tabId : ''}`;
      const r = results[i];
      if (r.error) content.push({ type: 'text', text: `${label} ERROR: ${r.error}` });
      else content.push(...toContent(label + ':', r.result));
    });
    content.push(...alertBlock([...allAlerts]));
    return { content, isError: results.every(r => r.error) };
  },
);

// ---------- prompts (workflows) ----------

const userMsg = text => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

server.prompt('seo_audit', 'Audit one or more pages for on-page and site-level SEO', { urls: z.string().describe('One URL, or several separated by spaces or commas') }, ({ urls }) => userMsg(
  `Run an SEO audit for: ${urls}\n1. seo_site_check for each origin (robots.txt, sitemap, llms.txt, HTTPS).\n2. tabs_open_many for all the URLs, then batch seo_audit on every tab.\n3. For each page run get_links, then check_links on its internal links and report broken or redirected ones.\n4. Take a screenshot of each page and note visible problems (layout, cookie walls, intrusive popups).\n5. Report a prioritized list per page: what is wrong, why it matters, the exact fix. Close the tabs you opened. If a CAPTCHA appears, use ask_human.`));

server.prompt('brand_presence', 'Check how a brand shows up in search and on social platforms', { brand: z.string(), site: z.string().optional().describe('Official website, if any') }, ({ brand, site }) => userMsg(
  `Check the online presence of "${brand}"${site ? ` (official site ${site})` : ''}.\nOpen in parallel with tabs_open_many (background): Google search for the brand name in quotes, Google search for "${brand} reviews", Google Maps search, and the platform search or profile pages for Facebook, Instagram, LinkedIn, X, YouTube, TikTok and Pinterest.\nThen batch get_text or screenshot on every tab. Report: which profiles exist and whether they look official, follower counts and last post date where visible, branded search results and the knowledge panel, review ratings and counts, inconsistencies in name, address or phone, and gaps to fix. Read only; do not log in, follow, like or post. If a login wall or CAPTCHA appears, tell me and use ask_human where a human check is the blocker.`));

server.prompt('post_to_social', 'Draft and publish a post on one or more platforms, with approval', { text: z.string(), platforms: z.string().describe('For example: facebook, linkedin, x'), media: z.string().optional().describe('Local file paths to attach') }, ({ text, platforms, media }) => userMsg(
  `Publish this post on: ${platforms}.\n\n"""${text}"""\n${media ? `Attach: ${media}\n` : ''}Steps: open each platform in its own background tab (tabs_open_many) and confirm I am logged in (if not, ask me to log in on the page). Open the composer, type the text with type, attach media with upload_file, then take a screenshot of each filled composer and show me the exact content. Wait for my explicit yes in chat before pressing Post. After I approve, click Post (the browser may also ask me to approve the click), then verify the post appears and give me its URL. If any CAPTCHA or verification appears, use ask_human and wait.`));

server.prompt('fill_form', 'Fill and submit a web form from provided data', { url: z.string(), data: z.string().describe('Field values, free text or JSON') }, ({ url, data }) => userMsg(
  `Fill out the form at ${url} with this data:\n${data}\nOpen the page, read_page to list the fields, map each value to a field, use fill_form, then screenshot and show me what will be submitted. Do not enter passwords, payment details or one-time codes; ask me to type those. Wait for my yes before submitting. If a CAPTCHA appears, use ask_human.`));

if (process.argv.includes('--hub-only')) {
  // Standalone hub (systemd user service): own the port without any MCP client. Wait if another process holds it.
  const tryHub = async () => {
    try { await startHub(); log('standalone hub running'); }
    catch (e) { if (e.code !== 'EADDRINUSE') log('hub error:', e.message); setTimeout(tryHub, 30000); }
  };
  tryHub();
} else {
  await server.connect(new StdioServerTransport());
  ensureBackend().catch(e => log('backend start failed:', e.message));
}
