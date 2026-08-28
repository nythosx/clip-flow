// MV3 service worker. Classic script (not a module) so importScripts shares one global scope.
importScripts(
  'lib/protocol.js',
  'lib/nativeBridge.js',
  'lib/tabs.js',
  'lib/responseParser.js',
  'lib/orchestrator.js'
);

async function handleCliPayload(payload) {
  if (!payload || !payload.type) return;
  const { requestId } = payload;

  try {
    switch (payload.type) {
      case AI_MESSAGE_TYPES.TRIM_ANALYSIS: {
        const segments = await Orchestrator.runSmartTrimmer(payload);
        NativeBridge.sendToCli({ type: AI_MESSAGE_TYPES.TRIM_RESULT, requestId, segments });
        break;
      }
      case AI_MESSAGE_TYPES.CLIP_FINDER: {
        const clips = await Orchestrator.runClipFinder(payload);
        NativeBridge.sendToCli({ type: AI_MESSAGE_TYPES.CLIP_RESULT, requestId, clips });
        break;
      }
      case AI_MESSAGE_TYPES.CAPTION_GENERATE: {
        const { caption, hashtags } = await Orchestrator.runCaptionGenerator(payload);
        NativeBridge.sendToCli({ type: AI_MESSAGE_TYPES.CAPTION_RESULT, requestId, caption, hashtags });
        break;
      }
      case AI_MESSAGE_TYPES.CAPTION_REFINE: {
        const items = await Orchestrator.runCaptionRefiner(payload);
        NativeBridge.sendToCli({ type: AI_MESSAGE_TYPES.CAPTION_REFINE_RESULT, requestId, items });
        break;
      }
      case AI_MESSAGE_TYPES.TRENDING_HASHTAGS: {
        const hashtags = await Orchestrator.runTrendingHashtags(payload);
        NativeBridge.sendToCli({ type: AI_MESSAGE_TYPES.TRENDING_HASHTAGS_RESULT, requestId, hashtags });
        break;
      }
      case AI_MESSAGE_TYPES.MOVIE_SEGMENTER: {
        const parts = await Orchestrator.runMovieSegmenter(payload);
        NativeBridge.sendToCli({ type: AI_MESSAGE_TYPES.MOVIE_SEGMENTER_RESULT, requestId, parts });
        break;
      }
      case AI_MESSAGE_TYPES.CLOSE_SESSION: {
        const result = await Orchestrator.closeSession(payload.sessionKey);
        NativeBridge.sendToCli({ type: AI_MESSAGE_TYPES.SESSION_CLOSED, requestId, ...result });
        break;
      }
      default:
      // unrecognized message type — nothing for the orchestrator to do
    }
  } catch (err) {
    console.error('[background] AI call failed', err);
    NativeBridge.sendToCli({ type: AI_MESSAGE_TYPES.AI_ERROR, requestId, error: err.message });
  }
}

NativeBridge.setOnCliPayload(handleCliPayload);
NativeBridge.setOnDisconnect(() => {
  console.warn('[background] native host connection lost; reconnecting.');
  NativeBridge.connect();
});

// connect() is idempotent (no-op if a port is already open), so it's safe to call
// from every event that might be this service worker's first wake-up.
chrome.runtime.onStartup.addListener(() => NativeBridge.connect());
chrome.runtime.onInstalled.addListener(() => NativeBridge.connect());
NativeBridge.connect();

// MV3 service workers suspend after ~30s idle, which silently drops the native-messaging
// port (no disconnect event fires — the whole worker is torn down). A periodic alarm is
// the standard way to force Chrome to wake this worker back up; each firing just
// re-asserts the connection (connect() is a no-op if already open).
chrome.alarms.create('keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') NativeBridge.connect();
});

// Backs the popup's status readout + "Reconnect" button (popup.js). A popup is a separate
// script context from this service worker, so it can't call NativeBridge directly — this is
// the only way for it to see/affect the live native-messaging port.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'CLIPFLOW_GET_STATUS') {
    sendResponse({ connected: NativeBridge.isConnected() });
    return;
  }
  if (msg.type === 'CLIPFLOW_RECONNECT') {
    NativeBridge.reconnect();
    // connectNative() itself is synchronous (it just spawns the host process and returns a
    // port), but the port only proves itself alive once the host's first message round-trip
    // happens — give it a beat before reporting status back so "Reconnect" doesn't just
    // immediately show the same stale state it started from.
    setTimeout(() => sendResponse({ connected: NativeBridge.isConnected() }), 700);
    return true; // keep the message channel open for the async sendResponse above
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [sessionKey, session] of Orchestrator.sessions.entries()) {
    if (session.tabId === tabId) {
      console.warn(`[background] chat tab for session "${sessionKey}" closed unexpectedly.`);
      session.tabId = null;
    }
  }
});
