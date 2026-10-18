// Browser Bridge: service worker.
// Connects to the local MCP server over ws://127.0.0.1:<port>, authenticates with a shared token,
// then executes browser commands (via chrome.tabs / chrome.scripting / chrome.debugger).

const DEFAULTS = { token: '', port: 17333, enabled: true, blocked: '' };
const IDLE_DETACH_MS = 10 * 60 * 1000;

const state = {
  ws: null,
  cfg: { ...DEFAULTS },
  reason: 'starting',
  connected: false,
  tabs: new Map(), // tabId -> { console: [], network: Map, last: ms }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function onMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (msg.authed) { state.connected = true; state.reason = 'ok'; setBadge(); return; }
  if (msg.authError) { state.reason = 'token rejected by bridge'; state.connected = false; setBadge(); return; }
  if (msg.ping) return;
  if (!msg.method) return;

  let reply;
  try {
    const h = HANDLERS[msg.method];
    if (!h) throw new Error('unknown method ' + msg.method);
    reply = { id: msg.id, result: await h(msg.params || {}) };
  } catch (e) {
    reply = { id: msg.id, error: String((e && e.message) || e) };
  }
  if (ws.readyState === 1) ws.send(JSON.stringify(reply));
}

// keep the worker alive and reconnect
setInterval(() => { if (state.ws && state.ws.readyState === 1) state.ws.send('{"ping":1}'); }, 20000);
chrome.alarms.create('cbb-tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== 'cbb-tick') return;
  if (!state.ws || state.ws.readyState > 1) connect();
  const now = Date.now();
  for (const [tabId, t] of state.tabs) {
    if (now - t.last > IDLE_DETACH_MS) { try { await chrome.debugger.detach({ tabId }); } catch (e) {} state.tabs.delete(tabId); }
  }
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.storage.onChanged.addListener(() => { teardown(); connect(); });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((m, _s, send) => {
  if (m && m.type === 'status') { send({ connected: state.connected, reason: state.reason }); }
  return false;
});
connect();

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

// ---------- debugger plumbing ----------

async function ensure(tabId) {
  let t = state.tabs.get(tabId);
  if (!t) {
    await chrome.debugger.attach({ tabId }, '1.3');
    t = { console: [], network: new Map(), last: Date.now() };
    state.tabs.set(tabId, t);
    for (const d of ['Runtime.enable', 'Network.enable', 'Page.enable', 'Log.enable']) {
      await chrome.debugger.sendCommand({ tabId }, d);
    }
  }
  t.last = Date.now();
  return t;
}

async function cdp(tabId, method, params) {
  await guard(tabId);
  await ensure(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params || {});
}

chrome.debugger.onDetach.addListener(src => { state.tabs.delete(src.tabId); });
chrome.tabs.onRemoved.addListener(id => state.tabs.delete(id));

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
      break;
    case 'Network.responseReceived': {
      const r = t.network.get(p.requestId);
      if (r) { r.status = p.response.status; r.mime = p.response.mimeType; }
      break;
    }
    case 'Network.loadingFailed': {
      const r = t.network.get(p.requestId);
      if (r) r.error = p.errorText;
      break;
    }
  }
});

// ---------- in-page helpers ----------

const RESOLVE = `(ref)=>{const f=(root)=>{const e=root.querySelector('[data-cbb-ref="'+ref+'"]');if(e)return e;for(const h of root.querySelectorAll('*')){if(h.shadowRoot){const x=f(h.shadowRoot);if(x)return x;}}return null;};return f(document);}`;

async function evalIn(tabId, expression, opts = {}) {
  const r = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, ...opts });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || 'evaluation failed');
  }
  return r.result;
}

