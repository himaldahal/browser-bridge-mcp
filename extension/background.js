// Browser Bridge: service worker.
// Connects to the local MCP server over ws://127.0.0.1:<port>, authenticates with a shared token,
// then executes browser commands (chrome.tabs / chrome.windows / chrome.scripting / chrome.debugger).
//
// Concurrency: commands for different tabs run in parallel; commands for the same tab run in order.
// Human in the loop: CAPTCHAs lock a tab for automation; risky clicks can require approval; both use an
// on-page prompt that only a real (trusted) click from the person can answer.

const PROTOCOL = 3;
const DEFAULTS = {
  token: '', port: 17333, enabled: true,
  blocked: '', allowed: '', scope: 'all', blockFiles: true,
  gate: true, riskyExtra: '',
  perm_read: 'allow', perm_nav: 'allow', perm_input: 'allow', perm_script: 'ask',
  rateLimit: 600, idleMin: 10, pageBadge: true, allowPrivate: false, highlightTabs: true,
};
const RECONNECT_KEYS = new Set(['token', 'port', 'enabled']);
const ICON = 'icon128.png';
const ALLOW_MS = 10 * 60 * 1000;
const AUDIT_KEEP = 500;

const state = {
  ws: null,
  cfg: { ...DEFAULTS },
  reason: 'starting',
  connected: false,
  tabs: new Map(), // tabId -> { console, network, last, mainFrame, doc }
  alerts: new Map(), // key -> text, shown to the client on every reply while unresolved
  captcha: new Map(), // tabId -> { locked, kinds, clearedUntil }
  siteAllow: new Map(), // host -> ms until which risky clicks are pre-approved
  permAllow: new Map(), // "category|host" -> ms until which an "ask" permission is pre-approved
};
const rt = { paused: false, step: 0 }; // survives worker restarts via storage.session
const stale = { pills: [] }; // leftovers from before a worker restart, cleaned up once
const owned = new Set(); // tabs opened by the bridge or shared by the person (used when scope is "own")
const waiters = new Set(); // commands held while paused: { res, rej }
const activity = []; // newest last: what the automation did, shown in the popup and saved as the audit log
const recent = []; // timestamps of recent commands, for the rate limit
const clients = new Map(); // client name -> last seen
const humanWaiters = new Map(); // id -> resolve
const humanTabs = new Set(); // tabs with an open human prompt
const inflight = new Map(); // server call id -> entry, so the caller can cancel it
const handsOff = new Map(); // tabId -> until: the person took the tab back, the agent may not use it
const running = new Map(); // tabId -> the command currently executing on it
const attaching = new Map(); // tabId -> pending debugger attach
let stopGen = 0; // bumped by Stop; commands from an older generation never run
const cmdAt = new Map(); // tabId -> time of the last command sent to it
const badgeSeen = new Map(); // tabId -> { at, paused } for the on-page pill
const queues = new Map(); // key -> promise tail
let humanSeq = 0;
let actSeq = 0;

const uiPorts = new Set(); // popup, settings and live monitor pages that want realtime updates
let notifyTimer = null;
function broadcast(msg) { for (const p of [...uiPorts]) { try { p.postMessage(msg); } catch (e) { uiPorts.delete(p); } } }
function notifyUi() { // coalesce bursts into one "something changed" nudge
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => { notifyTimer = null; setBadge(); broadcast({ type: 'changed' }); }, 120);
}
const pub = e => ({ id: e.id, ts: e.ts, tool: e.tool, tabId: e.tabId, host: e.host, client: e.client, status: e.status, ms: e.ms, summary: e.summary, error: e.error });
const emit = e => { broadcast({ type: 'entry', entry: pub(e) }); notifyUi(); };

// Keep a trace of anything that escapes: a worker that dies silently is the hardest failure to debug.
self.addEventListener('unhandledrejection', e => console.error('[bridge] unhandled rejection:', e.reason && (e.reason.stack || e.reason.message || e.reason)));
self.addEventListener('error', e => console.error('[bridge] error:', e.message));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hostOf = u => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };

// Tool categories drive the permission switches in settings.
const CATEGORY = {};
for (const [c, names] of Object.entries({
  read: 'tabs_list windows_list read_page get_text get_links screenshot extract console_logs network_requests wait_for downloads_list detect_captcha seo_audit seo_site_check fetch_url check_links',
  nav: 'window_create window_close tab_create tabs_open_many tab_duplicate group_tabs tab_close tab_activate navigate resize_window emulate detach',
  input: 'click hover drag type key scroll form_input fill_form handle_dialog',
  script: 'eval_js upload_file',
  meta: 'status events ask_human reload_extension',
})) names.split(' ').forEach(n => { CATEGORY[n] = c; });
const OBSERVE = new Set(['status', 'events']); // never held by a pause, so the client can see why it waits

// ---------- persisted runtime state (storage.session) and audit (storage.local) ----------

let auditDirty = false;
const ready = (async () => {
  try {
    const s = await chrome.storage.session.get({ rt: null, owned: [], groups: [], temp: [], pills: [] });
    if (s.rt) Object.assign(rt, s.rt);
    s.owned.forEach(id => owned.add(id));
    s.groups.forEach(([w, g]) => groups.set(w, g));
    s.temp.forEach(([id, spot]) => tempJoined.set(id, spot));
    stale.pills = s.pills;
  } catch (e) {}
  try {
    const l = await chrome.storage.local.get({ audit: [] });
    activity.push(...l.audit.map(a => (a.status === 'running' || a.status === 'held' ? { ...a, status: 'error', error: 'interrupted' } : a)));
    actSeq = activity.reduce((m, a) => Math.max(m, a.id), 0);
  } catch (e) {}
})();
function saveRt() { chrome.storage.session.set({ rt, owned: [...owned], groups: [...groups], temp: [...tempJoined], pills: [...badgeSeen.keys()] }).catch(() => {}); }
setInterval(() => {
  if (!auditDirty) return;
  auditDirty = false;
  chrome.storage.local.set({ audit: activity.filter(a => a.status !== 'running' && a.status !== 'held').slice(-AUDIT_KEEP) }).catch(() => {});
}, 3000);

const groups = new Map(); // windowId -> id of the "Bridge" tab group in that window
const tempJoined = new Map(); // person's own tabs that joined the group only while being controlled: tabId -> where they were
const controlledIds = () => new Set([...owned, ...state.tabs.keys(), ...badgeSeen.keys()]); // shared, debugger-attached or driven in the last seconds
function groupLook() { return rt.paused ? { title: 'Bridge · paused', color: 'orange' } : { title: 'Bridge', color: 'purple' }; }
const groupGone = e => /no group with id/i.test(String((e && e.message) || e)); // anything else (for example the person dragging a tab) is temporary
const isBridgeGroup = gid => [...groups.values()].includes(gid);

// Puts a tab into the window's "Bridge" group (purple while running, orange while paused) so the person sees at a glance
// which tabs the agent is using. Tabs that already sit in one of the person's own groups are left where they are.
function highlight(tabId, permanent) {
  if (!state.cfg.highlightTabs || !chrome.tabGroups) return Promise.resolve();
  return chrome.tabs.get(tabId).then(t => enqueue('group' + t.windowId, async () => {
    try {
      const cur = await chrome.tabs.get(tabId);
      if (cur.groupId !== -1 && !isBridgeGroup(cur.groupId)) return;
      let gid = groups.get(cur.windowId);
      if (gid != null) { try { await chrome.tabGroups.get(gid); } catch (e) { if (!groupGone(e)) return; gid = null; groups.delete(cur.windowId); } }
      if (cur.groupId !== -1 && cur.groupId === gid) { if (permanent) tempJoined.delete(tabId); return; }
      if (!permanent && !tempJoined.has(tabId)) tempJoined.set(tabId, { windowId: cur.windowId, index: cur.index }); // remember the spot before grouping moves the tab
      const id = await chrome.tabs.group(gid != null ? { tabIds: [tabId], groupId: gid } : { tabIds: [tabId], createProperties: { windowId: cur.windowId } });
      groups.set(cur.windowId, id);
      await chrome.tabGroups.update(id, { ...groupLook(), collapsed: false });
      if (permanent) tempJoined.delete(tabId); else if (!tempJoined.has(tabId)) tempJoined.set(tabId, { windowId: cur.windowId, index: cur.index });
      saveRt();
    } catch (e) {}
  })).catch(() => {});
}
async function unhighlight(tabId) {
  const spot = tempJoined.get(tabId);
  tempJoined.delete(tabId);
  try {
    const t = await chrome.tabs.get(tabId);
    if (isBridgeGroup(t.groupId)) await chrome.tabs.ungroup(tabId);
    if (spot) await chrome.tabs.move(tabId, { windowId: spot.windowId, index: spot.index }).catch(() => {}); // back where the person had it
  } catch (e) {}
  saveRt();
}
async function refreshGroups() {
  for (const [w, gid] of [...groups]) {
    try { await chrome.tabGroups.update(gid, groupLook()); } catch (e) { if (groupGone(e)) groups.delete(w); }
  }
}
if (chrome.tabGroups) chrome.tabGroups.onRemoved.addListener(g => { for (const [w, id] of groups) if (id === g.id) groups.delete(w); saveRt(); });

// After a worker restart nothing remembers who was being driven: take the person's tabs out of the group and remove stale pills.
ready.then(async () => {
  for (const id of [...tempJoined.keys()]) await unhighlight(id);
  for (const id of stale.pills) paintBadge(id, false);
  stale.pills = [];
});

function own(id) { if (id != null && !owned.has(id)) { owned.add(id); saveRt(); highlight(id, true); notifyUi(); } }
const isOwned = id => owned.has(id);

// ---------- event timeline ----------

let evSeq = 0;
const events = [];
function logEvent(type, data) {
  const ev = { seq: ++evSeq, ts: new Date().toISOString(), type, ...data };
  events.push(ev);
  if (events.length > 1000) events.shift();
  broadcast({ type: 'event', ev });
}

// ---------- connection ----------

