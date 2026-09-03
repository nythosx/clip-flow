import { useSettingsStore, SETTING_SOUND_ALERTS_ENABLED, SETTING_VOICE_GENDER } from "../stores/settingsStore";

// Pre-recorded audio, not live TTS at runtime — generated once via ElevenLabs (see
// ad-creation-playbook.md's TTS section) and bundled as static assets under public/audio/.
// Playing them is just an <audio> element, no network call, no API key involved at runtime.
export type VoiceLineId = "analysisComplete" | "autoUploadComplete" | "uploadsDone" | "errorAlert";
export type SfxId = "success" | "error";

const VOICE_FILES: Record<VoiceLineId, string> = {
  analysisComplete: "analysis-complete.mp3",
  autoUploadComplete: "auto-upload-complete.mp3",
  uploadsDone: "uploads-done.mp3",
  errorAlert: "error-alert.mp3",
};

const SFX_FILES: Record<SfxId, string> = {
  success: "success.wav",
  error: "error.wav",
};

function soundsEnabled(): boolean {
  // Defaults to enabled — absence of the setting (fresh install, never touched Settings)
  // means "on", matching every other boolean setting in this app's settings-table pattern.
  return useSettingsStore.getState().settings[SETTING_SOUND_ALERTS_ENABLED] !== "false";
}

function voiceGender(): "male" | "female" {
  return useSettingsStore.getState().settings[SETTING_VOICE_GENDER] === "female" ? "female" : "male";
}

function play(src: string) {
  try {
    const audio = new Audio(src);
    // Playback can legitimately fail (e.g. no audio device) — never let a notification
    // sound crash or reject-log the actual action it's celebrating/reporting.
    void audio.play().catch(() => {});
  } catch {
    // ignore
  }
}

export function playVoice(id: VoiceLineId) {
  if (!soundsEnabled()) return;
  play(`/audio/voice/${voiceGender()}/${VOICE_FILES[id]}`);
}

// Ignores the enabled toggle — used by Settings' "Preview voice" button so auditioning a
// voice works even while alerts are currently switched off.
export function previewVoice(id: VoiceLineId) {
  play(`/audio/voice/${voiceGender()}/${VOICE_FILES[id]}`);
}

export function playSfx(id: SfxId) {
  if (!soundsEnabled()) return;
  play(`/audio/sfx/${SFX_FILES[id]}`);
}

// Failures across different pipelines (analysis, auto upload) shouldn't each fire their own
// "something went wrong" line back-to-back if several land within the same few seconds —
// one spoken alert is enough to get the user's attention.
let lastErrorVoiceAt = 0;
const ERROR_VOICE_DEBOUNCE_MS = 8000;

export function playErrorVoiceDebounced() {
  const now = Date.now();
  if (now - lastErrorVoiceAt < ERROR_VOICE_DEBOUNCE_MS) return;
  lastErrorVoiceAt = now;
  playVoice("errorAlert");
}