async function centerOf(tabId, ref) {
  const r = await evalIn(tabId, `(()=>{const el=(${RESOLVE})(${JSON.stringify(ref)});if(!el)return{error:'ref not found: '+${JSON.stringify(ref)}+'. Run read_page again.'};el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  if (r.value.error) throw new Error(r.value.error);
  return r.value;
}

async function viewport(tabId) {
  const r = await evalIn(tabId, '({w:innerWidth,h:innerHeight})');
  return r.value;
}

async function target(tabId, p) {
  if (p.ref) return centerOf(tabId, p.ref);
  if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y };
  throw new Error('give either ref or x and y');
}

// Injected into the page; must be self-contained.
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
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return null;
    return r;
  };
  const nameOf = el => String(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.placeholder || el.alt || el.title || (el.innerText || '').trim() || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const roleOf = el => el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: (el.type || 'text') + ' input', SELECT: 'select', TEXTAREA: 'textarea', SUMMARY: 'summary' })[el.tagName] || el.tagName.toLowerCase();
  const walk = (root, depth) => {
    for (const el of root.children) {
      if (full) return;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;
      const r = vis(el);
      let shown = false;
      if (r) {
        const isI = el.matches(INTERACTIVE);
        const isT = filter === 'all' && /^(H[1-6]|P|LI|LABEL|TD|TH|IMG)$/.test(el.tagName);
        if (isI || isT) {
          const name = nameOf(el);
          const role = roleOf(el);
          if ((isI || name) && (!q || (role + ' ' + name).toLowerCase().includes(q))) {
            if (!el.dataset.cbbRef) el.dataset.cbbRef = 'ref_' + (++g.n);
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
      walk(el, depth + (shown ? 1 : 0));
      if (el.shadowRoot) walk(el.shadowRoot, depth + (shown ? 1 : 0));
    }
  };
  walk(document.body || document.documentElement, 0);
  return { url: location.href, title: document.title, viewport: { w: innerWidth, h: innerHeight }, scrollY: Math.round(scrollY), text: out.join('\n') };
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

// ---------- command handlers ----------

const HANDLERS = {
  async status() {
    return { connected: true, attachedTabs: [...state.tabs.keys()], blocked: blockedList() };
  },

  async tabs_list() {
    if (!state.cfg.enabled) throw new Error('control is disabled in the extension settings');
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => ({ tabId: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url }));
  },

  async tab_create({ url, active = true }) {
    if (!state.cfg.enabled) throw new Error('control is disabled in the extension settings');
    if (url) checkUrl(url);
    const t = await chrome.tabs.create({ url: url || 'about:blank', active });
    if (url) await waitLoad(t.id);
    return { tabId: t.id };
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
    const t = await chrome.tabs.get(tabId);
    return { url: t.url, title: t.title };
  },

  async read_page({ tabId, filter = 'interactive', query = '', max_chars = 40000 }) {
    await guard(tabId);
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageSnapshot, args: [{ filter, query, maxChars: max_chars }] });
    return r.result;
  },

  async get_text({ tabId, max_chars = 40000 }) {
    await guard(tabId);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: n => ({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, n) }),
      args: [max_chars],
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
    return { image: r.data, mime: 'image/jpeg', text: `viewport ${Math.round(vp.clientWidth)}x${Math.round(vp.clientHeight)} CSS px; click x/y use this same coordinate space` };
  },

  async click({ tabId, ref, x, y, button = 'left', count = 1 }) {
    const p = await target(tabId, { ref, x, y });
    const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
    await mouse(tabId, 'mouseMoved', p.x, p.y);
    for (let i = 1; i <= count; i++) {
      await mouse(tabId, 'mousePressed', p.x, p.y, { button, clickCount: i, buttons });
      await mouse(tabId, 'mouseReleased', p.x, p.y, { button, clickCount: i });
    }
    return `clicked at ${p.x},${p.y}`;
  },

  async hover({ tabId, ref, x, y }) {
    const p = await target(tabId, { ref, x, y });
    await mouse(tabId, 'mouseMoved', p.x, p.y);
    return `hovered at ${p.x},${p.y}`;
  },

  async drag({ tabId, from_x, from_y, to_x, to_y }) {
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
    if (ref) await HANDLERS.click({ tabId, ref });
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await cdp(tabId, 'Input.insertText', { text: lines[i] });
      if (i < lines.length - 1) await pressKey(tabId, 'shift+Enter');
    }
    return `typed ${String(text).length} chars`;
  },

  async key({ tabId, keys }) {
    for (const k of String(keys).split(/\s+/).filter(Boolean)) await pressKey(tabId, k);
    return 'pressed ' + keys;
  },

  async scroll({ tabId, direction = 'down', amount = 600, ref, x, y }) {
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
    const r = await evalIn(tabId, `(()=>{const el=(${RESOLVE})(${JSON.stringify(ref)});if(!el)return'ref not found';el.scrollIntoView({block:'center'});const v=${JSON.stringify(value)};
      if(el.tagName==='SELECT'){const o=[...el.options].find(o=>o.value===String(v)||o.text.trim()===String(v));if(!o)return'no such option';el.value=o.value;}
      else if(el.type==='checkbox'||el.type==='radio'){el.checked=(v===true||v==='true'||v===1);}
      else if(el.isContentEditable){el.focus();document.execCommand('selectAll');document.execCommand('insertText',false,String(v));return'ok';}
      else{el.focus();const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');d&&d.set?d.set.call(el,String(v)):el.value=String(v);}
      el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return'ok';})()`);
    if (r.value !== 'ok') throw new Error(r.value);
    return 'ok';
  },

  async eval_js({ tabId, expression }) {
    const r = await evalIn(tabId, expression);
    return r.value !== undefined ? r.value : r.description || String(r.type);
  },

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

  async upload_file({ tabId, ref, paths }) {
    const r = await cdp(tabId, 'Runtime.evaluate', { expression: `(${RESOLVE})(${JSON.stringify(ref)})` });
    if (!r.result.objectId) throw new Error('ref not found; run read_page again');
    await cdp(tabId, 'DOM.setFileInputFiles', { files: paths, objectId: r.result.objectId });
    return 'files set';
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