function setBadge() {
  let text = '', color = '#1f9d55';
  if (state.connected) {
    const n = controlledIds().size;
    if (rt.paused) { text = '||'; color = '#d97706'; } else text = n ? String(n) : 'ON';
  } else if (!state.cfg.enabled) { text = 'OFF'; color = '#6b7280'; }
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function hmacHex(key, text) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const randHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

async function connect() {
  await ready;
  state.cfg = await chrome.storage.local.get(DEFAULTS);
  if (!state.cfg.enabled) { state.reason = 'turned off'; return teardown(); }
  if (!state.cfg.token) { state.reason = 'no token set'; return teardown(); }
  if (state.ws && state.ws.readyState <= 1) return;

  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${state.cfg.port}/`);
  } catch (e) {
    state.reason = String(e);
    return;
  }
  state.ws = ws;
  state.reason = 'connecting';

  // Mutual authentication: the server speaks first; neither side ever sends the token itself.
  ws.onmessage = ev => onMessage(ws, ev.data);
  ws.onclose = () => {
    for (const w of [...waiters]) { waiters.delete(w); w.rej(refuse('The connection to the bridge closed.')); }
    if (state.ws === ws) { state.ws = null; state.connected = false; if (!/rejected|pinned|proof|mismatch/.test(state.reason)) state.reason = 'bridge not running (start the MCP client that runs the bridge server)'; setBadge(); }
  };
  ws.onerror = () => {};
}

function teardown() {
  state.connected = false;
  setBadge();
  if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
}

// Commands that must not wait behind other commands on the same tab.
const EXEMPT = new Set(['ask_human', 'wait_for', 'handle_dialog', 'status', 'events', 'tabs_list', 'detect_captcha', 'windows_list', 'downloads_list']);


function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const p = prev.catch(() => {}).then(fn);
  queues.set(key, p.catch(() => {}));
  return p;
}

async function onMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.hello) {
    if (msg.protocol !== PROTOCOL) { state.reason = 'protocol mismatch: update the extension and the server together'; ws.close(); return; }
    ws._sn = msg.hello; ws._cn = randHex(16);
    ws.send(JSON.stringify({ role: 'ext', cn: ws._cn, protocol: PROTOCOL, auth: await hmacHex(state.cfg.token, ['cli', 'ext', ws._sn, ws._cn].join('|')) }));
    return;
  }
  if (msg.authed) {
    const want = await hmacHex(state.cfg.token, ['srv', ws._sn, ws._cn].join('|'));
    if (msg.proof !== want) { state.reason = 'the process on the port did not prove it knows the token (is something else using the port?)'; state.connected = false; if (state.ws === ws) state.ws = null; ws.close(); setBadge(); return; }
    if (ws !== state.ws) { ws.close(); return; }
    ws._ok = true;
    state.connected = true; state.reason = 'ok'; setBadge(); refreshAlerts(); return;
  }
  if (msg.authError) { state.reason = 'rejected by the bridge: ' + (msg.reason || 'token'); state.connected = false; setBadge(); return; }
  if (msg.ping) return;
  if (msg.cancel != null) { if (ws === state.ws && ws._ok) cancelCall(msg.cancel); return; }
  if (!msg.method) return;
  if (ws !== state.ws || !ws._ok || !state.connected) return; // never run commands from a peer that has not proved it knows the token
  dispatch(ws, msg); // not awaited: many commands may be in flight at once (parallel tabs)
}

// Agent-supplied filters run inside the worker that also serves Pause and Stop, so no regex engine is involved:
// "a|b" matches either, ".*" means "anything in between", everything else is a case-insensitive substring.
function matcher(pattern) {
  const alts = String(pattern).slice(0, 200).toLowerCase().split('|').map(a => a.replace(/^\^|\$$/g, '').split('.*').filter(Boolean)).filter(a => a.length);
  if (!alts.length) return () => true;
  return text => {
    const t = String(text).toLowerCase();
    return alts.some(parts => { let at = 0; for (const x of parts) { const i = t.indexOf(x, at); if (i < 0) return false; at = i + x.length; } return true; });
  };
}

const stripQuery = u => String(u).replace(/[?#].*$/, m => (m.length > 1 ? m[0] + '...' : m)); // query strings often carry tokens
function summarize(method, p) {
  switch (method) {
    case 'navigate': case 'tab_create': case 'fetch_url': return stripQuery(p.url || '');
    case 'tabs_open_many': return (p.urls || []).length + ' urls';
    case 'click': case 'hover': return p.ref || (p.x != null ? `${p.x},${p.y}` : '');
    case 'type': return String(p.text || '').length + ' chars';
    case 'key': return String(p.keys || '').split(/\s+/).filter(Boolean).length + ' keys';
    case 'eval_js': return String(p.expression || '').length + ' chars of script';
    case 'handle_dialog': return p.accept === false ? 'dismiss' : 'accept';
    case 'form_input': return p.ref || '';
    case 'fill_form': return (p.fields || []).length + ' fields';
    case 'check_links': return (p.urls || []).length + ' urls';
    default: return p.query || p.selector || p.text || '';
  }
}
function begin(method, params, client) {
  const e = { id: ++actSeq, ts: Date.now(), tool: method, tabId: params.tabId != null ? params.tabId : null, host: '', client: client || '', status: 'running', ms: 0, summary: summarize(method, params), error: '' };
  activity.push(e);
  if (activity.length > AUDIT_KEEP + 100) activity.splice(0, activity.length - AUDIT_KEEP - 100);
  if (client) clients.set(client, Date.now());
  if (e.tabId != null) chrome.tabs.get(e.tabId).then(t => { e.host = hostOf(t.url || ''); }).catch(() => {});
  emit(e);
  return e;
}
function finish(e, status, error) { e.status = status; e.ms = Date.now() - e.ts; if (error) e.error = String(error).slice(0, 300); auditDirty = true; emit(e); }
const refuse = (msg, kind = 'denied') => { const e = new Error(msg); e[kind] = true; return e; };

async function dispatch(ws, msg) {
  await ready;
  const method = msg.method;
  const params = msg.params || {};
  const entry = begin(method, params, msg.client);
  Object.defineProperty(entry, '_ctx', { value: { ws, id: msg.id, gen: stopGen, passed: false, cancelled: false }, enumerable: false });
  inflight.set(msg.id, entry);
  let reply;
  try {
    const h = HANDLERS[method];
    if (!h) throw new Error('unknown method ' + method);
    if (!OBSERVE.has(method)) {
      await hold(ws, msg.id, entry);
      rateCheck();
      await authorize(method, params, entry);
      if (params.tabId != null && CATEGORY[method] !== 'meta') { touchBadge(params.tabId); cmdAt.set(params.tabId, Date.now()); }
    }
    if (entry.status !== 'running') { entry.status = 'running'; emit(entry); }
    const run = async () => {
      if (!OBSERVE.has(method)) await recheck(entry); // pause or stop may have happened while this waited in line
      if (params.tabId != null) running.set(params.tabId, entry);
      try { return await h(params); } finally { if (running.get(params.tabId) === entry) running.delete(params.tabId); }
    };
    const result = params.tabId != null && !EXEMPT.has(method) ? await enqueue('t' + params.tabId, run) : await run();
    finish(entry, 'ok');
    reply = { id: msg.id, result };
  } catch (e) {
    finish(entry, e && e.denied ? 'denied' : 'error', (e && e.message) || e);
    reply = { id: msg.id, error: String((e && e.message) || e) };
  }
  inflight.delete(msg.id);
  reply.alerts = [...state.alerts.values()];
  if (ws.readyState === 1) ws.send(JSON.stringify(reply));
}

// The caller gave up (timeout or disconnect): stop this command if it has not run yet.
function cancelCall(id) {
  const e = inflight.get(id);
  if (!e) return;
  e._ctx.cancelled = true;
  for (const w of [...waiters]) if (w.entry === e) { waiters.delete(w); w.rej(refuse('The caller gave up waiting, so this was cancelled.')); }
}

const HELD_MAX_MS = 14 * 60 * 1000; // the server stops waiting after 15 minutes

// Pause gate: while paused every command waits here until the person resumes, steps or stops.
async function hold(ws, id, entry) {
  if (!rt.paused) return;
  if (rt.step > 0) { rt.step--; saveRt(); entry._ctx.passed = true; return; }
  entry.status = 'held'; emit(entry);
  if (ws.readyState === 1) ws.send(JSON.stringify({ id, held: true })); // tells the server to keep waiting
  await new Promise((res, rej) => {
    const w = { entry, res: () => { clearTimeout(t); res(); }, rej: e => { clearTimeout(t); rej(e); } };
    const t = setTimeout(() => { waiters.delete(w); rej(refuse('Held for too long and the caller gave up. Try again after resuming.')); }, HELD_MAX_MS);
    waiters.add(w);
  });
  entry._ctx.passed = true;
}
// Called again just before a command runs and after any prompt: a Stop, a Pause or a dropped caller wins.
async function recheck(entry) {
  const c = entry._ctx;
  const dead = () => { if (c.gen !== stopGen) throw refuse('Stopped by the person. Do not retry; ask them what to do.'); if (c.cancelled) throw refuse('The caller gave up waiting, so this was cancelled.'); if (c.ws.readyState !== 1) throw refuse('The caller disconnected before this ran.'); };
  dead();
  if (rt.paused && !c.passed) await hold(c.ws, c.id, entry);
  c.passed = false; // the release applies once; a later Pause holds it again
  dead();
}
function notifyHeld(entry) { const c = entry && entry._ctx; if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify({ id: c.id, held: true })); }
function releaseWaiters(n = Infinity) {
  let i = 0;
  for (const w of [...waiters]) { if (i++ >= n) break; waiters.delete(w); w.res(); }
}

function rateCheck() {
  const limit = Number(state.cfg.rateLimit) || 0;
  if (!limit) return;
  const now = Date.now();
  while (recent.length && now - recent[0] > 60000) recent.shift();
  if (recent.length >= limit) throw refuse(`rate limit reached (${limit} actions per minute, set by the person). Slow down.`);
  recent.push(now);
}

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF]/g; // zero-width and bidi tricks that could disguise text
const show = (t, n) => { t = String(t == null ? '' : t).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + ` ... (${t.length - n} more characters not shown, so only allow if you trust the sender)` : t; };
function describeCall(method, p) {
  switch (method) {
    case 'eval_js': return show(p.expression, 500);
    case 'upload_file': return show((p.paths || []).join('  '), 500);
    case 'navigate': case 'tab_create': case 'window_create': return show(p.url, 300);
    case 'tabs_open_many': return show((p.urls || []).join('  '), 400);
    case 'type': return 'Text: ' + show(p.text, 300);
    case 'key': return 'Keys: ' + show(p.keys, 200);
    case 'form_input': return 'Value: ' + show(p.value, 200);
    case 'fill_form': return (p.fields || []).length + ' fields: ' + show((p.fields || []).map(f => f.value).join(' | '), 300);
    case 'handle_dialog': return (p.accept === false ? 'Dismiss' : 'Accept') + (p.text ? ' with: ' + show(p.text, 200) : '');
    default: return '';
  }
}

// Per-category switches: allow, ask (prompt the person, with a 10 minute allowance per method and site) or block.
async function authorize(method, params, entry) {
  const c = CATEGORY[method];
  if (!c || c === 'meta') return;
  const mode = state.cfg['perm_' + c] || 'allow';
  if (mode === 'allow') return;
  const label = { read: 'read pages', nav: 'open and navigate tabs', input: 'click and type', script: 'run scripts' }[c];
  if (mode === 'block') throw refuse(`Permission denied: the person has blocked the "${label}" permission (${method}). Ask them to change it in the extension settings.`);
  // ask
  let tabId = params.tabId;
  if (tabId == null) { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); if (t) tabId = t.id; }
  if (tabId == null) throw refuse(`The person must approve "${label}" but no tab is open to ask on.`);
  let host = '';
  try { host = hostOf((await chrome.tabs.get(tabId)).url || ''); } catch (e) {}
  const key = method + '|' + host;
  if ((state.permAllow.get(key) || 0) > Date.now()) return;
  const d = describeCall(method, params);
  notifyHeld(entry);
  const ans = await askHuman(tabId, {
    title: 'Allow this action?',
    message: `An automated session wants to ${method.replace(/_/g, ' ')}${host ? ' on ' + host : ''}.${d ? '\n\n' + d : ''}`,
    buttons: ['Allow once', 'Allow ' + method.replace(/_/g, ' ') + ' on this site for 10 min', 'Deny'],
    timeout_s: 300,
  });
  if (/^Allow .* for 10 min$/.test(ans)) { await recheck(entry); if (params.tabId != null) await guard(params.tabId); state.permAllow.set(key, Date.now() + ALLOW_MS); return; }
  if (ans === 'unavailable') throw refuse(`A prompt cannot be shown on this kind of page, so "${method}" was not allowed. Ask the person to try on a normal web page.`);
  if (ans !== 'Allow once') throw refuse(`The person did not allow "${method}" (${ans}).`);
  await recheck(entry);
  if (params.tabId != null) await guard(params.tabId);
}

// ---------- control: pause, resume, step, stop ----------

function refreshAlerts() {
  if (rt.paused) state.alerts.set('control', 'The person has paused the browser. New commands are held until they resume; wait instead of retrying.');
  else state.alerts.delete('control');
}

async function control(action, source) {
  await ready;
  switch (action) {
    case 'pause': rt.paused = true; break;
    case 'resume': rt.paused = false; rt.step = 0; releaseWaiters(); break;
    case 'toggle': return control(rt.paused ? 'resume' : 'pause', source);
    case 'step': rt.paused = true; if (waiters.size) releaseWaiters(1); else rt.step++; break;
    case 'stop': await emergencyStop(); break;
    default: return;
  }
  saveRt(); refreshAlerts(); setBadge(); refreshBadges(); refreshGroups(); notifyUi();
  logEvent('control', { action, source });
}

// Cuts everything loose: held commands fail, open prompts are cancelled, debugger sessions and pre-approvals end.
async function emergencyStop() {
  rt.paused = true; rt.step = 0; stopGen++;
  for (const w of [...waiters]) { waiters.delete(w); w.rej(refuse('Stopped by the person. Do not retry; ask them what to do.')); }
  for (const [id, res] of [...humanWaiters]) { humanWaiters.delete(id); res('stopped'); }
  state.siteAllow.clear(); state.permAllow.clear();
  for (const id of [...state.tabs.keys()]) { try { await chrome.debugger.detach({ tabId: id }); } catch (e) {} }
  state.tabs.clear();
  try { chrome.notifications.create('cbb-stop', { type: 'basic', iconUrl: ICON, title: 'Browser Bridge stopped', message: 'All automation was halted and approvals were revoked. Resume from the extension popup.' }); } catch (e) {}
}

chrome.commands.onCommand.addListener(c => { if (c === 'toggle-pause') control('toggle', 'shortcut'); else if (c === 'emergency-stop') control('stop', 'shortcut'); });

// keep the worker alive and reconnect
setInterval(() => { if (state.ws && state.ws.readyState === 1) state.ws.send('{"ping":1}'); }, 20000);
chrome.alarms.create('cbb-tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== 'cbb-tick') return;
  if (!state.ws || state.ws.readyState > 1) connect();
  const now = Date.now();
  for (const [tabId, t] of state.tabs) {
    if (now - t.last > (Number(state.cfg.idleMin) || 10) * 60000 && !humanTabs.has(tabId)) { try { await chrome.debugger.detach({ tabId }); } catch (e) {} state.tabs.delete(tabId); }
  }
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes).filter(k => k in DEFAULTS);
  if (!keys.length) return;
  if (keys.some(k => RECONNECT_KEYS.has(k))) { teardown(); connect(); } else state.cfg = await chrome.storage.local.get(DEFAULTS);
  if (changes.pageBadge && !state.cfg.pageBadge) refreshBadges(true);
  setBadge();
});
const UI_URL = chrome.runtime.getURL('');
chrome.runtime.onConnect.addListener(port => { // realtime channel for our own pages only
  if (port.name !== 'live' || !port.sender || port.sender.id !== chrome.runtime.id || !String(port.sender.url || '').startsWith(UI_URL)) { port.disconnect(); return; }
  uiPorts.add(port);
  port.onDisconnect.addListener(() => uiPorts.delete(port));
  port.postMessage({ type: 'changed' });
});
chrome.runtime.onMessage.addListener((m, sender, send) => {
  if (!m || sender.id !== chrome.runtime.id) return false;
  const fromUi = typeof sender.url === 'string' && sender.url.startsWith(UI_URL); // popup or settings page
  const fromPage = !!sender.tab && !fromUi; // our injected on-page prompt or pill (the click was verified as trusted there)
  // Answers from the on-page prompt.
  if (m.type === 'human' && sender.tab) {
    const res = humanWaiters.get(m.id);
    if (res) { humanWaiters.delete(m.id); res(String(m.choice)); }
    return false;
  }
  if (m.type === 'ctl') {
    const allowed = fromUi ? ['pause', 'resume', 'toggle', 'step', 'stop'] : fromPage ? ['pause', 'resume', 'stop'] : [];
    if (allowed.includes(m.action)) control(m.action, fromUi ? 'popup' : 'page').then(() => send({ ok: true }));
    else send({ ok: false });
    return true;
  }
  if (!fromUi) return false; // everything below is for our own UI only
  switch (m.type) {
    case 'status': send({ connected: state.connected, reason: state.reason }); return false;
    case 'snapshot': snapshot().then(send); return true;
    case 'share': (async () => { if (m.on) { handsOff.delete(m.tabId); own(m.tabId); } else await release(m.tabId); send({ ok: true }); })(); return true;
    case 'release': release(m.tabId).then(() => send({ ok: true })); return true;
    case 'focus': chrome.tabs.get(m.tabId).then(async t => { await chrome.tabs.update(m.tabId, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); send({ ok: true }); }).catch(() => send({ ok: false })); return true;
    case 'revoke': state.siteAllow.clear(); state.permAllow.clear(); send({ ok: true }); return false;
    case 'audit': send(activity.filter(a => a.status !== 'running' && a.status !== 'held')); return false;
    case 'auditClear': activity.length = 0; chrome.storage.local.set({ audit: [] }); send({ ok: true }); return false;
  }
  return false;
});

// Takes a tab back from the agent: no longer shared, debugger detached, out of the Bridge group, pill removed.
async function release(tabId) {
  handsOff.set(tabId, Date.now() + 5 * 60000);
  owned.delete(tabId); saveRt(); badgeSeen.delete(tabId); paintBadge(tabId, false);
  try { await chrome.debugger.detach({ tabId }); } catch (e) {}
  state.tabs.delete(tabId);
  await unhighlight(tabId);
  notifyUi();
}

async function controlledTabs() {
  const out = [];
  for (const id of controlledIds()) {
    try {
      const t = await chrome.tabs.get(id);
      out.push({ id, title: t.title || '', host: hostOf(t.url || ''), owned: owned.has(id), attached: state.tabs.has(id), busy: running.has(id) || (badgeSeen.has(id) && Date.now() - badgeSeen.get(id).at < 8000), windowId: t.windowId });
    } catch (e) { owned.delete(id); }
  }
  return out.slice(0, 40);
}

async function snapshot() {
  await ready;
  let tab = null;
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (t) tab = { id: t.id, title: t.title, url: t.url, host: hostOf(t.url || ''), owned: isOwned(t.id), attached: state.tabs.has(t.id), web: /^https?:/i.test(t.url || '') };
  } catch (e) {}
  const live = activity.filter(a => a.status === 'running' || a.status === 'held');
  return {
    connected: state.connected, reason: state.reason, enabled: state.cfg.enabled, paused: rt.paused, step: rt.step, held: waiters.size,
    scope: state.cfg.scope, gate: state.cfg.gate, pill: !!state.cfg.pageBadge,
    perms: { read: state.cfg.perm_read, nav: state.cfg.perm_nav, input: state.cfg.perm_input, script: state.cfg.perm_script },
    attached: state.tabs.size, owned: owned.size, locked: [...state.captcha].filter(([, v]) => v.locked).length,
    approvals: [...state.siteAllow.values(), ...state.permAllow.values()].filter(t => t > Date.now()).length,
    clients: [...clients].filter(([, t]) => Date.now() - t < 10 * 60000).map(([n]) => n),
    live, recent: activity.filter(a => a.status !== 'running' && a.status !== 'held').slice(-40).reverse(), tab,
    controlled: await controlledTabs(),
    highlight: !!state.cfg.highlightTabs,
  };
}

connect();

// ---------- timeline listeners ----------

chrome.tabs.onCreated.addListener(t => {
  logEvent('tab_created', { tabId: t.id, url: t.pendingUrl || t.url || '', openerTabId: t.openerTabId || null });
  // A popup or new tab that an agent-driven page opened stays in scope, but only right after a command on its opener.
  // Tabs the person opens themselves never become agent tabs this way.
  if (t.openerTabId != null && isOwned(t.openerTabId) && Date.now() - (cmdAt.get(t.openerTabId) || 0) < 5000) own(t.id);
});
chrome.tabs.onRemoved.addListener(id => { logEvent('tab_closed', { tabId: id }); owned.delete(id); badgeSeen.delete(id); cmdAt.delete(id); tempJoined.delete(id); notifyUi(); state.tabs.delete(id); state.captcha.delete(id); state.alerts.delete('captcha:' + id); state.alerts.delete('dialog:' + id); });
chrome.tabs.onUpdated.addListener((id, ci, t) => {
  if (ci.status === 'complete') logEvent('tab_loaded', { tabId: id, url: t.url, title: t.title });
  else if (ci.url) logEvent('tab_navigated', { tabId: id, url: ci.url });
});
if (chrome.downloads) {
  chrome.downloads.onCreated.addListener(d => logEvent('download_started', { id: d.id, url: d.url, filename: d.filename }));
  chrome.downloads.onChanged.addListener(d => { if (d.state) logEvent('download_' + d.state.current, { id: d.id }); });
}

// ---------- safety ----------

const SAFE_INTERNAL = /^(chrome:\/\/(newtab|new-tab-page)\/?|chrome-error:\/\/chromewebdata\/?|edge:\/\/newtab\/?|about:blank)/i; // empty pages an agent may navigate away from
const normHost = h => String(h).toLowerCase().replace(/\.+$/, '');
const lines = v => String(v || '').split('\n').map(x => {
  x = x.trim().toLowerCase();
  if (!x) return '';
  try { return normHost(new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(x) ? x : 'http://' + x).hostname); } catch (e) { return normHost(x); }
}).filter(Boolean);
function isPrivateHost(h) {
  h = normHost(h).replace(/^\[|\]$/g, '');
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h === '::' || /^f[cd]/i.test(h) || /^fe[89ab]/i.test(h) || /^::ffff:/i.test(h);
  return false;
}
// Would an automated command be allowed to look at this URL at all? (used to keep blocked sites out of listings)
function urlVisible(url) { try { checkUrl(url); return true; } catch (e) { return false; } }
const blockedList = () => lines(state.cfg.blocked);
const allowedList = () => lines(state.cfg.allowed);
const hostIn = (host, list) => list.some(b => host === b || host.endsWith('.' + b));

// url: where a command wants to go (target) or where a tab already is (target false).
function checkUrl(url, { target = false } = {}) {
  if (url === 'about:blank') return;
  let u;
  try { u = new URL(url); } catch (e) { if (target) throw refuse('invalid URL'); return; }
  const web = u.protocol === 'http:' || u.protocol === 'https:';
  if (u.protocol === 'blob:') return checkUrl(u.pathname, { target }); // blob:https://site/id belongs to site
  if (u.protocol === 'chrome-extension:') throw refuse('Extension pages cannot be controlled.');
  if (!target && !web && u.protocol !== 'file:' && !SAFE_INTERNAL.test(url)) throw refuse('That kind of page cannot be controlled.'); // fail closed: view-source:, data:, devtools:, ...
  if (u.protocol === 'file:' && state.cfg.blockFiles) throw refuse('file:// pages are blocked. The person can allow them in the extension settings.');
  if (target && !web && u.protocol !== 'file:') throw refuse(`${u.protocol} URLs are not allowed; use http or https.`);
  const host = normHost(u.hostname);
  if (!host) return;
  const b = blockedList().find(x => host === x || host.endsWith('.' + x));
  if (b) throw refuse(`Blocked site (${b}). The person must remove it in the extension settings to allow it.`);
  const allowed = allowedList();
  if ((web || u.protocol === 'file:') && allowed.length && !hostIn(host, allowed)) throw refuse(`${host} is not on the allowed sites list. Ask the person to add it in the extension settings.`);
}

async function guard(tabId) {
  await ready;
  if (!state.cfg.enabled) throw refuse('Control is turned off in the extension.');
  if ((handsOff.get(tabId) || 0) > Date.now()) throw refuse('The person took this tab back from the agent. Ask them before using it again.');
  if (state.cfg.scope === 'own' && !isOwned(tabId)) {
    throw refuse('Scope is "agent tabs only": this tab was not opened by the bridge. Open your own tab, or ask the person to press "Share this tab" in the extension popup.');
  }
  const tab = await chrome.tabs.get(tabId);
  const here = tab.url || tab.pendingUrl || '';
  if (!here) throw refuse('The bridge cannot see this page (a browser page, the web store or a viewer), so it cannot be controlled.'); // unknown means off limits
  checkUrl(here);
  return tab;
}

const riskyRe = () => {
  const extra = String(state.cfg.riskyExtra || '').split(',').map(x => x.trim()).filter(Boolean).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('\\b(' + [RISKY_WORDS, ...extra].join('|') + ')\\b', 'i');
};

// Injected: detects a visible human-verification challenge. Never tries to solve it.
function detectCaptcha() {
  const kinds = [];
  const vis = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 30) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const re = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkoselabs|funcaptcha|geetest|captcha/i;
  for (const f of document.querySelectorAll('iframe')) {
    const s = (f.src || '') + ' ' + (f.title || '');
    if (re.test(s) && vis(f) && !f.closest('.grecaptcha-badge')) kinds.push('iframe:' + ((s.match(re) || [])[0] || 'captcha').toLowerCase());
  }
  for (const sel of ['.g-recaptcha', '.h-captcha', '.cf-turnstile', '#px-captcha', '[data-sitekey]']) {
    for (const e of document.querySelectorAll(sel)) {
      if (e.getAttribute('data-size') === 'invisible') continue;
      if (vis(e)) kinds.push('widget:' + sel);
    }
  }
  const title = document.title || '';
  const body = document.body ? document.body.innerText.slice(0, 1500) : '';
  const phrase = /verify (that )?you are (a )?human|are you a robot|unusual traffic|confirm you.re not a robot|complete the security check|checking if the site connection is secure/i;
  if (/^just a moment|^attention required/i.test(title) || (body.length < 2500 && phrase.test(body))) kinds.push('page-text');
  return { found: kinds.length > 0, kinds: [...new Set(kinds)] };
}

async function checkCaptcha(tabId) {
  let res;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: detectCaptcha });
    res = r.result;
  } catch (e) { return null; }
  const cs = state.captcha.get(tabId) || {};
  if (res && res.found) {
    if (cs.clearedUntil && Date.now() < cs.clearedUntil) return res;
    if (!cs.locked) {
      state.captcha.set(tabId, { ...cs, locked: true, kinds: res.kinds });
      state.alerts.set('captcha:' + tabId, `CAPTCHA or human check on tab ${tabId} (${res.kinds.join(', ')}). The tab is locked for input. Do not try to solve it: call ask_human so the person can.`);
      logEvent('captcha', { tabId, kinds: res.kinds });
    }
  } else if (cs.locked) {
    state.captcha.set(tabId, { ...cs, locked: false });
    state.alerts.delete('captcha:' + tabId);
    logEvent('captcha_cleared', { tabId });
  }
  return res;
}

// Guard for anything that changes a page: respects CAPTCHA locks and open human prompts.
async function mutGuard(tabId) {
  const tab = await guard(tabId);
  if (humanTabs.has(tabId)) throw new Error('A prompt for the person is open on this tab. Wait for their answer.');
  await checkCaptcha(tabId);
  const cs = state.captcha.get(tabId);
  if (cs && cs.locked) throw new Error('CAPTCHA on this tab, input is locked. Do not try to solve it. Call ask_human so the person can solve it, then continue.');
  return tab;
}

// ---------- human in the loop ----------

// Injected (isolated world): renders the prompt. Closed shadow root plus an isTrusted check mean page scripts
// cannot answer it; the click guard in this file stops automated clicks from reaching it too.
// Injected: is the prompt really on screen, in the top layer, unmoved and not covered by anything?
function promptVisible() {
  const h = (window.__cbb || {}).overlay;
  if (!h || !h.isConnected) return false;
  let top = true;
  try { top = h.matches(':popover-open'); } catch (e) {}
  const cs = getComputedStyle(h), r = h.getBoundingClientRect();
  if (!top || cs.display === 'none' || cs.visibility !== 'visible' || Number(cs.opacity) < 0.9 || cs.transform !== 'none' || (cs.clipPath && cs.clipPath !== 'none') || r.width < 100 || r.height < 40) return false;
  if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) return false;
  return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === h;
}
// Injected: label of the control that Enter would activate or submit (for the risky-click gate).
function focusLabel(spaceOnly) {
  const el = document.activeElement;
  if (!el || el === document.body) return '';
  const name = e => String((e && (e.getAttribute('aria-label') || e.innerText || e.value || e.title)) || '').trim().slice(0, 80);
  if (el.matches('button,a,[role=button],input[type=submit],input[type=button]')) return name(el);
  if (spaceOnly) return ''; // Space in a text field just types a space
  const f = el.form || el.closest('form');
  if (f) { const b = f.querySelector('button[type=submit],input[type=submit],button:not([type])'); if (b) return name(b); }
  return '';
}

function renderPrompt(o) {
  const g = (window.__cbb = window.__cbb || { n: 0 }); // lives in the extension's own world: the page cannot reach it
  // Inline !important styles beat any page stylesheet, and the top layer keeps page elements from covering the control.
  const pin = (el, props) => {
    const base = { all: 'initial', display: 'block', opacity: '1', visibility: 'visible', 'pointer-events': 'auto', transform: 'none', filter: 'none', 'clip-path': 'none', overflow: 'visible', 'mix-blend-mode': 'normal', contain: 'none', ...props };
    for (const [k, v] of Object.entries(base)) el.style.setProperty(k, v, 'important');
  };
  const topLayer = el => { try { el.setAttribute('popover', 'manual'); el.showPopover(); } catch (e) {} };
  if (g.overlay) g.overlay.remove();
  const born = performance.now();
  const host = document.createElement('div');
  host.id = '__cbb_overlay';
  g.overlay = host;
  pin(host, { position: 'fixed', top: '14px', right: '14px', left: 'auto', bottom: 'auto', margin: '0', 'z-index': '2147483647' });
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = '.box{font:14px/1.45 system-ui,sans-serif;background:#111;color:#fff;border-radius:10px;padding:14px 16px;width:320px;box-shadow:0 8px 30px rgba(0,0,0,.45);border:2px solid #f5b301}h{display:block;font-weight:700;margin-bottom:6px}p{margin:0 0 12px;white-space:pre-wrap}.b{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;background:#f5b301;color:#111;font-weight:600}button.d{background:#333;color:#fff}';
  const box = document.createElement('div');
  box.className = 'box';
  const h = document.createElement('h');
  h.textContent = o.title;
  const p = document.createElement('p');
  p.textContent = o.message;
  const row = document.createElement('div');
  row.className = 'b';
  o.buttons.forEach((label, i) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (i > 0 && /deny|cancel|stop/i.test(label)) b.className = 'd';
    b.tabIndex = -1; // automation can press Tab and Enter; it must not be able to reach these
    b.addEventListener('click', ev => {
      if (!ev.isTrusted || ev.detail < 1) return; // detail 0 means keyboard activation
      if (performance.now() - born < 600) return; // a stray click while the prompt pops up under the cursor must not approve
      chrome.runtime.sendMessage({ type: 'human', id: o.id, choice: label });
      host.remove();
    });
    row.appendChild(b);
  });
  box.append(h, p, row);
  root.append(style, box);
  document.documentElement.appendChild(host);
  topLayer(host);
}

function askHuman(tabId, opts) {
  const gen = stopGen;
  return enqueue('prompt' + tabId, () => (gen !== stopGen ? 'stopped' : askHumanNow(tabId, opts)));
}
async function askHumanNow(tabId, { message, title = 'Action needed', buttons = ['OK'], timeout_s = 300 }) {
  timeout_s = Math.min(Math.max(Number(timeout_s) || 300, 5), 300);
  message = String(message == null ? '' : message).replace(INVISIBLE, '').slice(0, 600);
  buttons = (Array.isArray(buttons) && buttons.length ? buttons : ['OK']).slice(0, 4).map(b => String(b).replace(INVISIBLE, '').slice(0, 40));
  const id = 'h' + ++humanSeq + Math.random().toString(36).slice(2, 7);
  const key = 'human:' + id;
  state.alerts.set(key, `Waiting for the person: ${message}`);
  humanTabs.add(tabId);
  logEvent('human_prompt', { tabId, message });
  try {
    const t = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true, drawAttention: true });
  } catch (e) {}
  try { chrome.notifications.create(id, { type: 'basic', iconUrl: ICON, title, message: message.slice(0, 200) }); } catch (e) {}

  const inject = () => chrome.scripting.executeScript({ target: { tabId }, func: renderPrompt, args: [{ id, title, message, buttons }] }).then(() => true).catch(() => false);
  const answered = new Promise(res => humanWaiters.set(id, res));
  const deadline = Date.now() + timeout_s * 1000;
  let choice = 'timeout';
  try {
    if (!(await inject())) choice = 'unavailable'; // chrome:// pages, the web store and viewers cannot show a prompt
    else while (Date.now() < deadline) {
      const r = await Promise.race([answered.then(v => ({ v })), sleep(1500).then(() => null)]);
      if (r) { choice = r.v; break; }
      try { // the page may have navigated and dropped the prompt
        const [x] = await chrome.scripting.executeScript({ target: { tabId }, func: promptVisible });
        if (!x.result) await inject(); // dropped by a navigation, removed or hidden by the page
      } catch (e) {}
    }
  } finally {
    humanWaiters.delete(id);
    humanTabs.delete(tabId);
    state.alerts.delete(key);
    try { chrome.notifications.clear(id); } catch (e) {}
    chrome.scripting.executeScript({ target: { tabId }, func: () => { const g = window.__cbb || {}; if (g.overlay) { g.overlay.remove(); g.overlay = null; } } }).catch(() => {});
    logEvent('human_answer', { tabId, choice });
  }
  return choice;
}

const RISKY_WORDS = 'post|publish|tweet|share|send|submit|reply|comment|delete|remove|buy|pay|purchase|order|checkout|confirm|subscribe|register|transfer|withdraw|donate|accept|agree|schedule|upload|place|sign out|log out|unsubscribe|cancel';

async function gateClick(tabId, info) {
  if (!state.cfg.gate || !info || !info.label || !riskyRe().test(info.label)) return false;
  const tab = await chrome.tabs.get(tabId);
  let host = '';
  try { host = new URL(tab.url).hostname; } catch (e) {}
  if ((state.siteAllow.get(host) || 0) > Date.now()) return false;
  const entry = running.get(tabId);
  notifyHeld(entry);
  const ans = await askHuman(tabId, {
    title: 'Approve this click?',
    message: `An automated session wants to click "${show(info.label, 120)}" on ${host || 'this page'}.`,
    buttons: ['Allow', 'Allow on this site for 10 min', 'Deny'],
    timeout_s: 300,
  });
  if (ans === 'Allow on this site for 10 min') { if (entry) await recheck(entry); await guard(tabId); state.siteAllow.set(host, Date.now() + 600000); return true; }
  if (ans !== 'Allow') throw refuse(`The person did not approve clicking "${info.label}" (${ans}).`);
  if (entry) await recheck(entry);
  await guard(tabId);
  return true;
}

// Pressing Enter or Space can activate a risky button, and Ctrl+V hands the person's clipboard to the page, so each key
// is judged on its own, right before it is pressed (earlier keys in the same call can move the focus).
async function gateKey(tabId, spec) {
  const parts = String(spec).toLowerCase().split('+');
  const last = parts.pop();
  const entry = running.get(tabId);
  if ((parts.some(m => ['ctrl', 'control', 'meta', 'cmd'].includes(m)) && last === 'v') || (parts.includes('shift') && last === 'insert')) {
    notifyHeld(entry);
    const ans = await askHuman(tabId, { title: 'Allow paste?', message: 'An automated session wants to paste YOUR CLIPBOARD into this page. The page and the agent can then read it.', buttons: ['Allow once', 'Deny'], timeout_s: 120 });
    if (ans !== 'Allow once') throw refuse('The person did not allow pasting their clipboard.');
    if (entry) await recheck(entry);
    await guard(tabId);
  }
  const isEnter = last === 'enter' || last === 'return', isSpace = last === 'space' || last === ' ';
  if (state.cfg.gate && (isEnter || isSpace)) {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: focusLabel, args: [isSpace] }).catch(() => [{}]);
    const label = r && r.result;
    if (label) await gateClick(tabId, { label });
  }
}

// ---------- on-page pill: shows the person which tab is automated, with Pause and Stop ----------

// Injected (isolated world). Closed shadow root; buttons only act on trusted clicks. Pass null to remove it.
function renderBadge(o) {
  const g = (window.__cbb = window.__cbb || { n: 0 });
  // Inline !important styles beat any page stylesheet, and the top layer keeps page elements from covering the control.
  const pin = (el, props) => {
    const base = { all: 'initial', display: 'block', opacity: '1', visibility: 'visible', 'pointer-events': 'auto', transform: 'none', filter: 'none', 'clip-path': 'none', overflow: 'visible', 'mix-blend-mode': 'normal', contain: 'none', ...props };
    for (const [k, v] of Object.entries(base)) el.style.setProperty(k, v, 'important');
  };
  const topLayer = el => { try { el.setAttribute('popover', 'manual'); el.showPopover(); } catch (e) {} };
  if (g.badge) { g.badge.remove(); g.badge = null; }
  if (!o) return;
  const host = document.createElement('div');
  host.id = '__cbb_badge';
  g.badge = host;
  pin(host, { position: 'fixed', top: '0', left: '0', right: '0', bottom: '0', margin: '0', width: 'auto', height: 'auto', 'z-index': '2147483646', 'pointer-events': 'none' });
  const root = host.attachShadow({ mode: 'closed' });
  const col = o.paused ? '#d97706' : '#1f9d55';
  const style = document.createElement('style');
  style.textContent = `.f{position:fixed;inset:0;border:2px solid ${col};opacity:.55;pointer-events:none}
  .p{position:fixed;left:14px;bottom:14px;display:flex;align-items:center;gap:10px;font:13px/1 system-ui,sans-serif;background:#111;color:#fff;border:1px solid #333;border-radius:999px;padding:7px 8px 7px 12px;box-shadow:0 6px 24px rgba(0,0,0,.4);pointer-events:auto}
  .d{width:8px;height:8px;border-radius:50%;background:${col}}
  button{font:inherit;font-weight:600;border:0;border-radius:999px;padding:6px 11px;cursor:pointer;background:#2a2a2a;color:#fff}button:hover{background:#3a3a3a}button.s{background:#7f1d1d}button.s:hover{background:#991b1b}`;
  const frame = document.createElement('div'); frame.className = 'f';
  const pill = document.createElement('div'); pill.className = 'p';
  const dot = document.createElement('span'); dot.className = 'd';
  const label = document.createElement('span'); label.textContent = o.paused ? 'Browser Bridge paused' : 'Browser Bridge is controlling this tab';
  const mk = (text, action, cls) => {
    const b = document.createElement('button'); b.textContent = text; if (cls) b.className = cls;
    b.tabIndex = -1;
    b.addEventListener('click', ev => { if (!ev.isTrusted || ev.detail < 1) return; chrome.runtime.sendMessage({ type: 'ctl', action }); });
    return b;
  };
  pill.append(dot, label, mk(o.paused ? 'Resume' : 'Pause', o.paused ? 'resume' : 'pause'), mk('Stop', 'stop', 's'));
  root.append(style, frame, pill);
  document.documentElement.appendChild(host);
  topLayer(host);
}

async function paintBadge(tabId, on) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (!/^https?:/i.test(t.url || '')) return;
    await chrome.scripting.executeScript({ target: { tabId }, func: renderBadge, args: [on ? { paused: rt.paused } : null] });
  } catch (e) {}
}
function touchBadge(tabId) {
  if (!state.cfg.pageBadge) { if (!badgeSeen.has(tabId)) { badgeSeen.set(tabId, { at: Date.now(), paused: rt.paused }); highlight(tabId, isOwned(tabId)); } else badgeSeen.get(tabId).at = Date.now(); return; }
  const seen = badgeSeen.get(tabId);
  const now = Date.now();
  if (seen && seen.paused === rt.paused && now - seen.at < 8000) { seen.at = now; return; }
  badgeSeen.set(tabId, { at: now, paused: rt.paused });
  paintBadge(tabId, true);
  highlight(tabId, isOwned(tabId));
}
function refreshBadges(removeAll) {
  for (const id of badgeSeen.keys()) {
    if (removeAll) { paintBadge(id, false); badgeSeen.delete(id); } else { badgeSeen.get(id).paused = rt.paused; paintBadge(id, true); }
  }
}
setInterval(async () => { // drop the pill from tabs that have gone quiet, and put it back where a page removed or hid it
  const now = Date.now();
  for (const [id, v] of [...badgeSeen]) {
    if (!rt.paused && now - v.at > 20000) { badgeSeen.delete(id); paintBadge(id, false); if (tempJoined.has(id)) unhighlight(id); continue; }
    try { const [r] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () => { const h = (window.__cbb || {}).badge; if (!h || !h.isConnected) return false; const c = getComputedStyle(h); return c.display !== 'none' && c.visibility === 'visible' && Number(c.opacity) > 0.9; } }); if (!r.result) paintBadge(id, true); } catch (e) {}
  }
}, 5000);

