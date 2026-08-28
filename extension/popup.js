// Popup for the toolbar icon dropdown — shows whether the native-messaging bridge to the
// ClipFlow desktop app is currently up, and lets you force a reconnect without having to
// dig into chrome://extensions and reload the whole extension.
const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const hint = document.getElementById('hint');
const reconnectBtn = document.getElementById('reconnectBtn');

function render(connected) {
  dot.className = 'dot ' + (connected ? 'connected' : 'disconnected');
  statusText.textContent = connected ? 'Connected' : 'Not connected';
  hint.textContent = connected
    ? 'The native host is bridged to the ClipFlow app.'
    : 'Make sure the ClipFlow desktop app is running, then try Refresh. If it stays disconnected, see AI_ENGINE_SETUP.md in the ClipFlow repo.';
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'CLIPFLOW_GET_STATUS' }, (res) => {
    render(!!(res && res.connected));
  });
}

reconnectBtn.addEventListener('click', () => {
  reconnectBtn.disabled = true;
  reconnectBtn.textContent = 'Reconnecting…';
  statusText.textContent = 'Reconnecting…';
  dot.className = 'dot';
  chrome.runtime.sendMessage({ type: 'CLIPFLOW_RECONNECT' }, (res) => {
    reconnectBtn.disabled = false;
    reconnectBtn.textContent = 'Refresh connection';
    render(!!(res && res.connected));
  });
});

refreshStatus();
