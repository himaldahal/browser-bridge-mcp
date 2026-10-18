const DEFAULTS = { token: '', port: 17333, enabled: true, blocked: '' };
const $ = id => document.getElementById(id);

async function load() {
  const c = await chrome.storage.local.get(DEFAULTS);
  $('token').value = c.token;
  $('port').value = c.port;
  $('enabled').checked = c.enabled;
  $('blocked').value = c.blocked;
  refresh();
}

async function refresh() {
  let st = { connected: false, reason: 'background not responding' };
  try { st = await chrome.runtime.sendMessage({ type: 'status' }); } catch (e) {}
  const el = $('status');
  el.className = st.connected ? 'on' : 'off';
  el.textContent = st.connected ? 'Connected to the local bridge.' : 'Not connected: ' + st.reason;
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    token: $('token').value.trim(),
    port: Number($('port').value) || DEFAULTS.port,
    enabled: $('enabled').checked,
    blocked: $('blocked').value,
  });
  setTimeout(refresh, 800);
});

load();
setInterval(refresh, 2000);
