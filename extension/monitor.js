const $ = id => document.getElementById(id);
const send = m => new Promise(res => chrome.runtime.sendMessage(m, r => { void chrome.runtime.lastError; res(r); }));
const MAX_LINES = 2000;
const rows = new Map();   // entry id -> { el, entry }
const lines = [];         // everything shown, oldest first
let frozen = false, queue = [], stats = { live: 0, held: 0, ok: 0, denied: 0, error: 0 };

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const clock = ts => { const d = new Date(ts); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
const ICON = { ok: '✓', denied: '!', error: '✕', running: '●', held: 'Ⅱ' };

function matches(item) {
  const q = $('filter').value.trim().toLowerCase(), st = $('statusFilter').value;
  if (item.kind === 'event') return $('events').checked && !st && (!q || (item.text + ' ' + item.type).toLowerCase().includes(q));
  const e = item.entry;
  if (st === 'live' ? !(e.status === 'running' || e.status === 'held') : st && e.status !== st) return false;
  return !q || [e.tool, e.host, e.summary, e.client, e.error, e.tabId].join(' ').toLowerCase().includes(q);
}

function build(item) {
  const d = el('div', 'line');
  paint(d, item);
  return d;
}
function paint(d, item) {
  d.textContent = '';
  if (item.kind === 'event') {
    d.className = 'line event' + (item.type === 'control' ? ' control' : '');
    d.append(el('span', 't', clock(item.ts)), el('span', 'ic', '·'), el('span', 'tool', item.type.replace(/_/g, ' ')), el('span', 'tab', item.tabId != null ? 'tab ' + item.tabId : ''), el('span', 'host', ''), el('span', 'sum', item.text), el('span', 'ms', ''));
    return;
  }
  const e = item.entry;
  d.className = 'line ' + e.status;
  const detail = [e.summary, e.error].filter(Boolean).join('  ·  ');
  const sum = el('span', 'sum', detail || e.client); sum.title = [e.client, detail].filter(Boolean).join('\n');
  d.append(el('span', 't', clock(e.ts)), el('span', 'ic', ICON[e.status] || '?'), el('span', 'tool', e.tool), el('span', 'tab', e.tabId != null ? 'tab ' + e.tabId : ''), el('span', 'host', e.host || ''), sum,
    el('span', 'ms', e.status === 'running' ? '…' : e.status === 'held' ? 'held' : e.ms + 'ms'));
}

function addLine(item) {
  lines.push(item);
  item.el = build(item);
  if (matches(item)) $('log').append(item.el); else item.el.hidden = true;
  if (lines.length > MAX_LINES) { const old = lines.shift(); old.el.remove(); if (old.entry) rows.delete(old.entry.id); }
  if ($('follow').checked) $('log').scrollTop = $('log').scrollHeight;
}
function applyEntry(entry) {
  const known = rows.get(entry.id);
  if (known) {
    const was = known.entry.status;
    known.entry = entry; paint(known.el, known);
    known.el.hidden = !matches(known);
    recount(was, entry.status);
  } else {
    const item = { kind: 'entry', entry };
    rows.set(entry.id, item); addLine(item); recount(null, entry.status);
  }
}
const statKey = st => (st === 'running' ? 'live' : st);
function showStats() {
  $('nRun').textContent = stats.live; $('nHeld').textContent = stats.held; $('nOk').textContent = stats.ok; $('nDenied').textContent = stats.denied; $('nErr').textContent = stats.error;
  $('count').textContent = lines.length + ' lines';
}
function recount(was, now) {
  if (was) stats[statKey(was)] = Math.max(0, stats[statKey(was)] - 1);
  stats[statKey(now)]++;
  showStats();
}
function describeEvent(ev) {
  const { seq, ts, type, tabId, ...rest } = ev;
  if (type === 'control') return `${rest.action} (${rest.source})`;
  return Object.values(rest).filter(v => v != null && v !== '').map(v => String(v).slice(0, 120)).join('  ');
}
function applyEvent(ev) { addLine({ kind: 'event', ts: Date.parse(ev.ts) || Date.now(), type: ev.type, tabId: ev.tabId != null ? ev.tabId : null, text: describeEvent(ev) }); }

function handle(msg) {
  if (frozen) { queue.push(msg); $('frozen').hidden = false; return; }
  if (msg.type === 'entry') applyEntry(msg.entry); else if (msg.type === 'event') applyEvent(msg.ev); else if (msg.type === 'changed') refreshState();
}
function redraw() { for (const it of lines) it.el.hidden = !matches(it); }

async function refreshState() {
  const s = await send({ type: 'snapshot' });
  if (!s) return;
  const chip = $('state');
  let label = 'Not connected', cls = 'bad';
  if (!s.enabled) { label = 'Off'; cls = ''; } else if (s.connected && s.paused) { label = 'Paused'; cls = 'warn'; } else if (s.connected) { label = 'Connected'; cls = 'ok'; }
  chip.textContent = label; chip.className = 'chip ' + cls; chip.title = s.connected ? '' : s.reason;
  $('pause').textContent = s.paused ? 'Resume' : 'Pause'; $('pause').className = 'btn ' + (s.paused ? 'warn' : 'primary'); $('step').disabled = !s.paused;
  window.__paused = s.paused;
}

$('pause').onclick = async () => { await send({ type: 'ctl', action: window.__paused ? 'resume' : 'pause' }); refreshState(); };
$('step').onclick = async () => { await send({ type: 'ctl', action: 'step' }); refreshState(); };
$('stop').onclick = async () => { await send({ type: 'ctl', action: 'stop' }); refreshState(); };
for (const id of ['filter', 'statusFilter', 'events']) $(id).addEventListener('input', redraw);
$('freeze').onclick = () => {
  frozen = !frozen; $('freeze').setAttribute('aria-pressed', String(frozen)); $('freeze').textContent = frozen ? 'Unfreeze' : 'Freeze';
  if (!frozen) { const q = queue; queue = []; $('frozen').hidden = true; q.forEach(handle); }
};
$('clear').onclick = () => { lines.length = 0; rows.clear(); $('log').textContent = ''; stats = { live: 0, held: 0, ok: 0, denied: 0, error: 0 }; showStats(); };
$('copy').onclick = async () => {
  const text = lines.filter(matches).map(i => i.kind === 'event' ? `${clock(i.ts)}  event ${i.type} ${i.text}` : `${clock(i.entry.ts)}  ${i.entry.status.padEnd(7)} ${i.entry.tool} ${i.entry.tabId != null ? 'tab ' + i.entry.tabId : ''} ${i.entry.host} ${i.entry.summary} ${i.entry.error}`.trim()).join('\n');
  try { await navigator.clipboard.writeText(text); $('copy').textContent = 'Copied'; setTimeout(() => { $('copy').textContent = 'Copy'; }, 1200); } catch (e) {}
};
$('log').addEventListener('wheel', e => { if (e.deltaY < 0) $('follow').checked = false; }, { passive: true });

(async function start() {
  const hist = (await send({ type: 'audit' })) || [];
  hist.slice(-300).forEach(applyEntry);
  const live = (await send({ type: 'snapshot' })) || { live: [] };
  (live.live || []).forEach(applyEntry);
  const connect = () => {
    const port = chrome.runtime.connect({ name: 'live' });
    port.onMessage.addListener(handle);
    port.onDisconnect.addListener(() => setTimeout(connect, 1000)); // the worker sleeps now and then
  };
  connect(); refreshState(); setInterval(refreshState, 4000);
})();
