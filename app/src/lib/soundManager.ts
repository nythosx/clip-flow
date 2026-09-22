import { useSettingsStore, SETTING_SOUND_ALERTS_ENABLED, SETTING_VOICE_GENDER } from "../stores/settingsStore";

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

  return useSettingsStore.getState().settings[SETTING_SOUND_ALERTS_ENABLED] !== "false";
}

function voiceGender(): "male" | "female" {
  return useSettingsStore.getState().settings[SETTING_VOICE_GENDER] === "female" ? "female" : "male";
}

function play(src: string) {
  try {
    const audio = new Audio(src);

    void audio.play().catch(() => {});
  } catch {

  }
}

export function playVoice(id: VoiceLineId) {
  if (!soundsEnabled()) return;
  play(`/audio/voice/${voiceGender()}/${VOICE_FILES[id]}`);
}

export function previewVoice(id: VoiceLineId) {
  play(`/audio/voice/${voiceGender()}/${VOICE_FILES[id]}`);
}

export function playSfx(id: SfxId) {
  if (!soundsEnabled()) return;
  play(`/audio/sfx/${SFX_FILES[id]}`);
}

let lastErrorVoiceAt = 0;
const ERROR_VOICE_DEBOUNCE_MS = 8000;

export function playErrorVoiceDebounced() {
  const now = Date.now();
  if (now - lastErrorVoiceAt < ERROR_VOICE_DEBOUNCE_MS) return;
  lastErrorVoiceAt = now;
  playVoice("errorAlert");
}
