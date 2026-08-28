// Shared message-type and config constants used across cli/, native-host/, and extension/.
// Kept dependency-free (CommonJS + also usable via `var` fallback) so it can be copied
// into the extension bundle without a build step.
//
// ClipFlow's AI Engine exposes exactly 3 fixed functions (SPEC.md section 6): Smart
// Trimmer, Clip Finder, Caption Generator. These message types mirror the
// RustToSidecar/SidecarToRust WebSocket protocol SPEC.md section 6.2 defines for the
// eventual Rust <-> Node-sidecar boundary — the CLI here stands in for that future Rust
// caller.

const AI_MESSAGE_TYPES = {
  TRIM_ANALYSIS: 'trim_analysis', // -> { requestId, sessionKey?, transcript, duration }
  TRIM_RESULT: 'trim_result', // <- { requestId, segments: [{start,end}] }
  CLIP_FINDER: 'clip_finder', // -> { requestId, sessionKey?, transcript, count }
  CLIP_RESULT: 'clip_result', // <- { requestId, clips: [{start,end,hook}] }
  CAPTION_GENERATE: 'caption_generate', // -> { requestId, sessionKey?, excerpt, hook }
  CAPTION_RESULT: 'caption_result', // <- { requestId, caption: string, hashtags: string[] }
  CAPTION_REFINE: 'caption_refine', // -> { requestId, sessionKey?, items: [{id, excerpt, caption}] }
  CAPTION_REFINE_RESULT: 'caption_refine_result', // <- { requestId, items: [{id, caption}] }
  TRENDING_HASHTAGS: 'trending_hashtags', // -> { requestId, sessionKey?, niche }
  TRENDING_HASHTAGS_RESULT: 'trending_hashtags_result', // <- { requestId, hashtags: string[] }
  MOVIE_SEGMENTER: 'movie_segmenter', // -> { requestId, sessionKey?, transcript, duration }
  MOVIE_SEGMENTER_RESULT: 'movie_segmenter_result', // <- { requestId, parts: [{start,end}] }
  AI_ERROR: 'ai_error', // <- { requestId, error }
  CAPTCHA_DETECTED: 'captcha_detected', // <- (no requestId — global, user must intervene)
  CLOSE_SESSION: 'close_session', // -> { requestId, sessionKey }
  SESSION_CLOSED: 'session_closed', // <- { requestId, closed, reason? }
};

const HOST_MESSAGE_TYPES = {
  CLI_TO_EXT: 'cli_to_ext',
  EXT_TO_CLI: 'ext_to_cli',
};

const DEFAULT_CONFIG = {
  migrationThreshold: 40, // messages in one chat before auto-migrating to a fresh tab
  minAiCallIntervalMs: 30000, // SPEC.md section 6: minimum delay between AI calls
  stealth: {
    typingDelay: [50, 150],
    actionDelay: [200, 800],
    minMessageInterval: 2000,
    maxMessageInterval: 5000,
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AI_MESSAGE_TYPES,
    HOST_MESSAGE_TYPES,
    DEFAULT_CONFIG,
  };
}
