import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export const SETTING_DEFAULT_TEMPLATE_ID = "default_template_id";
export const SETTING_DEFAULT_ENCODING = "default_encoding";
export const SETTING_TIKTOK_CLIENT_KEY = "tiktok_client_key";
export const SETTING_TIKTOK_CLIENT_SECRET = "tiktok_client_secret";
export const SETTING_YOUTUBE_CLIENT_ID = "youtube_client_id";
export const SETTING_YOUTUBE_CLIENT_SECRET = "youtube_client_secret";
export const SETTING_YOUTUBE_API_KEY = "youtube_api_key";
export const SETTING_FACEBOOK_APP_ID = "facebook_app_id";
export const SETTING_FACEBOOK_APP_SECRET = "facebook_app_secret";
// "true"/"false" (as a settings-table string, not a real bool) — master on/off for both the
// voice-line and SFX playback in lib/soundManager.ts.
export const SETTING_SOUND_ALERTS_ENABLED = "sound_alerts_enabled";
export const SETTING_VOICE_GENDER = "voice_gender"; // "male" | "female"

interface SettingsStore {
  settings: Record<string, string>;
  appDataDir: string | null;
  isLoading: boolean;
  fetchSettings: () => Promise<void>;
  fetchAppDataDir: () => Promise<void>;
  setSetting: (key: string, value: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: {},
  appDataDir: null,
  isLoading: false,

  fetchSettings: async () => {
    set({ isLoading: true });
    try {
      const settings = await invoke<Record<string, string>>("get_settings");
      set({ settings, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  fetchAppDataDir: async () => {
    const appDataDir = await invoke<string>("get_app_data_dir");
    set({ appDataDir });
  },

  setSetting: async (key, value) => {
    await invoke("set_setting", { key, value });
    set({ settings: { ...get().settings, [key]: value } });
  },
}));
