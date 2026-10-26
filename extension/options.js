const DEFAULTS = {
  token: '', port: 17333, enabled: true, blocked: '', allowed: '', scope: 'all', blockFiles: true,
  gate: true, riskyExtra: '', perm_read: 'allow', perm_nav: 'allow', perm_input: 'allow', perm_script: 'ask',
  rateLimit: 600, idleMin: 10, pageBadge: true, allowPrivate: false, highlightTabs: true,
};
const $ = id => document.getElementById(id);
const send = m => new Promise(res => chrome.runtime.sendMessage(m, r => { void chrome.runtime.lastError; res(r); }));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let cfg = { ...DEFAULTS };
let toastTimer;

function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1600); }
async function save(patch) { await chrome.storage.local.set(patch); Object.assign(cfg, patch); toast('Saved'); }
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const PERMS = [
  ['perm_read', 'Read pages', 'Page text, screenshots, links, console and network logs, SEO checks.'],
  ['perm_nav', 'Open and navigate', 'Open, close, move and navigate tabs and windows.'],
  ['perm_input', 'Click and type', 'Mouse, keyboard, forms, dialogs. Risky buttons have their own prompt below.'],
  ['perm_script', 'Run scripts', 'Run JavaScript in a page and attach files. The most powerful permission.'],
];

function buildPerms() {
  const box = $('permList'); box.textContent = '';
  for (const [key, name, desc] of PERMS) {
    const row = el('div', 'perm');
    row.append(el('b', null, name), el('span', 'muted', desc));
    const seg = el('div', 'seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', name);
    for (const v of ['allow', 'ask', 'block']) {
      const b = el('button', v, v[0].toUpperCase() + v.slice(1)); b.type = 'button';
      b.setAttribute('aria-pressed', String(cfg[key] === v));
      b.onclick = async () => { await save({ [key]: v }); buildPerms(); };
      seg.append(b);
    }
    row.append(seg); box.append(row);
  }
}

async function load() {
  cfg = await chrome.storage.local.get(DEFAULTS);
  $('token').value = cfg.token; $('port').value = cfg.port; $('enabled').checked = cfg.enabled;
  $('scope').value = cfg.scope; $('rateLimit').value = cfg.rateLimit; $('idleMin').value = cfg.idleMin;
  $('allowed').value = cfg.allowed; $('blocked').value = cfg.blocked; $('riskyExtra').value = cfg.riskyExtra;
  $('blockFiles').checked = cfg.blockFiles; $('allowPrivate').checked = cfg.allowPrivate; $('highlightTabs').checked = cfg.highlightTabs; $('gate').checked = cfg.gate; $('pageBadge').checked = cfg.pageBadge;
  buildPerms();
}

/* connection */
$('toggleToken').onclick = () => {
  const show = $('token').type === 'password';
  $('token').type = show ? 'text' : 'password';
  $('toggleToken').textContent = show ? 'Hide' : 'Show';
  $('toggleToken').setAttribute('aria-pressed', String(show));
};
$('saveToken').onclick = () => save({ token: $('token').value.trim() });
$('port').onchange = () => save({ port: Math.min(65535, Math.max(1024, Number($('port').value) || DEFAULTS.port)) });
$('enabled').onchange = e => save({ enabled: e.target.checked });
async function status() {
  const s = await send({ type: 'snapshot' });
  const chip = $('state');
  if (!s) { chip.querySelector('.lbl').textContent = 'Starting'; chip.className = 'chip'; return; }
  let label = 'Not connected', cls = 'bad';
  if (!s.enabled) { label = 'Off'; cls = ''; } else if (s.connected && s.paused) { label = 'Paused'; cls = 'warn'; } else if (s.connected) { label = 'Connected'; cls = 'ok'; }
  chip.querySelector('.lbl').textContent = label; chip.title = label; chip.className = 'chip ' + cls;
  $('reason').textContent = s.connected ? (s.clients.join(', ') || '') : s.reason;
}

/* permissions, sites, safety */
$('scope').onchange = e => save({ scope: e.target.value });
$('rateLimit').onchange = () => save({ rateLimit: Math.max(0, Number($('rateLimit').value) || 0) });
$('idleMin').onchange = () => save({ idleMin: Math.max(1, Number($('idleMin').value) || 10) });
$('allowed').oninput = debounce(() => save({ allowed: $('allowed').value }), 600);
$('blocked').oninput = debounce(() => save({ blocked: $('blocked').value }), 600);
$('riskyExtra').oninput = debounce(() => save({ riskyExtra: $('riskyExtra').value }), 600);
for (const id of ['blockFiles', 'allowPrivate', 'gate', 'pageBadge', 'highlightTabs']) $(id).onchange = e => save({ [id]: e.target.checked });

