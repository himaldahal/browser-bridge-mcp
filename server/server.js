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
const MAX_WAIT = 15 * 60 * 1000;

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
let clientWs = null; // client mode: socket to the hub
let mode = null; // 'hub' | 'client'

function track(id, timeoutMs) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('timed out waiting for the browser')); }, timeoutMs);
    pending.set(id, { res, rej, t });
  });
}
// Resolves with { result, alerts } so every reply can carry the extension's open alerts.
function settle(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.t);
  if (msg.error) { const e = new Error(msg.error); e.alerts = msg.alerts || []; p.rej(e); }
  else p.res({ result: msg.result, alerts: msg.alerts || [] });
}

const NOT_CONNECTED = 'The browser extension is not connected. Open its settings in the browser, paste the token (run: node ' + new URL(import.meta.url).pathname + ' --token), and tick "Allow remote control of this browser".';

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
          track(id, Math.min(Number(msg.timeout) || 120000, MAX_WAIT)).then(
            r => ws.readyState === 1 && ws.send(JSON.stringify({ id: msg.id, result: r.result, alerts: r.alerts })),
            err => ws.readyState === 1 && ws.send(JSON.stringify({ id: msg.id, error: err.message, alerts: err.alerts })),
          );
          ext.send(JSON.stringify({ id, method: msg.method, params: msg.params }));
        }
      });
      ws.on('close', () => { clearTimeout(authTimer); if (ext === ws) { ext = null; log('extension disconnected'); } });
    });

    srv.once('error', reject);
    srv.listen(PORT, '127.0.0.1', () => { mode = 'hub'; log('hub listening on 127.0.0.1:' + PORT); resolve(); });
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

function timeoutFor(method, params) {
  if (method === 'wait_for') return ((params.timeout_s || 15) + 10) * 1000;
  if (method === 'ask_human') return ((params.timeout_s || 300) + 30) * 1000;
  if (method === 'check_links') return 300000;
  return 120000;
}

async function call(method, params = {}) {
  await ensureBackend();
  const timeout = Math.min(timeoutFor(method, params), MAX_WAIT);
  const id = nextId++;
  if (mode === 'hub') {
    if (!ext || ext.readyState !== WebSocket.OPEN) throw new Error(NOT_CONNECTED);
    const p = track(id, timeout);
    ext.send(JSON.stringify({ id, method, params }));
    return p;
  }
  const p = track(id, timeout);
  clientWs.send(JSON.stringify({ id, method, params, timeout }));
  return p;
}

// ---------- MCP tools ----------

const tabId = z.number().int().describe('Tab id from tabs_list, tab_create or tabs_open_many');
const ref = z.string().optional().describe('Element ref from read_page, e.g. ref_12');
const xy = { x: z.number().optional().describe('X in CSS px (screenshot space)'), y: z.number().optional().describe('Y in CSS px (screenshot space)') };

const TOOLS = {
  // overview and tabs
  status: ['Bridge and extension state, including open alerts and tabs locked by a CAPTCHA.', {}],
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
  screenshot: ['Screenshot of the tab viewport (or the whole page with full_page). Works on background tabs. Coordinates for click/hover/drag are in this image space.', { tabId, full_page: z.boolean().optional() }],
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
  wait_for: ['Wait until text appears on the page (or just wait timeout_s seconds if no text).', { tabId, text: z.string().optional(), timeout_s: z.number().optional() }],
  downloads_list: ['Recent downloads and their state.', { limit: z.number().optional() }],
  // human in the loop
  detect_captcha: ['Check whether a tab shows a CAPTCHA or human-verification challenge. Detection also happens automatically and locks the tab.', { tabId }],
  ask_human: ['Show a prompt on the tab, bring it to the front, and wait for the person to answer. kind "captcha": they solve the challenge and press Done (use this whenever a CAPTCHA or "are you human" check appears; never try to solve it yourself). kind "confirm": approval before something irreversible. Returns the button they pressed.', { tabId, message: z.string().optional(), kind: z.enum(['info', 'confirm', 'captcha']).optional(), buttons: z.array(z.string()).optional(), timeout_s: z.number().optional() }],
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
- After typing into a composer or form, take a screenshot and read the page to verify before submitting.`;

const server = new McpServer({ name: 'browser-bridge', version: '2.0.0' }, { instructions: INSTRUCTIONS });

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
        if (!TOOLS[tool] || tool === 'ask_human') { results[i] = { error: `unknown or unsupported tool ${tool}` }; continue; }
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

await server.connect(new StdioServerTransport());
ensureBackend().catch(e => log('backend start failed:', e.message));
