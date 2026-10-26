const $ = id => document.getElementById(id);
const DEFAULTS = { enabled: true, gate: true, highlightTabs: true, scope: 'all', perm_read: 'allow', perm_nav: 'allow', perm_input: 'allow', perm_script: 'ask' };
const PERMS = [['read', 'Read'], ['nav', 'Navigate'], ['input', 'Input'], ['script', 'Scripts']];
let snap = null, tabId = null;

const send = m => new Promise(res => chrome.runtime.sendMessage(m, r => { void chrome.runtime.lastError; res(r); }));
const ago = ts => { const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function row(a, live) {
  const li = el('li');
  li.append(el('span', 'dot ' + (live ? 'live' : a.status)));
  const t = el('div', 't');
  t.append(el('b', null, a.tool.replace(/_/g, ' ')));
  const detail = [a.host, a.summary, a.error].filter(Boolean).join('  ·  ');
  const d = el('div', null, detail || (a.client || ''));
  d.title = [a.client, detail].filter(Boolean).join('\n');
  t.append(d);
  li.append(t, el('span', 'when', live ? (a.status === 'held' ? 'held' : 'now') : ago(a.ts) + (a.ms ? ' · ' + a.ms + 'ms' : '')));
  return li;
}

function render() {
  const s = snap;
  const chip = $('state');
  let label = 'Not connected', cls = 'bad';
  if (!s.enabled) { label = 'Off'; cls = ''; }
  else if (s.connected && s.paused) { label = 'Paused'; cls = 'warn'; }
  else if (s.connected) { label = 'Connected'; cls = 'ok'; }
  chip.textContent = label; chip.className = 'chip ' + cls; chip.title = s.connected ? '' : s.reason;

  const c = $('control');
  c.className = 'card control' + (s.paused ? ' paused' : '') + (!s.enabled ? ' off' : '');
  $('pause').textContent = s.paused ? 'Resume' : 'Pause';
  $('pause').className = 'btn grow ' + (s.paused ? 'warn' : 'primary');
  $('step').disabled = !s.paused;
  $('note').textContent = !s.enabled ? 'Control is turned off. Nothing can reach this browser.'
    : !s.connected ? s.reason
    : s.paused ? (s.held ? `Paused. ${s.held} command${s.held > 1 ? 's' : ''} waiting; Step lets one through.` : 'Paused. New commands will wait until you resume.')
    : s.live.length ? 'Running.' : 'Idle. Waiting for commands.';

  $('enabled').checked = !!s.enabled;
  $('gate').checked = !!s.gate;
  $('highlightTabs').checked = !!s.highlight;
  $('scope').value = s.scope;

  const perms = $('perms'); perms.textContent = '';
  for (const [k, name] of PERMS) {
    const box = el('label', 'perm ' + s.perms[k]);
    const sel = el('select'); sel.setAttribute('aria-label', name + ' permission');
    for (const v of ['allow', 'ask', 'block']) { const o = el('option', null, v[0].toUpperCase() + v.slice(1)); o.value = v; sel.append(o); }
    sel.value = s.perms[k];
    sel.onchange = () => chrome.storage.local.set({ ['perm_' + k]: sel.value });
    box.append(el('span', null, name), sel);
    perms.append(box);
  }

  const tab = s.tab;
  $('tabCard').hidden = !tab;
  if (tab) {
    tabId = tab.id;
    $('tabTitle').textContent = tab.title || '(untitled)';
    $('tabHost').textContent = tab.host || tab.url || '';
    $('shareRow').hidden = !(s.scope === 'own' && tab.web);
    $('share').checked = tab.owned;
  }

  $('ctlWrap').hidden = !s.controlled.length;
  const ctl = $('ctl'); ctl.textContent = '';
  for (const t of s.controlled) {
    const li = el('li');
    li.append(el('span', 'dot ' + (t.busy ? 'live' : t.owned ? 'owned' : 'shared')));
    const box = el('div', 't'); const b = el('b', null, t.title || '(untitled)');
    b.append(el('span', 'tag', t.owned ? 'agent' : 'shared'));
    box.append(b, el('div', null, (t.host || '') + (t.attached ? '  ·  debugger attached' : '')));
    const acts = el('div', 'acts');
    const go = el('button', 'btn small', 'Show'); go.onclick = () => send({ type: 'focus', tabId: t.id });
    const rel = el('button', 'btn small', 'Release'); rel.title = 'Take this tab back: stop sharing, detach and leave the group'; rel.onclick = async () => { await send({ type: 'release', tabId: t.id }); refresh(); };
    acts.append(go, rel); li.append(box, acts); ctl.append(li);
  }

  $('liveWrap').hidden = !s.live.length;
  const live = $('live'); live.textContent = '';
  s.live.forEach(a => live.append(row(a, true)));

  const rec = $('recent'); rec.textContent = '';
  s.recent.slice(0, 8).forEach(a => rec.append(row(a, false)));
  $('empty').hidden = s.recent.length > 0;

  const parts = [];
  if (s.clients.length) parts.push(s.clients.join(', '));
  if (s.attached) parts.push(s.attached + ' attached tab' + (s.attached > 1 ? 's' : ''));
  if (s.locked) parts.push(s.locked + ' CAPTCHA locked');
  $('foot').textContent = parts.join(' · ') || 'No client has called yet';
  $('revoke').hidden = !s.approvals;
  $('revoke').textContent = `Revoke ${s.approvals} approval${s.approvals > 1 ? 's' : ''}`;
}

async function refresh() {
  const s = await send({ type: 'snapshot' });
  if (s) { snap = s; render(); }
}

$('pause').onclick = async () => { await send({ type: 'ctl', action: snap && snap.paused ? 'resume' : 'pause' }); refresh(); };
$('step').onclick = async () => { await send({ type: 'ctl', action: 'step' }); refresh(); };
$('stop').onclick = async () => { await send({ type: 'ctl', action: 'stop' }); refresh(); };
$('enabled').onchange = e => chrome.storage.local.set({ enabled: e.target.checked }).then(() => setTimeout(refresh, 300));
$('gate').onchange = e => chrome.storage.local.set({ gate: e.target.checked });
$('scope').onchange = e => chrome.storage.local.set({ scope: e.target.value }).then(() => setTimeout(refresh, 200));
$('share').onchange = async e => { await send({ type: 'share', tabId, on: e.target.checked }); refresh(); };
$('highlightTabs').onchange = e => chrome.storage.local.set({ highlightTabs: e.target.checked });
$('monitor').onclick = e => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('monitor.html') }); window.close(); };
$('revoke').onclick = async () => { await send({ type: 'revoke' }); refresh(); };
$('settings').onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
$('more').onclick = e => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('options.html#activity') }); window.close(); };

chrome.storage.local.get(DEFAULTS).then(refresh);
// Realtime: the worker nudges this page whenever something changes; the timer is only a safety net.
let nudge = null;
const port = chrome.runtime.connect({ name: 'live' });
port.onMessage.addListener(m => { if (m.type === 'changed' || m.type === 'entry') { clearTimeout(nudge); nudge = setTimeout(refresh, 60); } });
setInterval(refresh, 3000);