// ---------- debugger plumbing ----------

async function ensure(tabId) {
  const have = state.tabs.get(tabId);
  if (have) { have.last = Date.now(); return have; }
  if (attaching.has(tabId)) return attaching.get(tabId);
  const p = (async () => {
    try { await chrome.debugger.attach({ tabId }, '1.3'); }
    catch (e) { // a worker restart can leave our own attach behind
      if (!/already attached/i.test(String(e.message))) throw e;
      try { await chrome.debugger.detach({ tabId }); } catch (x) {}
      await chrome.debugger.attach({ tabId }, '1.3');
    }
    const t = { console: [], network: new Map(), last: Date.now(), mainFrame: null, doc: null };
    state.tabs.set(tabId, t); notifyUi();
    for (const d of ['Runtime.enable', 'Network.enable', 'Page.enable', 'Log.enable']) await chrome.debugger.sendCommand({ tabId }, d);
    // Background tabs behave as focused, so parallel tabs keep rendering and receiving input.
    try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
    try {
      const ft = await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree');
      t.mainFrame = ft.frameTree.frame.id;
    } catch (e) {}
    return t;
  })().finally(() => attaching.delete(tabId));
  attaching.set(tabId, p);
  return p;
}

const CDP_LIMIT_MS = 120000;
function stoppedCheck(tabId) { // a Stop that arrives mid-command must end it, not let it finish its remaining steps
  const e = running.get(tabId);
  if (e && e._ctx.gen !== stopGen) throw refuse('Stopped by the person. Do not retry; ask them what to do.');
  if (e && e._ctx.cancelled) throw refuse('The caller gave up waiting, so this was cancelled.');
}
async function cdp(tabId, method, params) {
  stoppedCheck(tabId);
  await guard(tabId);
  await ensure(tabId);
  stoppedCheck(tabId);
  let timer;
  return Promise.race([
    chrome.debugger.sendCommand({ tabId }, method, params || {}),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`the browser did not answer ${method} within ${CDP_LIMIT_MS / 1000}s`)), CDP_LIMIT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

chrome.debugger.onDetach.addListener(src => { state.tabs.delete(src.tabId); notifyUi(); state.alerts.delete('dialog:' + src.tabId); });

function pickHeaders(h) {
  const out = {};
  for (const k of Object.keys(h || {})) {
    const l = k.toLowerCase();
    if (['x-robots-tag', 'content-type', 'cache-control', 'content-encoding', 'server', 'link', 'location', 'strict-transport-security', 'content-security-policy'].includes(l)) out[l] = String(h[k]).slice(0, 300);
  }
  return out;
}

chrome.debugger.onEvent.addListener((src, method, p) => {
  const t = state.tabs.get(src.tabId);
  if (!t) return;
  const pushConsole = (level, text) => {
    t.console.push({ level, text: String(text).slice(0, 2000), ts: Date.now() });
    if (t.console.length > 500) t.console.shift();
  };
  switch (method) {
    case 'Runtime.consoleAPICalled':
      pushConsole(p.type, p.args.map(a => (a.value !== undefined ? (typeof a.value === 'object' ? JSON.stringify(a.value) : a.value) : a.description || a.type)).join(' '));
      break;
    case 'Runtime.exceptionThrown':
      pushConsole('exception', (p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text);
      break;
    case 'Log.entryAdded':
      pushConsole(p.entry.level, p.entry.text + (p.entry.url ? ' ' + p.entry.url : ''));
      break;
    case 'Network.requestWillBeSent':
      t.network.set(p.requestId, { url: p.request.url, method: p.request.method, type: p.type, ts: Date.now() });
      if (t.network.size > 1000) t.network.delete(t.network.keys().next().value);
      if (p.type === 'Document' && p.frameId === t.mainFrame) {
        if (!p.redirectResponse) t.doc = { url: p.request.url, redirects: [], status: null };
        else if (t.doc) t.doc.redirects.push({ url: p.redirectResponse.url, status: p.redirectResponse.status });
      }
      break;
    case 'Network.responseReceived': {
      const r = t.network.get(p.requestId);
      if (r) { r.status = p.response.status; r.mime = p.response.mimeType; }
      if (p.type === 'Document' && p.frameId === t.mainFrame && t.doc) {
        t.doc.status = p.response.status;
        t.doc.finalUrl = p.response.url;
        t.doc.headers = pickHeaders(p.response.headers);
        if (p.response.status >= 400) logEvent('http_error', { tabId: src.tabId, url: p.response.url, status: p.response.status });
      }
      break;
    }
    case 'Network.loadingFailed': {
      const r = t.network.get(p.requestId);
      if (r) r.error = p.errorText;
      break;
    }
    case 'Page.javascriptDialogOpening':
      state.alerts.set('dialog:' + src.tabId, `JavaScript ${p.type} dialog open on tab ${src.tabId}: "${String(p.message).slice(0, 200)}". The page is blocked until you call handle_dialog.`);
      logEvent('dialog', { tabId: src.tabId, kind: p.type, message: p.message });
      break;
    case 'Page.javascriptDialogClosed':
      state.alerts.delete('dialog:' + src.tabId);
      break;
  }
});

// ---------- in-page helpers ----------

const RESOLVE = `(ref)=>{const f=(root)=>{const e=root.querySelector('[data-cbb-ref="'+ref+'"]');if(e)return e;for(const h of root.querySelectorAll('*')){if(h.shadowRoot){const x=f(h.shadowRoot);if(x)return x;}if(h.tagName==='IFRAME'){try{const d=h.contentDocument;if(d){const x=f(d);if(x)return x;}}catch(e){}}}return null;};return f(document);}`;

async function evalIn(tabId, expression, opts = {}) {
  const limit = opts.limitMs || 60000;
  const { limitMs, ...cdpOpts } = opts;
  let timer;
  const r = await Promise.race([
    cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: limit - 5000, ...cdpOpts }),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`evaluation timed out after ${limit / 1000}s`)), limit); }),
  ]).finally(() => clearTimeout(timer));
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || 'evaluation failed');
  }
  return r.result;
}

