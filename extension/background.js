// Browser Bridge: service worker.
// Connects to the local MCP server over ws://127.0.0.1:<port>, authenticates with a shared token,
// then executes browser commands (chrome.tabs / chrome.windows / chrome.scripting / chrome.debugger).
//
// Concurrency: commands for different tabs run in parallel; commands for the same tab run in order.
// Human in the loop: CAPTCHAs lock a tab for automation; risky clicks can require approval; both use an
// on-page prompt that only a real (trusted) click from the person can answer.

const DEFAULTS = { token: '', port: 17333, enabled: true, blocked: '', gate: true };
const IDLE_DETACH_MS = 10 * 60 * 1000;
const ICON = 'icon128.png';

const state = {
  ws: null,
  cfg: { ...DEFAULTS },
  reason: 'starting',
  connected: false,
  tabs: new Map(), // tabId -> { console, network, last, mainFrame, doc }
  alerts: new Map(), // key -> text, shown to the client on every reply while unresolved
  captcha: new Map(), // tabId -> { locked, kinds, clearedUntil }
  siteAllow: new Map(), // host -> ms until which risky clicks are pre-approved
};
const humanWaiters = new Map(); // id -> resolve
const humanTabs = new Set(); // tabs with an open human prompt
const queues = new Map(); // key -> promise tail
let humanSeq = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- event timeline ----------

let evSeq = 0;
const events = [];
function logEvent(type, data) {
  events.push({ seq: ++evSeq, ts: new Date().toISOString(), type, ...data });
  if (events.length > 1000) events.shift();
}

// ---------- connection ----------