/* activity log */
let rows = [];
const fmt = ts => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function drawLog() {
  const q = $('filter').value.trim().toLowerCase(), st = $('statusFilter').value;
  const list = rows.filter(r => (!st || r.status === st) && (!q || [r.tool, r.host, r.summary, r.client, r.error].join(' ').toLowerCase().includes(q)));
  const body = document.querySelector('#log tbody'); body.textContent = '';
  for (const r of list.slice(0, 500)) {
    const tr = el('tr');
    tr.append(el('td', null, fmt(r.ts)), el('td', null, r.tool), el('td', null, r.host), el('td', null, r.summary || ''), el('td', null, r.client || ''));
    const res = el('td', 'res ' + r.status, r.status === 'ok' ? 'OK · ' + r.ms + 'ms' : r.status === 'denied' ? 'Denied' : 'Error');
    res.title = r.error || '';
    tr.title = r.error || r.summary || '';
    tr.append(res); body.append(tr);
  }
  $('logCount').textContent = `${list.length} of ${rows.length} entries`;
}
async function loadLog() { rows = ((await send({ type: 'audit' })) || []).slice().reverse(); drawLog(); }
$('filter').oninput = drawLog; $('statusFilter').onchange = drawLog;
function download(name, type, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
$('exportJson').onclick = () => download('browser-bridge-activity.json', 'application/json', JSON.stringify(rows, null, 2));
$('exportCsv').onclick = () => {
  const q = v => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; }; // a leading quote stops spreadsheets running a cell as a formula
  download('browser-bridge-activity.csv', 'text/csv', ['time,tool,site,detail,client,status,ms,error', ...rows.map(r => [new Date(r.ts).toISOString(), r.tool, r.host, r.summary, r.client, r.status, r.ms, r.error].map(q).join(','))].join('\n'));
};
$('clearLog').onclick = async () => { if (confirm('Clear the activity log in the browser? The server keeps its own audit.log.')) { await send({ type: 'auditClear' }); loadLog(); } };

/* backup */
$('exportSettings').onclick = () => { const { token, ...rest } = cfg; download('browser-bridge-settings.json', 'application/json', JSON.stringify(rest, null, 2)); };
$('importSettings').onclick = () => $('importFile').click();
const ENUMS = { scope: ['all', 'own'], perm_read: ['allow', 'ask', 'block'], perm_nav: ['allow', 'ask', 'block'], perm_input: ['allow', 'ask', 'block'], perm_script: ['allow', 'ask', 'block'] };
$('importFile').onchange = async e => {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    const clean = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (k === 'token' || !(k in data) || typeof data[k] !== typeof DEFAULTS[k]) continue;
      if (ENUMS[k] && !ENUMS[k].includes(data[k])) continue;
      if (typeof data[k] === 'string' && data[k].length > 20000) continue;
      if (typeof data[k] === 'number' && !Number.isFinite(data[k])) continue;
      clean[k] = data[k];
    }
    const n = Object.keys(clean).length;
    if (!n) throw new Error('empty');
    // Imported settings can loosen permissions or open up sites, so never apply them silently.
    if (!confirm(`Import ${n} settings? This replaces your current permissions, site lists and safety options.`)) return;
    await chrome.storage.local.set(clean); await load(); toast('Imported');
  } catch (err) { toast('Not a valid settings file'); }
  e.target.value = '';
};

/* foldable sidebar */
const FOLD_KEY = 'bb.sidebarFolded';
function setFold(folded) {
  document.body.classList.toggle('folded', folded);
  const b = $('fold');
  b.setAttribute('aria-expanded', String(!folded));
  b.setAttribute('aria-label', folded ? 'Expand sidebar' : 'Collapse sidebar');
  b.title = (folded ? 'Expand sidebar' : 'Collapse sidebar') + ' ( [ )';
  try { localStorage.setItem(FOLD_KEY, folded ? '1' : '0'); } catch (e) {}
}
let startFolded = false;
try { startFolded = localStorage.getItem(FOLD_KEY) === '1'; } catch (e) {}
setFold(startFolded);
$('fold').onclick = () => setFold(!document.body.classList.contains('folded'));
document.addEventListener('keydown', e => {
  if (e.key !== '[' || e.ctrlKey || e.metaKey || e.altKey || /^(input|textarea|select)$/i.test((e.target.tagName || ''))) return;
  setFold(!document.body.classList.contains('folded'));
});

/* side nav highlight */
const links = [...document.querySelectorAll('nav a')];
const obs = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + en.target.id)); }), { rootMargin: '-20% 0px -70% 0px' });
document.querySelectorAll('main section').forEach(s => obs.observe(s));

load();
status(); setInterval(status, 2000);
loadLog(); setInterval(loadLog, 15000);
// Realtime: refresh the status and the log the moment the worker reports a change.
let tick = null;
const live = () => { const port = chrome.runtime.connect({ name: 'live' }); port.onMessage.addListener(m => { if (m.type === 'changed' || m.type === 'entry') { clearTimeout(tick); tick = setTimeout(() => { status(); loadLog(); }, 250); } }); port.onDisconnect.addListener(() => setTimeout(live, 1000)); };
live();