// Scrolls the element into view and returns its centre in top-level viewport coordinates (through same-origin iframes).
async function centerOf(tabId, ref) {
  const r = await evalIn(tabId, `(()=>{const el=(${RESOLVE})(${JSON.stringify(ref)});if(!el)return{error:'ref not found: '+${JSON.stringify(ref)}+'. Run read_page again.'};el.scrollIntoView({block:'center',inline:'center'});
    const r=el.getBoundingClientRect();let x=r.left+r.width/2,y=r.top+r.height/2;let w=el.ownerDocument.defaultView;
    while(w&&w!==w.top){const fe=w.frameElement;if(!fe)break;const fr=fe.getBoundingClientRect();x+=fr.left;y+=fr.top;w=w.parent;}
    const b=el.closest('button,a,[role=button],[role=menuitem],input[type=submit],input[type=button]');const c=b||el;
    let l=String(c.getAttribute('aria-label')||c.innerText||c.value||c.title||'').trim();l=b?l.slice(0,80):(l.length>100?'':l);
    return{x:Math.round(x),y:Math.round(y),id:el.id,tag:el.tagName,type:el.type||'',label:l};})()`);
  if (r.value.error) throw new Error(r.value.error);
  return r.value;
}

// What would a click at x,y hit? (through same-origin iframes)
async function describeAt(tabId, x, y) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (x, y) => { // runs in the extension's own world, so the page cannot lie about what is under the point
      const g = window.__cbb || {};
      let el = document.elementFromPoint(x, y);
      if (el && (el === g.overlay || el === g.badge)) return { id: el.id, control: true, label: '' };
      while (el && el.tagName === 'IFRAME') {
        try { const dd = el.contentDocument; if (!dd) break; const fr = el.getBoundingClientRect(); x -= fr.left; y -= fr.top; const e2 = dd.elementFromPoint(x, y); if (!e2) break; el = e2; } catch (e) { break; }
      }
      if (!el) return null;
      const btn = el.closest('button,a,[role=button],[role=menuitem],input[type=submit],input[type=button]');
      const c = btn || el;
      let label = String(c.getAttribute('aria-label') || c.innerText || c.value || c.title || '').trim();
      label = btn ? label.slice(0, 80) : (label.length > 100 ? '' : label); // a click on page background must not read the whole page as its label
      return { id: el.id, control: el === g.overlay || el === g.badge, tag: el.tagName, type: el.type || '', label };
    },
    args: [Number(x), Number(y)],
  });
  return r.result;
}
const isControl = id => id === '__cbb_overlay' || id === '__cbb_badge';
const isCtl = o => !!o && (o.control === true || isControl(o.id));