function setBadge() {
  chrome.action.setBadgeText({ text: state.connected ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#1f9d55' });
}

async function connect() {
  state.cfg = await chrome.storage.local.get(DEFAULTS);
  if (!state.cfg.enabled) { state.reason = 'disabled in settings'; return teardown(); }
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

  ws.onopen = () => ws.send(JSON.stringify({ auth: state.cfg.token, role: 'ext' }));
  ws.onmessage = ev => onMessage(ws, ev.data);
  ws.onclose = () => {
    if (state.ws === ws) { state.ws = null; state.connected = false; state.reason = 'bridge not running (start the MCP client that runs the bridge server)'; setBadge(); }
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
  if (msg.authed) { state.connected = true; state.reason = 'ok'; setBadge(); return; }
  if (msg.authError) { state.reason = 'token rejected by bridge'; state.connected = false; setBadge(); return; }
  if (msg.ping || !msg.method) return;

  // Do not await: many commands may be in flight at once (parallel tabs).
  (async () => {
    let reply;
    try {
      const h = HANDLERS[msg.method];
      if (!h) throw new Error('unknown method ' + msg.method);
      const params = msg.params || {};
      const run = () => h(params);
      const result = params.tabId != null && !EXEMPT.has(msg.method) ? await enqueue('t' + params.tabId, run) : await run();
      reply = { id: msg.id, result };
    } catch (e) {
      reply = { id: msg.id, error: String((e && e.message) || e) };
    }
    reply.alerts = [...state.alerts.values()];
    if (ws.readyState === 1) ws.send(JSON.stringify(reply));
  })();
}

// keep the worker alive and reconnect
setInterval(() => { if (state.ws && state.ws.readyState === 1) state.ws.send('{"ping":1}'); }, 20000);
chrome.alarms.create('cbb-tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== 'cbb-tick') return;
  if (!state.ws || state.ws.readyState > 1) connect();
  const now = Date.now();
  for (const [tabId, t] of state.tabs) {
    if (now - t.last > IDLE_DETACH_MS && !humanTabs.has(tabId)) { try { await chrome.debugger.detach({ tabId }); } catch (e) {} state.tabs.delete(tabId); }
  }
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.storage.onChanged.addListener(() => { teardown(); connect(); });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((m, sender, send) => {
  if (m && m.type === 'status') { send({ connected: state.connected, reason: state.reason }); return false; }
  // Answers from the on-page prompt. Only our own injected script (with a tab) may answer.
  if (m && m.type === 'human' && sender.id === chrome.runtime.id && sender.tab) {
    const res = humanWaiters.get(m.id);
    if (res) { humanWaiters.delete(m.id); res(String(m.choice)); }
  }
  return false;
});
connect();

// ---------- timeline listeners ----------

chrome.tabs.onCreated.addListener(t => logEvent('tab_created', { tabId: t.id, url: t.pendingUrl || t.url || '', openerTabId: t.openerTabId || null }));
chrome.tabs.onRemoved.addListener(id => { logEvent('tab_closed', { tabId: id }); state.tabs.delete(id); state.captcha.delete(id); state.alerts.delete('captcha:' + id); state.alerts.delete('dialog:' + id); });
chrome.tabs.onUpdated.addListener((id, ci, t) => {
  if (ci.status === 'complete') logEvent('tab_loaded', { tabId: id, url: t.url, title: t.title });
  else if (ci.url) logEvent('tab_navigated', { tabId: id, url: ci.url });
});
if (chrome.downloads) {
  chrome.downloads.onCreated.addListener(d => logEvent('download_started', { id: d.id, url: d.url, filename: d.filename }));
  chrome.downloads.onChanged.addListener(d => { if (d.state) logEvent('download_' + d.state.current, { id: d.id }); });
}

// ---------- safety ----------

function blockedList() {
  return String(state.cfg.blocked || '').split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
}
function checkUrl(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return; }
  for (const b of blockedList()) {
    if (host === b || host.endsWith('.' + b)) throw new Error(`blocked site (${b}); remove it in the extension settings to allow`);
  }
}
async function guard(tabId) {
  if (!state.cfg.enabled) throw new Error('control is disabled in the extension settings');
  const tab = await chrome.tabs.get(tabId);
  checkUrl(tab.url || tab.pendingUrl || '');
  return tab;
}

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
function renderPrompt(o) {
  const old = document.getElementById('__cbb_overlay');
  if (old) old.remove();
  const host = document.createElement('div');
  host.id = '__cbb_overlay';
  host.style.cssText = 'all:initial;position:fixed;top:14px;right:14px;z-index:2147483647;';
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
    b.addEventListener('click', ev => {
      if (!ev.isTrusted) return;
      chrome.runtime.sendMessage({ type: 'human', id: o.id, choice: label });
      host.remove();
    });
    row.appendChild(b);
  });
  box.append(h, p, row);
  root.append(style, box);
  document.documentElement.appendChild(host);
}

async function askHuman(tabId, { message, title = 'Action needed', buttons = ['OK'], timeout_s = 300 }) {
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

  const inject = () => chrome.scripting.executeScript({ target: { tabId }, func: renderPrompt, args: [{ id, title, message, buttons }] }).catch(() => {});
  const answered = new Promise(res => humanWaiters.set(id, res));
  const deadline = Date.now() + timeout_s * 1000;
  let choice = 'timeout';
  try {
    await inject();
    while (Date.now() < deadline) {
      const r = await Promise.race([answered.then(v => ({ v })), sleep(1500).then(() => null)]);
      if (r) { choice = r.v; break; }
      try { // the page may have navigated and dropped the prompt
        const [x] = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!document.getElementById('__cbb_overlay') });
        if (!x.result) await inject();
      } catch (e) {}
    }
  } finally {
    humanWaiters.delete(id);
    humanTabs.delete(tabId);
    state.alerts.delete(key);
    try { chrome.notifications.clear(id); } catch (e) {}
    chrome.scripting.executeScript({ target: { tabId }, func: () => { const o = document.getElementById('__cbb_overlay'); if (o) o.remove(); } }).catch(() => {});
    logEvent('human_answer', { tabId, choice });
  }
  return choice;
}

const RISKY = /\b(post|publish|tweet|share|send|submit|reply|comment|delete|remove|buy|pay|purchase|order|checkout|confirm|subscribe|register|transfer|withdraw|donate|accept|agree|schedule|upload|place)\b/i;

async function gateClick(tabId, info) {
  if (!state.cfg.gate || !info || !info.label || !RISKY.test(info.label)) return;
  const tab = await chrome.tabs.get(tabId);
  let host = '';
  try { host = new URL(tab.url).hostname; } catch (e) {}
  if ((state.siteAllow.get(host) || 0) > Date.now()) return;
  const ans = await askHuman(tabId, {
    title: 'Approve this click?',
    message: `An automated session wants to click "${info.label}" on ${host || 'this page'}.`,
    buttons: ['Allow', 'Allow on this site for 10 min', 'Deny'],
    timeout_s: 300,
  });
  if (ans === 'Allow on this site for 10 min') { state.siteAllow.set(host, Date.now() + 600000); return; }
  if (ans !== 'Allow') throw new Error(`The person did not approve clicking "${info.label}" (${ans}).`);
}

