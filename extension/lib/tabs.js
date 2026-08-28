// Tab lifecycle + content-script messaging helpers for the background service worker.

const TabManager = (() => {
  // Toggle this to switch from the mock backend to the real site (readme.md step 10).
  // Requires being logged into chat.deepseek.com in this Chrome profile already — the
  // extension does not handle authentication. Unknown query params (role/taskId) are
  // harmless on the real site; it just ignores them.
  // const CHAT_BASE_URL = 'http://localhost:8080/chat';
  const CHAT_BASE_URL = 'https://chat.deepseek.com';

  // `purpose` is one of ClipFlow's 3 AI functions ('trim' | 'clips' | 'caption') — passed
  // as the `role` query param so the mock backend's scenario lookup (which keys turns by
  // that same param name) needs no changes.
  function chatUrl(purpose, requestId) {
    const url = new URL(CHAT_BASE_URL);
    url.searchParams.set('role', purpose);
    url.searchParams.set('taskId', requestId);
    return url.toString();
  }

  async function createChatTab(purpose, requestId) {
    const tab = await chrome.tabs.create({ url: chatUrl(purpose, requestId), active: false });
    return tab.id;
  }

  async function closeTabs(...tabIds) {
    const ids = tabIds.filter((id) => typeof id === 'number');
    if (ids.length) {
      try {
        await chrome.tabs.remove(ids);
      } catch (err) {
        console.warn('[TabManager] failed to close tabs', err.message);
      }
    }
  }

  async function sendToTab(tabId, message) {
    // Bring the tab to front first so interactions look human (stealth requirement).
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch (_) {
      // tab may have been closed; let the sendMessage call surface the error
    }
    return chrome.tabs.sendMessage(tabId, message);
  }

  // Sets DeepThink (extended reasoning) and Search on/off for a tab's session in one
  // round trip — content.js resolves each by its visible label text, not a brittle
  // hashed class name (see content.js's findToggleButtonByLabel).
  async function setToggles(tabId, { deepThink = false, webSearch = false } = {}) {
    return sendToTab(tabId, { action: 'setToggles', deepThink, webSearch });
  }

  async function waitForReady(tabId, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { action: 'waitForReady' });
        if (res && res.ready) return true;
      } catch (_) {
        // content script may not be injected yet; retry
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Tab ${tabId} did not become ready within ${timeoutMs}ms`);
  }

  return { chatUrl, createChatTab, closeTabs, sendToTab, setToggles, waitForReady };
})();