async function viewport(tabId) {
  const r = await evalIn(tabId, '({w:innerWidth,h:innerHeight})');
  return r.value;
}

// Injected into the page; must be self-contained. Walks shadow roots and same-origin iframes.
function pageSnapshot(opts) {
  const { filter, query, maxChars } = opts;
  const g = (window.__cbb = window.__cbb || { n: 0 });
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=menuitem],[role=menuitemradio],[role=tab],[role=textbox],[role=combobox],[role=switch],[role=option],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
  const q = query ? query.toLowerCase() : '';
  const out = [];
  let len = 0;
  let full = false;
  const vis = el => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return null;
    return r;
  };
  const nameOf = el => String(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.placeholder || el.alt || el.title || (el.innerText || '').trim() || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const roleOf = el => el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: (el.type || 'text') + ' input', SELECT: 'select', TEXTAREA: 'textarea', SUMMARY: 'summary' })[el.tagName] || el.tagName.toLowerCase();
  const walk = (root, depth) => {
    for (const el of root.children) {
      if (full) return;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;
      if (el.id === '__cbb_overlay' || el.id === '__cbb_badge') continue;
      const r = vis(el);
      let shown = false;
      if (r) {
        const isI = el.matches(INTERACTIVE);
        const isT = filter === 'all' && /^(H[1-6]|P|LI|LABEL|TD|TH|IMG)$/.test(el.tagName);
        if (isI || isT) {
          const name = nameOf(el);
          const role = roleOf(el);
          if ((isI || name) && (!q || (role + ' ' + name).toLowerCase().includes(q))) {
            if (!el.dataset.cbbRef) el.dataset.cbbRef = 'ref_' + ++g.n;
            let extra = '';
            if (el.href) extra += ' href=' + el.href.slice(0, 120);
            if (el.value && el.tagName !== 'BUTTON') extra += ' value="' + String(el.value).slice(0, 60) + '"';
            if (el.checked) extra += ' checked';
            if (el.disabled) extra += ' disabled';
            if (r.bottom < 0 || r.top > innerHeight) extra += ' (offscreen)';
            const line = '  '.repeat(Math.min(depth, 6)) + '[' + el.dataset.cbbRef + '] ' + role + ' "' + name + '"' + extra;
            len += line.length + 1;
            if (len > maxChars) { out.push('... truncated, narrow with query'); full = true; return; }
            out.push(line);
            shown = true;
          }
        }
      }
      const d = depth + (shown ? 1 : 0);
      walk(el, d);
      if (el.shadowRoot) walk(el.shadowRoot, d);
      if (el.tagName === 'IFRAME') {
        try { if (el.contentDocument && el.contentDocument.body) { out.push('  '.repeat(Math.min(d, 6)) + '(iframe ' + (el.src || el.name || '').slice(0, 80) + ')'); walk(el.contentDocument.body, d + 1); } } catch (e) {}
      }
    }
  };
  walk(document.body || document.documentElement, 0);
  return { url: location.href, title: document.title, viewport: { w: innerWidth, h: innerHeight }, scrollY: Math.round(scrollY), text: out.join('\n') };
}