// ---------- debugger plumbing ----------

async function ensure(tabId) {
  let t = state.tabs.get(tabId);
  if (!t) {
    await chrome.debugger.attach({ tabId }, '1.3');
    t = { console: [], network: new Map(), last: Date.now(), mainFrame: null, doc: null };
    state.tabs.set(tabId, t);
    for (const d of ['Runtime.enable', 'Network.enable', 'Page.enable', 'Log.enable']) {
      await chrome.debugger.sendCommand({ tabId }, d);
    }
    // Background tabs behave as focused, so parallel tabs keep rendering and receiving input.
    try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
    try {
      const ft = await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree');
      t.mainFrame = ft.frameTree.frame.id;
    } catch (e) {}
  }
  t.last = Date.now();
  return t;
}

async function cdp(tabId, method, params) {
  await guard(tabId);
  await ensure(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

chrome.debugger.onDetach.addListener(src => { state.tabs.delete(src.tabId); state.alerts.delete('dialog:' + src.tabId); });

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
  const r = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, ...opts });
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
    const c=el.closest('button,a,[role=button],[role=menuitem],input[type=submit],input[type=button]')||el;
    return{x:Math.round(x),y:Math.round(y),id:el.id,tag:el.tagName,type:el.type||'',label:String(c.getAttribute('aria-label')||c.innerText||c.value||c.title||'').trim().slice(0,80)};})()`);
  if (r.value.error) throw new Error(r.value.error);
  return r.value;
}

// What would a click at x,y hit? (through same-origin iframes)
async function describeAt(tabId, x, y) {
  const r = await evalIn(tabId, `(()=>{let x=${Number(x)},y=${Number(y)},el=document.elementFromPoint(x,y);
    while(el&&el.tagName==='IFRAME'){try{const dd=el.contentDocument;if(!dd)break;const fr=el.getBoundingClientRect();x-=fr.left;y-=fr.top;const e2=dd.elementFromPoint(x,y);if(!e2)break;el=e2;}catch(e){break;}}
    if(!el)return null;const c=el.closest('button,a,[role=button],[role=menuitem],input[type=submit],input[type=button]')||el;
    return{id:el.id,tag:el.tagName,type:el.type||'',label:String(c.getAttribute('aria-label')||c.innerText||c.value||c.title||'').trim().slice(0,80)};})()`);
  return r.value;
}

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
      if (el.id === '__cbb_overlay') continue;
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
  checkUrl(url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method, redirect: 'follow', credentials: 'omit', signal: ctl.signal, headers });
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
    return { connected: true, attachedTabs: [...state.tabs.keys()], blocked: blockedList(), gate: !!state.cfg.gate, alerts: [...state.alerts.values()], lockedTabs: [...state.captcha].filter(([, v]) => v.locked).map(([k]) => k) };
  },

  async reload_extension() {
    setTimeout(() => chrome.runtime.reload(), 300);
    return 'reloading; the connection returns in a few seconds';
  },

  // ----- tabs and windows -----

  async tabs_list() {
    if (!state.cfg.enabled) throw new Error('control is disabled in the extension settings');
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => ({ tabId: t.id, windowId: t.windowId, active: t.active, groupId: t.groupId, title: t.title, url: t.url, audible: t.audible || false }));
  },

  async windows_list() {
    const ws = await chrome.windows.getAll({ populate: true });
    return ws.map(w => ({ windowId: w.id, focused: w.focused, state: w.state, type: w.type, incognito: w.incognito, width: w.width, height: w.height, tabs: w.tabs.map(t => ({ tabId: t.id, active: t.active, title: t.title, url: t.url })) }));
  },

  async window_create({ url, width, height, focused = false, state: st }) {
    if (!state.cfg.enabled) throw new Error('control is disabled in the extension settings');
    if (url) checkUrl(url);
    const w = await chrome.windows.create({ url: url || 'about:blank', width, height, focused, state: st });
    return { windowId: w.id, tabId: w.tabs && w.tabs[0] && w.tabs[0].id };
  },

  async window_close({ windowId }) {
    await chrome.windows.remove(windowId);
    return 'closed';
  },

  async tab_create({ url, active = true, windowId }) {
    if (!state.cfg.enabled) throw new Error('control is disabled in the extension settings');
    if (url) checkUrl(url);
    const t = await chrome.tabs.create({ url: url || 'about:blank', active, windowId });
    if (url) await waitLoad(t.id);
    return { tabId: t.id };
  },

  // Opens many tabs in parallel (background by default) and waits for each to load.
  async tabs_open_many({ urls, windowId, active = false }) {
    if (!state.cfg.enabled) throw new Error('control is disabled in the extension settings');
    urls.forEach(checkUrl);
    const opened = await Promise.all(urls.map(url => chrome.tabs.create({ url, active, windowId })));
    await Promise.all(opened.map(t => waitLoad(t.id).catch(() => {})));
    const now = await Promise.all(opened.map(t => chrome.tabs.get(t.id)));
    return now.map(t => ({ tabId: t.id, url: t.url, title: t.title }));
  },

  async tab_duplicate({ tabId }) {
    await guard(tabId);
    const t = await chrome.tabs.duplicate(tabId);
    return { tabId: t.id };
  },

  async group_tabs({ tabIds, title, color }) {
    for (const id of tabIds) await guard(id);
    const groupId = await chrome.tabs.group({ tabIds });
    const upd = {};
    if (title) upd.title = title;
    if (color) upd.color = color;
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
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
      checkUrl(url);
      await chrome.tabs.update(tabId, { url });
    }
    await waitLoad(tabId);
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

  async screenshot({ tabId, full_page = false }) {
    const m = await cdp(tabId, 'Page.getLayoutMetrics');
    const vp = m.cssVisualViewport;
    const clip = full_page
      ? { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 12000), scale: 1 }
      : { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: 1 };
    const r = await cdp(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 75, clip, captureBeyondViewport: full_page });
    return { image: r.data, mime: 'image/jpeg', text: `tab ${tabId}: viewport ${Math.round(vp.clientWidth)}x${Math.round(vp.clientHeight)} CSS px; click x/y use this same coordinate space` };
  },

  // ----- input -----

  async click({ tabId, ref, x, y, button = 'left', count = 1 }) {
    await mutGuard(tabId);
    let p;
    if (ref) p = await centerOf(tabId, ref);
    else if (typeof x === 'number' && typeof y === 'number') p = { x, y, ...((await describeAt(tabId, x, y)) || {}) };
    else throw new Error('give either ref or x and y');
    if (p.id === '__cbb_overlay') throw new Error('That is the prompt for the person. Only they can click it.');
    await gateClick(tabId, p);
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
      if (d && d.id === '__cbb_overlay') throw new Error('That is the prompt for the person. Only they can click it.');
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
    for (const k of String(keys).split(/\s+/).filter(Boolean)) await pressKey(tabId, k);
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
    if (pattern) { const re = new RegExp(pattern, 'i'); rows = rows.filter(r => re.test(r.text)); }
    const out = rows.slice(-limit);
    if (clear) t.console = [];
    return out.length ? out : 'no messages (capture starts when the tab is first used)';
  },

  async network_requests({ tabId, url_pattern, clear = false, limit = 100 }) {
    await guard(tabId);
    const t = await ensure(tabId);
    let rows = [...t.network.values()];
    if (url_pattern) { const re = new RegExp(url_pattern, 'i'); rows = rows.filter(r => re.test(r.url)); }
    const out = rows.slice(-limit);
    if (clear) t.network.clear();
    return out.length ? out : 'no requests (capture starts when the tab is first used)';
  },

  async events({ since = 0, types, limit = 100 }) {
    let rows = events.filter(e => e.seq > since);
    if (types && types.length) rows = rows.filter(e => types.includes(e.type));
    return { latest: evSeq, events: rows.slice(-limit) };
  },

  async wait_for({ tabId, text, timeout_s = 15 }) {
    const end = Date.now() + timeout_s * 1000;
    while (Date.now() < end) {
      if (!text) { await sleep(timeout_s * 1000); return 'waited'; }
      const r = await evalIn(tabId, `document.body&&document.body.innerText.includes(${JSON.stringify(text)})`);
      if (r.value) return 'found';
      await sleep(500);
    }
    throw new Error('timed out waiting for text');
  },

  async downloads_list({ limit = 20 }) {
    if (!chrome.downloads) throw new Error('downloads API unavailable');
    const d = await chrome.downloads.search({ orderBy: ['-startTime'], limit });
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
    const rows = await pool([...new Set(urls)].slice(0, 500), Math.min(concurrency, 16), async url => {
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