// Injected: on-page SEO facts.
function seoSnapshot() {
  const q = s => document.querySelector(s);
  const attr = (s, a) => { const e = q(s); return e ? e.getAttribute(a) : null; };
  const metaByName = n => attr(`meta[name="${n}" i]`, 'content');
  const origin = location.origin;
  const host = location.hostname;
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => ({ level: Number(h.tagName[1]), text: h.innerText.trim().slice(0, 120) }));
  const imgs = [...document.images];
  const links = [...document.links].filter(a => /^https?:/i.test(a.href));
  const internal = links.filter(a => a.hostname === host || a.hostname.endsWith('.' + host.replace(/^www\./, '')));
  const jsonld = [];
  const ldErrors = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.textContent);
      const walk = n => { if (!n) return; if (Array.isArray(n)) return n.forEach(walk); if (typeof n === 'object') { if (n['@type']) jsonld.push([].concat(n['@type']).join('/')); if (n['@graph']) walk(n['@graph']); } };
      walk(j);
    } catch (e) { ldErrors.push(String(e.message).slice(0, 80)); }
  }
  const og = {};
  document.querySelectorAll('meta[property^="og:"],meta[name^="twitter:"]').forEach(m => { og[m.getAttribute('property') || m.getAttribute('name')] = (m.content || '').slice(0, 200); });
  const title = document.title || '';
  const desc = metaByName('description');
  const canonical = attr('link[rel="canonical" i]', 'href');
  const robots = metaByName('robots');
  const words = (document.body ? document.body.innerText : '').trim().split(/\s+/).filter(Boolean).length;
  const nav = performance.getEntriesByType('navigation')[0];
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  const mixed = location.protocol === 'https:' ? [...document.querySelectorAll('img[src^="http:"],script[src^="http:"],link[href^="http:"][rel=stylesheet],iframe[src^="http:"]')].length : 0;
  const h1s = headings.filter(h => h.level === 1);
  const dupHeadings = headings.length - new Set(headings.map(h => h.text.toLowerCase())).size;
  const issues = [];
  if (!title) issues.push('missing <title>');
  else if (title.length > 60) issues.push(`title long (${title.length} chars, aim under 60)`);
  else if (title.length < 20) issues.push(`title short (${title.length} chars)`);
  if (!desc) issues.push('missing meta description');
  else if (desc.length > 160) issues.push(`meta description long (${desc.length})`);
  else if (desc.length < 70) issues.push(`meta description short (${desc.length})`);
  if (h1s.length === 0) issues.push('no <h1>');
  if (h1s.length > 1) issues.push(`${h1s.length} <h1> elements`);
  const noAlt = imgs.filter(i => !i.hasAttribute('alt')).length;
  if (noAlt) issues.push(`${noAlt} images without alt attribute`);
  if (!canonical) issues.push('no canonical link');
  else if (canonical.replace(/\/$/, '') !== location.href.split('#')[0].replace(/\/$/, '')) issues.push('canonical differs from URL: ' + canonical);
  if (!attr('meta[name="viewport"]', 'content')) issues.push('no viewport meta');
  if (!document.documentElement.lang) issues.push('no html lang');
  if (robots && /noindex/i.test(robots)) issues.push('meta robots has noindex');
  if (!og['og:title'] || !og['og:image']) issues.push('Open Graph title or image missing');
  if (!jsonld.length) issues.push('no JSON-LD structured data');
  if (ldErrors.length) issues.push('invalid JSON-LD: ' + ldErrors.join('; '));
  if (mixed) issues.push(`${mixed} insecure http resources on an https page`);
  if (words < 250) issues.push(`thin content (${words} words)`);
  if (dupHeadings) issues.push(`${dupHeadings} duplicate headings`);
  return {
    url: location.href, origin, title, titleLength: title.length, description: desc, descriptionLength: desc ? desc.length : 0,
    canonical, robotsMeta: robots, googlebotMeta: metaByName('googlebot'), lang: document.documentElement.lang || null,
    viewport: attr('meta[name="viewport"]', 'content'), charset: document.characterSet,
    hreflang: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map(l => ({ lang: l.hreflang, href: l.href })),
    headings, h1Count: h1s.length, wordCount: words,
    images: { total: imgs.length, withoutAlt: noAlt, emptyAlt: imgs.filter(i => i.getAttribute('alt') === '').length, lazy: imgs.filter(i => i.loading === 'lazy').length },
    links: { total: links.length, internal: internal.length, external: links.length - internal.length, nofollow: links.filter(a => /nofollow/i.test(a.rel)).length, emptyAnchor: links.filter(a => !(a.innerText || a.getAttribute('aria-label') || a.querySelector('img[alt]')).toString().trim()).length },
    openGraph: og, structuredData: [...new Set(jsonld)], structuredDataErrors: ldErrors,
    timing: nav ? { ttfbMs: Math.round(nav.responseStart), domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd), loadMs: Math.round(nav.loadEventEnd), transferKB: Math.round(nav.transferSize / 1024), fcpMs: fcp ? Math.round(fcp.startTime) : null } : null,
    issues,
  };
}

// ---------- key handling ----------

const KEYS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }, return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 }, escape: { key: 'Escape', code: 'Escape', vk: 27 }, esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 }, delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 }, arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }, arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 }, end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 }, pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};
const CMDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

async function pressKey(tabId, spec) {
  const parts = spec.split('+');
  const k = parts.pop();
  let mods = 0;
  for (const m of parts.map(s => s.toLowerCase())) {
    if (m === 'alt') mods |= 1;
    else if (m === 'ctrl' || m === 'control') mods |= 2;
    else if (m === 'meta' || m === 'cmd') mods |= 4;
    else if (m === 'shift') mods |= 8;
    else throw new Error('unknown modifier ' + m);
  }
  let def = KEYS[k.toLowerCase()];
  if (!def) {
    if (k.length !== 1) throw new Error('unknown key ' + k);
    const up = k.toUpperCase();
    def = { key: k, code: /[a-z]/i.test(k) ? 'Key' + up : /\d/.test(k) ? 'Digit' + k : '', vk: up.charCodeAt(0), text: k };
  }
  const printable = !(mods & 7);
  const text = printable ? def.text : undefined;
  const base = { modifiers: mods, key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk };
  const down = { type: text ? 'keyDown' : 'rawKeyDown', ...base };
  if (text) down.text = text;
  if (mods & 2 && CMDS[k.toLowerCase()]) down.commands = [CMDS[k.toLowerCase()]];
  await cdp(tabId, 'Input.dispatchKeyEvent', down);
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function mouse(tabId, type, x, y, extra = {}) {
  return cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, ...extra });
}

async function waitLoad(tabId, timeout = 30000) {
  await sleep(400);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return;
    await sleep(250);
  }
}

// Background fetch (host permission bypasses CORS; cookies are not sent).
async function fetchInfo(url, { method = 'GET', maxChars = 20000, timeout = 20000, headers } = {}) {
  try { checkUrl(url, { target: true }); } catch (e) { return { url, status: 0, error: e.message, ms: 0 }; }
  const privateNote = 'Refused: that address is on your own machine or network. Turn on "Allow local network checks" in settings if you want this.';
  try { if (!state.cfg.allowPrivate && isPrivateHost(new URL(url).hostname)) return { url, status: 0, error: privateNote, ms: 0 }; } catch (e) {}
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method, redirect: 'follow', credentials: 'omit', signal: ctl.signal, headers });
    try { // a public address that redirects inward must not leak the answer
      const fin = new URL(r.url);
      if (!state.cfg.allowPrivate && isPrivateHost(fin.hostname)) return { url, status: 0, error: privateNote, ms: Date.now() - t0 };
      checkUrl(r.url, { target: true });
    } catch (e) { return { url, status: 0, error: e.message, ms: Date.now() - t0 }; }
    let body = '';
    if (method === 'GET' && maxChars > 0) body = (await r.text()).slice(0, maxChars);
    return { url, status: r.status, finalUrl: r.url, redirected: r.redirected, ms: Date.now() - t0, headers: pickHeaders(Object.fromEntries(r.headers.entries())), body };
  } catch (e) {
    return { url, status: 0, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e), ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// ---------- command handlers ----------

const HANDLERS = {
  async status() {
    const c = state.cfg;
    return {
      connected: true, version: chrome.runtime.getManifest().version, paused: rt.paused, held: waiters.size,
      scope: c.scope, permissions: { read: c.perm_read, navigate: c.perm_nav, input: c.perm_input, script: c.perm_script },
      approveRiskyClicks: !!c.gate, blocked: blockedList(), allowedOnly: allowedList(), rateLimitPerMin: Number(c.rateLimit) || 0,
      attachedTabs: [...state.tabs.keys()], ownedTabs: c.scope === 'own' ? [...owned] : undefined,
      alerts: [...state.alerts.values()], lockedTabs: [...state.captcha].filter(([, v]) => v.locked).map(([k]) => k),
    };
  },

  async reload_extension() {
    setTimeout(() => chrome.runtime.reload(), 300);
    return 'reloading; the connection returns in a few seconds';
  },

  // ----- tabs and windows -----

  async tabs_list() {
    if (!state.cfg.enabled) throw refuse('Control is turned off in the extension.');
    let tabs = await chrome.tabs.query({});
    if (state.cfg.scope === 'own') tabs = tabs.filter(t => isOwned(t.id));
    tabs = tabs.filter(t => urlVisible(t.url || t.pendingUrl || ''));
    return tabs.map(t => ({ tabId: t.id, windowId: t.windowId, active: t.active, groupId: t.groupId, title: t.title, url: t.url, audible: t.audible || false }));
  },

  async windows_list() {
    let ws = await chrome.windows.getAll({ populate: true });
    if (state.cfg.scope === 'own') { ws = ws.map(w => ({ ...w, tabs: w.tabs.filter(t => isOwned(t.id)) })).filter(w => w.tabs.length); }
    ws = ws.map(w => ({ ...w, tabs: w.tabs.filter(t => urlVisible(t.url || t.pendingUrl || '')) }));
    return ws.map(w => ({ windowId: w.id, focused: w.focused, state: w.state, type: w.type, incognito: w.incognito, width: w.width, height: w.height, tabs: w.tabs.map(t => ({ tabId: t.id, active: t.active, title: t.title, url: t.url })) }));
  },

  async window_create({ url, width, height, focused = false, state: st }) {
    if (!state.cfg.enabled) throw refuse('Control is turned off in the extension.');
    if (url) checkUrl(url, { target: true });
    const w = await chrome.windows.create({ url: url || 'about:blank', width, height, focused, state: st });
    (w.tabs || []).forEach(t => own(t.id));
    return { windowId: w.id, tabId: w.tabs && w.tabs[0] && w.tabs[0].id };
  },

  async window_close({ windowId }) {
    await ready;
    if (!state.cfg.enabled) throw refuse('Control is turned off in the extension.');
    const w = await chrome.windows.get(windowId, { populate: true });
    for (const t of w.tabs || []) {
      if (state.cfg.scope === 'own' && !isOwned(t.id)) throw refuse('Scope is "agent tabs only": that window holds a tab the bridge did not open.');
      checkUrl(t.url || t.pendingUrl || '');
    }
    await chrome.windows.remove(windowId);
    return 'closed';
  },

  async tab_create({ url, active = true, windowId }) {
    if (!state.cfg.enabled) throw refuse('Control is turned off in the extension.');
    if (url) checkUrl(url, { target: true });
    const t = await chrome.tabs.create({ url: url || 'about:blank', active, windowId });
    own(t.id);
    if (url) await waitLoad(t.id);
    return { tabId: t.id };
  },

  // Opens many tabs in parallel (background by default) and waits for each to load.
  async tabs_open_many({ urls, windowId, active = false }) {
    if (!state.cfg.enabled) throw refuse('Control is turned off in the extension.');
    urls.forEach(u => checkUrl(u, { target: true }));
    const opened = await Promise.all(urls.map(url => chrome.tabs.create({ url, active, windowId })));
    opened.forEach(t => own(t.id));
    await Promise.all(opened.map(t => waitLoad(t.id).catch(() => {})));
    const now = await Promise.all(opened.map(t => chrome.tabs.get(t.id)));
    return now.map(t => ({ tabId: t.id, url: t.url, title: t.title }));
  },

  async tab_duplicate({ tabId }) {
    await guard(tabId);
    const t = await chrome.tabs.duplicate(tabId);
    own(t.id);
    return { tabId: t.id };
  },

  async group_tabs({ tabIds, title, color }) {
    for (const id of tabIds) await guard(id);
    const groupId = await chrome.tabs.group({ tabIds });
    const upd = {};
    if (title) upd.title = title;
    if (color) upd.color = color;
    if (tabIds.some(isOwned)) { upd.title = 'Bridge · ' + (title || 'group'); upd.color = 'purple'; } // keep agent tabs recognisable
    if (Object.keys(upd).length) await chrome.tabGroups.update(groupId, upd);
    return { groupId };
  },

  async tab_close({ tabId }) {
    await guard(tabId);
    await chrome.tabs.remove(tabId);
    return 'closed';
  },

  async tab_activate({ tabId }) {
    const t = await guard(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return 'activated';
  },

  async navigate({ tabId, url }) {
    await guard(tabId);
    if (url === 'back') await chrome.tabs.goBack(tabId);
    else if (url === 'forward') await chrome.tabs.goForward(tabId);
    else if (url === 'reload') await chrome.tabs.reload(tabId);
    else {
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^(about|javascript|data|file|chrome|chrome-extension|view-source|blob|mailto):/i.test(url)) url = 'https://' + url;
      checkUrl(url, { target: true });
      await chrome.tabs.update(tabId, { url });
    }
    await waitLoad(tabId);
    try { checkUrl((await chrome.tabs.get(tabId)).url || ''); } catch (e) { // a redirect, Back or Forward landed somewhere that is off limits
      await chrome.tabs.update(tabId, { url: 'about:blank' }).catch(() => {});
      throw refuse('The page ended up somewhere that is not allowed, so the tab was reset. ' + e.message);
    }
    state.captcha.delete(tabId);
    state.alerts.delete('captcha:' + tabId);
    await checkCaptcha(tabId);
    const t = await chrome.tabs.get(tabId);
    const st = state.tabs.get(tabId);
    return { url: t.url, title: t.title, status: st && st.doc ? st.doc.status : undefined };
  },

  // ----- reading -----

  async read_page({ tabId, filter = 'interactive', query = '', max_chars = 40000 }) {
    await guard(tabId);
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageSnapshot, args: [{ filter, query, maxChars: max_chars }] });
    checkCaptcha(tabId).catch(() => {});
    return r.result;
  },

  async get_text({ tabId, max_chars = 40000 }) {
    await guard(tabId);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: n => ({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, n) }),
      args: [max_chars],
    });
    checkCaptcha(tabId).catch(() => {});
    return r.result;
  },

  async get_links({ tabId, scope = 'all', limit = 500 }) {
    await guard(tabId);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (scope, limit) => {
        const host = location.hostname;
        return [...document.links].filter(a => /^https?:/i.test(a.href)).map(a => ({ href: a.href.split('#')[0], text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80), rel: a.rel || '', internal: a.hostname === host })).filter(l => scope === 'all' || (scope === 'internal') === l.internal).slice(0, limit);
      },
      args: [scope, limit],
    });
    return r.result;
  },

  async screenshot({ tabId, full_page = false, ref }) {
    await guard(tabId);
    const hide = v => evalIn(tabId, `(()=>{for(const id of ['__cbb_badge','__cbb_overlay']){const h=document.getElementById(id);if(h&&${v?'true':'false'})h.style.display='none';else if(h)h.style.display='';}})()`).catch(() => {});
    await hide(true); // keep the control pill out of the picture
    try {
      const m = await cdp(tabId, 'Page.getLayoutMetrics');
      const vp = m.cssVisualViewport;
      let clip = full_page
        ? { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 12000), scale: 1 }
        : { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: 1 };
      let what = `viewport ${Math.round(vp.clientWidth)}x${Math.round(vp.clientHeight)} CSS px; click x/y use this same coordinate space`;
      if (ref) {
        const r = await evalIn(tabId, `(()=>{const el=(${RESOLVE})(${JSON.stringify(ref)});if(!el)return null;el.scrollIntoView({block:'center',inline:'center'});const b=el.getBoundingClientRect();return{x:b.left+scrollX,y:b.top+scrollY,w:b.width,h:b.height};})()`);
        if (!r.value) throw new Error('ref not found: ' + ref + '. Run read_page again.');
        clip = { x: Math.max(0, r.value.x), y: Math.max(0, r.value.y), width: Math.max(1, Math.min(r.value.w, 4000)), height: Math.max(1, Math.min(r.value.h, 4000)), scale: 1 };
        what = `element ${ref}, ${Math.round(clip.width)}x${Math.round(clip.height)} CSS px`;
      }
      const r = await cdp(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 75, clip, captureBeyondViewport: full_page || !!ref });
      return { image: r.data, mime: 'image/jpeg', text: `tab ${tabId}: ${what}` };
    } finally { await hide(false); }
  },

  // Structured read: rows of a table, or text and chosen attributes of every element matching a selector.
  async extract({ tabId, selector, attrs = [], limit = 200 }) {
    await guard(tabId);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector, attrs, limit) => {
        let els;
        try { els = [...document.querySelectorAll(selector)]; } catch (e) { return { error: 'invalid selector: ' + e.message }; }
        const clean = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 400);
        if (els.length && els.every(e => e.tagName === 'TABLE')) {
          return { tables: els.slice(0, 5).map(t => {
            const rows = [...t.rows].map(tr => [...tr.cells].map(c => clean(c.innerText)));
            const head = t.tHead && t.tHead.rows[0] ? [...t.tHead.rows[0].cells].map(c => clean(c.innerText)) : null;
            return { headers: head, rows: rows.slice(head ? 1 : 0, limit + (head ? 1 : 0)), rowCount: rows.length };
          }) };
        }
        return { count: els.length, items: els.slice(0, limit).map(e => {
          const o = { text: clean(e.innerText || e.textContent) };
          if (e.href) o.href = e.href;
          if (e.src) o.src = e.src;
          if (e.value !== undefined && e.value !== '') o.value = String(e.value).slice(0, 200);
          for (const a of attrs) { const v = e.getAttribute(a); if (v != null) o[a] = v.slice(0, 300); }
          return o;
        }) };
      },
      args: [selector, attrs, limit],
    });
    if (r.result && r.result.error) throw new Error(r.result.error);
    return r.result;
  },

  async emulate({ tabId, width, height, scale, mobile, user_agent, reset }) {
    await guard(tabId);
    if (reset) {
      await cdp(tabId, 'Emulation.clearDeviceMetricsOverride');
      await cdp(tabId, 'Emulation.setUserAgentOverride', { userAgent: '' });
      return 'emulation reset';
    }
    if (width || height) await cdp(tabId, 'Emulation.setDeviceMetricsOverride', { width: width || 0, height: height || 0, deviceScaleFactor: scale || 0, mobile: !!mobile });
    if (user_agent) await cdp(tabId, 'Emulation.setUserAgentOverride', { userAgent: user_agent });
    return 'emulation applied; reload the page if it looks unchanged';
  },

  // ----- input -----

  async click({ tabId, ref, x, y, button = 'left', count = 1 }) {
    await mutGuard(tabId);
    const resolve = async () => {
      let p;
      if (ref) p = await centerOf(tabId, ref);
      else if (typeof x === 'number' && typeof y === 'number') p = { x, y };
      else throw new Error('give either ref or x and y');
      const hit = await describeAt(tabId, p.x, p.y); // what a click at this point would really hit
      if (isCtl(p) || isCtl(hit)) throw refuse('That is a control for the person. Only they can click it.');
      const risky = [p.label, hit && hit.label].find(l => l && riskyRe().test(l));
      return { ...(hit || {}), ...p, label: risky || p.label || (hit && hit.label) || '' };
    };
    let p = await resolve();
    if (await gateClick(tabId, p)) { // the person took a while to answer: make sure the page did not change what is under the click
      const q = await resolve();
      if (q.label !== p.label || Math.abs(q.x - p.x) > 6 || Math.abs(q.y - p.y) > 6) throw refuse('The page changed while waiting for approval. Look again and retry.');
      p = q;
    }
    const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
    await mouse(tabId, 'mouseMoved', p.x, p.y);
    for (let i = 1; i <= count; i++) {
      await mouse(tabId, 'mousePressed', p.x, p.y, { button, clickCount: i, buttons });
      await mouse(tabId, 'mouseReleased', p.x, p.y, { button, clickCount: i });
    }
    setTimeout(() => checkCaptcha(tabId).catch(() => {}), 1000);
    return `clicked ${p.label ? '"' + p.label + '" ' : ''}at ${p.x},${p.y}`;
  },

  async hover({ tabId, ref, x, y }) {
    await guard(tabId);
    const p = ref ? await centerOf(tabId, ref) : { x, y };
    if (typeof p.x !== 'number') throw new Error('give either ref or x and y');
    await mouse(tabId, 'mouseMoved', p.x, p.y);
    return `hovered at ${p.x},${p.y}`;
  },

  async drag({ tabId, from_x, from_y, to_x, to_y }) {
    await mutGuard(tabId);
    for (const [px, py] of [[from_x, from_y], [to_x, to_y]]) {
      const d = await describeAt(tabId, px, py);
      if (isCtl(d)) throw refuse('That is a control for the person. Only they can click it.');
    }
    await mouse(tabId, 'mouseMoved', from_x, from_y);
    await mouse(tabId, 'mousePressed', from_x, from_y, { button: 'left', clickCount: 1, buttons: 1 });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await mouse(tabId, 'mouseMoved', from_x + ((to_x - from_x) * i) / steps, from_y + ((to_y - from_y) * i) / steps, { buttons: 1 });
    }
    await mouse(tabId, 'mouseReleased', to_x, to_y, { button: 'left', clickCount: 1 });
    return 'dragged';
  },

  async type({ tabId, text, ref }) {
    await mutGuard(tabId);
    if (ref) await HANDLERS.click({ tabId, ref });
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await cdp(tabId, 'Input.insertText', { text: lines[i] });
      if (i < lines.length - 1) await pressKey(tabId, 'shift+Enter');
    }
    return `typed ${String(text).length} chars`;
  },

  async key({ tabId, keys }) {
    await mutGuard(tabId);
    for (const k of String(keys).split(/\s+/).filter(Boolean)) { await gateKey(tabId, k); await pressKey(tabId, k); }
    setTimeout(() => checkCaptcha(tabId).catch(() => {}), 1000);
    return 'pressed ' + keys;
  },

  async scroll({ tabId, direction = 'down', amount = 600, ref, x, y }) {
    await guard(tabId);
    let p;
    if (ref && direction === 'to') {
      p = await centerOf(tabId, ref);
      return `scrolled to ${p.x},${p.y}`;
    }
    if (ref) p = await centerOf(tabId, ref);
    else if (typeof x === 'number' && typeof y === 'number') p = { x, y };
    else { const v = await viewport(tabId); p = { x: Math.round(v.w / 2), y: Math.round(v.h / 2) }; }
    const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    await mouse(tabId, 'mouseWheel', p.x, p.y, { deltaX: dx, deltaY: dy });
    return `scrolled ${direction} ${amount}`;
  },

  async form_input({ tabId, ref, value }) {
    await mutGuard(tabId);
    const r = await evalIn(tabId, `(()=>{const el=(${RESOLVE})(${JSON.stringify(ref)});if(!el)return'ref not found';el.scrollIntoView({block:'center'});const v=${JSON.stringify(value)};
      if(el.tagName==='SELECT'){const o=[...el.options].find(o=>o.value===String(v)||o.text.trim()===String(v));if(!o)return'no such option';el.value=o.value;}
      else if(el.type==='checkbox'||el.type==='radio'){el.checked=(v===true||v==='true'||v===1);}
      else if(el.isContentEditable){el.focus();document.execCommand('selectAll');document.execCommand('insertText',false,String(v));return'ok';}
      else{el.focus();const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');d&&d.set?d.set.call(el,String(v)):el.value=String(v);}
      el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return'ok';})()`);
    if (r.value !== 'ok') throw new Error(r.value);
    return 'ok';
  },

  async fill_form({ tabId, fields }) {
    const out = [];
    for (const f of fields) {
      try { await HANDLERS.form_input({ tabId, ref: f.ref, value: f.value }); out.push({ ref: f.ref, ok: true }); }
      catch (e) { out.push({ ref: f.ref, ok: false, error: e.message }); }
    }
    return out;
  },

  async eval_js({ tabId, expression }) {
    await mutGuard(tabId);
    const r = await evalIn(tabId, expression);
    return r.value !== undefined ? r.value : r.description || String(r.type);
  },

  async upload_file({ tabId, ref, paths }) {
    await mutGuard(tabId);
    for (const raw of paths) {
      const norm = String(raw).replace(/\\/g, '/');
      if (!/^(\/|[a-z]:\/)/i.test(norm) || norm.startsWith('//') || norm.split('/').includes('..')) throw refuse('upload_file needs local absolute paths without ".." (network shares are refused).');
      if (/(^|\/)(\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.browser-bridge|\.password-store|\.mozilla|\.config\/(gcloud|gh|google-chrome|chromium|BraveSoftware|microsoft-edge)|\.local\/share\/keyrings|Library\/Keychains|AppData\/(Local|Roaming)\/(Google|Microsoft|Mozilla))(\/|$)|^\/(proc|sys|etc\/(shadow|sudoers))(\/|$)/i.test(norm) || /(^|\/)(id_rsa|id_ed25519|id_ecdsa|\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials|credentials\.json|Login Data|Cookies|Web Data|key[34]\.db|logins\.json|\.(bash|zsh)_history|\.history|[^/]+\.(pem|key|p12|pfx|kdbx|gpg|asc|ovpn))$/i.test(norm) || /(^|\/)(Library\/Application Support|\.local\/share\/(wallets|keyrings)|wallet\.dat)(\/|$)/i.test(norm)) throw refuse('Refused: that path looks like a secret or credential file.');
    }
    const r = await cdp(tabId, 'Runtime.evaluate', { expression: `(${RESOLVE})(${JSON.stringify(ref)})` });
    if (!r.result.objectId) throw new Error('ref not found; run read_page again');
    await cdp(tabId, 'DOM.setFileInputFiles', { files: paths, objectId: r.result.objectId });
    return 'files set';
  },

  async handle_dialog({ tabId, accept = true, text }) {
    await guard(tabId);
    await ensure(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept, promptText: text });
    state.alerts.delete('dialog:' + tabId);
    return accept ? 'dialog accepted' : 'dialog dismissed';
  },

  // ----- monitoring -----

  async console_logs({ tabId, pattern, clear = false, limit = 100 }) {
    await guard(tabId);
    const t = await ensure(tabId);
    let rows = t.console;
    if (pattern) { const m = matcher(pattern); rows = rows.filter(r => m(r.text)); }
    const out = rows.slice(-limit);
    if (clear) t.console = [];
    return out.length ? out : 'no messages (capture starts when the tab is first used)';
  },

  async network_requests({ tabId, url_pattern, clear = false, limit = 100 }) {
    await guard(tabId);
    const t = await ensure(tabId);
    let rows = [...t.network.values()];
    if (url_pattern) { const m = matcher(url_pattern); rows = rows.filter(r => m(r.url)); }
    const out = rows.slice(-limit);
    if (clear) t.network.clear();
    return out.length ? out : 'no requests (capture starts when the tab is first used)';
  },

  async events({ since = 0, types, limit = 100 }) {
    await ready;
    if (state.cfg.perm_read === 'block') throw refuse('Permission denied: the person has blocked the "read pages" permission.');
    let rows = events.filter(e => e.seq > since);
    if (rt.paused) rows = rows.filter(e => e.type === 'control'); // paused means the agent learns nothing new about the browser
    if (types && types.length) rows = rows.filter(e => types.includes(e.type));
    const own = state.cfg.scope === 'own';
    rows = rows.filter(e => (!own || e.tabId == null || isOwned(e.tabId)) && (!e.url || urlVisible(e.url)) && !(own && /^download_/.test(e.type)));
    const hidden = new Set(); // tabs that are on a blocked site right now
    for (const id of new Set(rows.map(r => r.tabId).filter(x => x != null))) {
      try { const t = await chrome.tabs.get(id); if (!urlVisible(t.url || t.pendingUrl || '')) hidden.add(id); } catch (e) {}
    }
    rows = rows.filter(r => !hidden.has(r.tabId));
    return { latest: evSeq, events: rows.slice(-limit) };
  },

  async wait_for({ tabId, text, selector, url_contains, gone = false, timeout_s = 15 }) {
    await guard(tabId);
    const end = Date.now() + Math.min(timeout_s, 300) * 1000;
    if (!text && !selector && !url_contains) { await sleep(Math.min(timeout_s, 300) * 1000); return 'waited'; }
    const expr = `(()=>{const t=${JSON.stringify(text || '')},s=${JSON.stringify(selector || '')},u=${JSON.stringify(url_contains || '')};
      const hasT=t?!!(document.body&&document.body.innerText.includes(t)):null;
      let hasS=null;if(s){try{hasS=!!document.querySelector(s);}catch(e){return'bad selector';}}
      const hasU=u?location.href.includes(u):null;return JSON.stringify({hasT,hasS,hasU});})()`;
    while (Date.now() < end) {
      const r = await evalIn(tabId, expr);
      if (r.value === 'bad selector') throw new Error('invalid selector');
      const v = JSON.parse(r.value);
      const present = [v.hasT, v.hasS].filter(x => x !== null);
      const okPresence = present.length ? (gone ? present.every(x => !x) : present.every(x => x)) : true;
      const okUrl = v.hasU === null ? true : v.hasU;
      if (okPresence && okUrl) return gone ? 'gone' : 'found';
      await sleep(400);
    }
    throw new Error('timed out waiting');
  },

  async downloads_list({ limit = 20 }) {
    if (!chrome.downloads) throw new Error('downloads API unavailable');
    if (state.cfg.scope === 'own') throw refuse('Downloads cannot be listed while the scope is "agent tabs only".');
    const d = (await chrome.downloads.search({ orderBy: ['-startTime'], limit })).filter(x => urlVisible(x.url || ''));
    return d.map(x => ({ id: x.id, filename: x.filename, url: x.url, state: x.state, bytes: x.totalBytes }));
  },

  // ----- human in the loop -----

  async detect_captcha({ tabId }) {
    await guard(tabId);
    const r = await checkCaptcha(tabId);
    const cs = state.captcha.get(tabId);
    return { found: !!(r && r.found), kinds: (r && r.kinds) || [], locked: !!(cs && cs.locked) };
  },

  // kind "captcha": the person solves the challenge, then presses Done. This tool never solves one.
  async ask_human({ tabId, message, kind = 'info', buttons, timeout_s = 300 }) {
    await guard(tabId);
    const defaults = kind === 'captcha' ? ['Done, continue', 'Cancel'] : kind === 'confirm' ? ['Approve', 'Deny'] : ['OK'];
    const title = kind === 'captcha' ? 'Human check needed' : kind === 'confirm' ? 'Please confirm' : 'Action needed';
    const msg = message || (kind === 'captcha' ? 'Please solve the verification on this page, then press Done.' : 'Please check this page.');
    const choice = await askHuman(tabId, { message: msg, title, buttons: buttons && buttons.length ? buttons : defaults, timeout_s });
    if (kind === 'captcha' && /^done/i.test(choice)) {
      const cs = state.captcha.get(tabId) || {};
      state.captcha.set(tabId, { ...cs, locked: false, clearedUntil: Date.now() + 120000 });
      state.alerts.delete('captcha:' + tabId);
      await sleep(600);
      const again = await checkCaptcha(tabId);
      return { choice, captchaStillVisible: !!(again && again.found) };
    }
    return { choice };
  },

  // ----- SEO and web checks -----

  async seo_audit({ tabId }) {
    await guard(tabId);
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: seoSnapshot });
    const audit = r.result;
    const t = await ensure(tabId);
    let doc = t.doc;
    if (!doc || doc.finalUrl !== audit.url.split('#')[0]) {
      const f = await fetchInfo(audit.url, { method: 'GET', maxChars: 0 });
      doc = { status: f.status, finalUrl: f.finalUrl, redirects: f.redirected ? [{ url: audit.url, status: 'redirected' }] : [], headers: f.headers, note: 'from a separate fetch (reload the tab for network-level data)' };
    }
    audit.http = doc;
    if (doc.headers && /noindex/i.test(doc.headers['x-robots-tag'] || '')) audit.issues.push('X-Robots-Tag header has noindex');
    if (doc.status && doc.status >= 400) audit.issues.push('page returns HTTP ' + doc.status);
    if (doc.redirects && doc.redirects.length > 1) audit.issues.push(`redirect chain of ${doc.redirects.length} hops`);
    return audit;
  },

  async seo_site_check({ origin }) {
    const o = new URL(/^https?:/i.test(origin) ? origin : 'https://' + origin).origin;
    const [robots, sitemap, llms, home] = await Promise.all([
      fetchInfo(o + '/robots.txt', { maxChars: 6000 }),
      fetchInfo(o + '/sitemap.xml', { maxChars: 400000 }),
      fetchInfo(o + '/llms.txt', { maxChars: 2000 }),
      fetchInfo(o + '/', { maxChars: 0 }),
    ]);
    const out = { origin: o, issues: [] };
    out.home = { status: home.status, finalUrl: home.finalUrl, headers: home.headers };
    out.robots = { status: robots.status, body: robots.body };
    const sitemapUrls = (robots.body || '').split('\n').map(l => l.match(/^\s*sitemap:\s*(\S+)/i)).filter(Boolean).map(m => m[1]);
    out.robots.sitemaps = sitemapUrls;
    if (robots.status !== 200) out.issues.push('robots.txt not found (HTTP ' + robots.status + ')');
    if (/^\s*disallow:\s*\/\s*$/im.test(robots.body || '')) out.issues.push('robots.txt disallows the whole site for some agent');
    const locs = ((sitemap.body || '').match(/<loc>/g) || []).length;
    out.sitemap = { status: sitemap.status, urlsOrSubSitemaps: locs, isIndex: /<sitemapindex/i.test(sitemap.body || ''), sampleBytes: (sitemap.body || '').length };
    if (sitemap.status !== 200 && !sitemapUrls.length) out.issues.push('no sitemap.xml and none declared in robots.txt');
    out.llmsTxt = { status: llms.status };
    if (home.finalUrl && home.finalUrl.startsWith('http://')) out.issues.push('home page does not end on https');
    if (!home.headers['strict-transport-security']) out.issues.push('no HSTS header');
    return out;
  },

  async fetch_url({ url, method = 'GET', max_chars = 20000 }) {
    return fetchInfo(url, { method, maxChars: max_chars });
  },

  async check_links({ urls, concurrency = 8 }) {
    const gen = stopGen;
    const rows = await pool([...new Set(urls)].slice(0, 500), Math.min(concurrency, 16), async url => {
      if (gen !== stopGen) return { url, status: 0, error: 'stopped by the person', ms: 0 };
      let r = await fetchInfo(url, { method: 'HEAD', maxChars: 0, timeout: 15000 });
      if (r.status === 0 || r.status === 405 || r.status === 403 || r.status === 501) r = await fetchInfo(url, { method: 'GET', maxChars: 0, timeout: 15000 });
      return { url, status: r.status, finalUrl: r.finalUrl !== url ? r.finalUrl : undefined, error: r.error, ms: r.ms };
    });
    const bad = rows.filter(r => !r.status || r.status >= 400);
    return { checked: rows.length, broken: bad.length, brokenLinks: bad, redirected: rows.filter(r => r.finalUrl).length, all: rows };
  },

  async resize_window({ tabId, width, height }) {
    const t = await guard(tabId);
    await chrome.windows.update(t.windowId, { width, height, state: 'normal' });
    return 'resized';
  },

  async detach({ tabId }) {
    try { await chrome.debugger.detach({ tabId }); } catch (e) {}
    state.tabs.delete(tabId);
    return 'detached';
  },
};
