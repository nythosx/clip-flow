import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  useSettingsStore,
  SETTING_DEFAULT_TEMPLATE_ID,
  SETTING_DEFAULT_ENCODING,
  SETTING_TIKTOK_CLIENT_KEY,
  SETTING_TIKTOK_CLIENT_SECRET,
  SETTING_YOUTUBE_CLIENT_ID,
  SETTING_YOUTUBE_CLIENT_SECRET,
  SETTING_YOUTUBE_API_KEY,
  SETTING_FACEBOOK_APP_ID,
  SETTING_FACEBOOK_APP_SECRET,
  SETTING_SOUND_ALERTS_ENABLED,
  SETTING_VOICE_GENDER,
} from "../stores/settingsStore";
import { useTemplateStore, TemplateConfig } from "../stores/templateStore";
import { previewVoice } from "../lib/soundManager";

type DefaultEncoding = TemplateConfig["encoding"];

const FALLBACK_ENCODING: DefaultEncoding = {
  codec: "h264",
  crf: 23,
  preset: "veryfast",
  maxResolution: 1080,
  audioBitrate: "192k",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <label className="text-neutral-400">{label}</label>
      {children}
    </div>
  );
}

export default function Settings() {
  const { settings, appDataDir, fetchSettings, fetchAppDataDir, setSetting } = useSettingsStore();
  const { templates, fetchTemplates } = useTemplateStore();
  const [encoding, setEncoding] = useState<DefaultEncoding>(FALLBACK_ENCODING);
  const [saved, setSaved] = useState(false);
  const [tiktokClientKey, setTiktokClientKey] = useState("");
  const [tiktokClientSecret, setTiktokClientSecret] = useState("");
  const [tiktokSaved, setTiktokSaved] = useState(false);
  const [youtubeClientId, setYoutubeClientId] = useState("");
  const [youtubeClientSecret, setYoutubeClientSecret] = useState("");
  const [youtubeApiKey, setYoutubeApiKey] = useState("");
  const [youtubeSaved, setYoutubeSaved] = useState(false);
  const [facebookAppId, setFacebookAppId] = useState("");
  const [facebookAppSecret, setFacebookAppSecret] = useState("");
  const [facebookSaved, setFacebookSaved] = useState(false);

  useEffect(() => {
    fetchSettings();
    fetchAppDataDir();
    fetchTemplates();
  }, [fetchSettings, fetchAppDataDir, fetchTemplates]);

  useEffect(() => {
    setTiktokClientKey(settings[SETTING_TIKTOK_CLIENT_KEY] ?? "");
    setTiktokClientSecret(settings[SETTING_TIKTOK_CLIENT_SECRET] ?? "");
    setYoutubeClientId(settings[SETTING_YOUTUBE_CLIENT_ID] ?? "");
    setYoutubeClientSecret(settings[SETTING_YOUTUBE_CLIENT_SECRET] ?? "");
    setYoutubeApiKey(settings[SETTING_YOUTUBE_API_KEY] ?? "");
  }, [settings]);

  async function saveTikTokCredentials() {
    await setSetting(SETTING_TIKTOK_CLIENT_KEY, tiktokClientKey);
    await setSetting(SETTING_TIKTOK_CLIENT_SECRET, tiktokClientSecret);
    setTiktokSaved(true);
    setTimeout(() => setTiktokSaved(false), 1500);
  }

  async function saveYouTubeCredentials() {
    await setSetting(SETTING_YOUTUBE_CLIENT_ID, youtubeClientId);
    await setSetting(SETTING_YOUTUBE_CLIENT_SECRET, youtubeClientSecret);
    await setSetting(SETTING_YOUTUBE_API_KEY, youtubeApiKey);
    setYoutubeSaved(true);
    setTimeout(() => setYoutubeSaved(false), 1500);
  }

  useEffect(() => {
    setFacebookAppId(settings[SETTING_FACEBOOK_APP_ID] ?? "");
    setFacebookAppSecret(settings[SETTING_FACEBOOK_APP_SECRET] ?? "");
  }, [settings]);

  async function saveFacebookCredentials() {
    await setSetting(SETTING_FACEBOOK_APP_ID, facebookAppId);
    await setSetting(SETTING_FACEBOOK_APP_SECRET, facebookAppSecret);
    setFacebookSaved(true);
    setTimeout(() => setFacebookSaved(false), 1500);
  }

  useEffect(() => {
    const raw = settings[SETTING_DEFAULT_ENCODING];
    if (raw) {
      try {
        setEncoding(JSON.parse(raw));
      } catch {

      }
    }
  }, [settings]);

  async function saveEncoding() {
    await setSetting(SETTING_DEFAULT_ENCODING, JSON.stringify(encoding));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-semibold mb-6">Settings</h1>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 mb-6">
          <h2 className="text-sm font-medium text-neutral-300 mb-3">Default template</h2>
          <p className="text-xs text-neutral-500 mb-3">
            Pre-selected in the "Render final" template picker on a project's clip list.
          </p>
          <select
            className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm"
            value={settings[SETTING_DEFAULT_TEMPLATE_ID] ?? ""}
            onChange={(e) => setSetting(SETTING_DEFAULT_TEMPLATE_ID, e.target.value)}
          >
            <option value="">None (first template in list)</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 mb-6 space-y-3">
          <h2 className="text-sm font-medium text-neutral-300">Sound & voice alerts</h2>
          <p className="text-xs text-neutral-500">
            A short spoken line on big milestones (analysis complete, Auto Upload finished,
            all uploads done, or something failing) plus a quick success/error chime on each
            individual render and upload.
          </p>
          <Field label="Enabled">
            <input
              type="checkbox"
              className="accent-blue-500 w-4 h-4"
              checked={(settings[SETTING_SOUND_ALERTS_ENABLED] ?? "true") !== "false"}
              onChange={(e) => setSetting(SETTING_SOUND_ALERTS_ENABLED, e.target.checked ? "true" : "false")}
            />
          </Field>
          <Field label="Voice">
            <select
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
              value={settings[SETTING_VOICE_GENDER] === "female" ? "female" : "male"}
              onChange={(e) => setSetting(SETTING_VOICE_GENDER, e.target.value)}
            >
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </Field>
          <button
            className="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-xs"
            onClick={() => previewVoice("analysisComplete")}
          >
            ▶ Preview voice
          </button>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 mb-6 space-y-3">
          <h2 className="text-sm font-medium text-neutral-300">Default encoding for new templates</h2>
          <p className="text-xs text-neutral-500">
            Used to pre-fill the Encoding section when you create a new template — each
            template can still override these individually.
          </p>

          <Field label="Codec">
            <select
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
              value={encoding.codec}
              onChange={(e) => setEncoding({ ...encoding, codec: e.target.value as "h264" | "h265" })}
            >
              <option value="h264">H.264</option>
              <option value="h265">H.265</option>
            </select>
          </Field>
          <Field label="Quality (CRF)">
            <input
              type="range"
              min={18}
              max={28}
              value={encoding.crf}
              onChange={(e) => setEncoding({ ...encoding, crf: Number(e.target.value) })}
            />
          </Field>
          <Field label="Preset">
            <select
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
              value={encoding.preset}
              onChange={(e) => setEncoding({ ...encoding, preset: e.target.value as DefaultEncoding["preset"] })}
            >
              <option value="ultrafast">Ultrafast</option>
              <option value="superfast">Superfast</option>
              <option value="veryfast">Veryfast</option>
              <option value="faster">Faster</option>
              <option value="fast">Fast</option>
              <option value="medium">Medium</option>
            </select>
          </Field>
          <Field label="Max resolution">
            <select
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
              value={encoding.maxResolution}
              onChange={(e) =>
                setEncoding({ ...encoding, maxResolution: Number(e.target.value) as 480 | 720 | 1080 })
              }
            >
              <option value={480}>480p</option>
              <option value={720}>720p</option>
              <option value={1080}>1080p</option>
            </select>
          </Field>
          <Field label="Audio bitrate">
            <select
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
              value={encoding.audioBitrate}
              onChange={(e) =>
                setEncoding({ ...encoding, audioBitrate: e.target.value as DefaultEncoding["audioBitrate"] })
              }
            >
              <option value="128k">128k</option>
              <option value="192k">192k</option>
              <option value="256k">256k</option>
            </select>
          </Field>

          <div className="flex items-center gap-3 pt-2">
            <button
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm"
              onClick={saveEncoding}
            >
              Save
            </button>
            {saved && <span className="text-xs text-green-400">Saved</span>}
          </div>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 mb-6 space-y-3">
          <h2 className="text-sm font-medium text-neutral-300">TikTok app</h2>
          <p className="text-xs text-neutral-500">
            From your app's page in the{" "}
            <a
              className="underline"
              href="https://developers.tiktok.com/apps"
              target="_blank"
              rel="noreferrer"
            >
              TikTok Developer Portal
            </a>
            . Used to connect real TikTok accounts under Accounts → Connect with TikTok.
          </p>
          <div className="space-y-1">
            <label className="text-sm text-neutral-400">Client key</label>
            <input
              className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm font-mono"
              value={tiktokClientKey}
              onChange={(e) => setTiktokClientKey(e.target.value)}
              placeholder="awdsin2xuhv401d9"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm text-neutral-400">Client secret</label>
            <input
              type="password"
              className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm font-mono"
              value={tiktokClientSecret}
              onChange={(e) => setTiktokClientSecret(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3 pt-2">
            <button
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm"
              onClick={saveTikTokCredentials}
            >
              Save
            </button>
            {tiktokSaved && <span className="text-xs text-green-400">Saved</span>}
          </div>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 mb-6 space-y-3">
          <h2 className="text-sm font-medium text-neutral-300">YouTube app</h2>
          <p className="text-xs text-neutral-500">
            From your project's{" "}
            <a
              className="underline"
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noreferrer"
            >
              Google Cloud credentials page
            </a>{" "}
            — Client ID/secret from a "Desktop app" OAuth client (used to connect real
            YouTube channels under Accounts → Connect with YouTube), API key from an API key
            credential (used for search and public video lookups, no sign-in required).
          </p>
          <div className="space-y-1">
            <label className="text-sm text-neutral-400">Client ID</label>
            <input
              className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm font-mono"
              value={youtubeClientId}
              onChange={(e) => setYoutubeClientId(e.target.value)}
              placeholder="xxxxx.apps.googleusercontent.com"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm text-neutral-400">Client secret</label>
            <input
              type="password"
              className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm font-mono"
              value={youtubeClientSecret}
              onChange={(e) => setYoutubeClientSecret(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm text-neutral-400">API key</label>
            <input
              type="password"
              className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm font-mono"
              value={youtubeApiKey}
              onChange={(e) => setYoutubeApiKey(e.target.value)}
            />
          </div>
          <p className="text-xs text-neutral-500">
            Importing a searched video downloads it via <code>yt-dlp</code> (must be
            installed on PATH separately) so it can be cut into clips/parts the same way as
            a locally-picked movie file.
          </p>
          <div className="flex items-center gap-3 pt-2">
            <button
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm"
              onClick={saveYouTubeCredentials}
            >
              Save
            </button>
            {youtubeSaved && <span className="text-xs text-green-400">Saved</span>}
          </div>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 mb-6 space-y-3">
          <h2 className="text-sm font-medium text-neutral-300">Facebook app</h2>
          <p className="text-xs text-neutral-500">
            From your app's page in the{" "}
            <a
              className="underline"
              href="https://developers.facebook.com/apps"
              target="_blank"
              rel="noreferrer"
            >
              Meta for Developers
            </a>{" "}
            console — add a Facebook Login product and register{" "}
            <code>http://localhost:53684/callback</code> under Valid OAuth Redirect URIs.
            Used to connect Pages (and, once App Review grants{" "}
            <code>publish_video</code> on the user token, the personal profile) under
            Accounts → Connect with Facebook.
          </p>
          <div className="space-y-1">
            <label className="text-sm text-neutral-400">App ID</label>
            <input
              className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm font-mono"
              value={facebookAppId}
              onChange={(e) => setFacebookAppId(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm text-neutral-400">App secret</label>
            <input
              type="password"
              className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm font-mono"
              value={facebookAppSecret}
              onChange={(e) => setFacebookAppSecret(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3 pt-2">
            <button
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm"
              onClick={saveFacebookCredentials}
            >
              Save
            </button>
            {facebookSaved && <span className="text-xs text-green-400">Saved</span>}
          </div>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 mb-6 space-y-2">
          <h2 className="text-sm font-medium text-neutral-300">Legal</h2>
          <div className="flex flex-wrap gap-4 text-sm">
            <Link className="text-blue-400 hover:text-blue-300 underline" to="/legal">
              View in ClipFlow
            </Link>
            <a
              className="text-blue-400 hover:text-blue-300 underline"
              href="https://clipflow24.netlify.app/terms"
              target="_blank"
              rel="noreferrer"
            >
              Terms of Service (web)
            </a>
            <a
              className="text-blue-400 hover:text-blue-300 underline"
              href="https://clipflow24.netlify.app/privacy"
              target="_blank"
              rel="noreferrer"
            >
              Privacy Policy (web)
            </a>
          </div>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-sm space-y-1">
          <h2 className="text-sm font-medium text-neutral-300 mb-2">Storage (read-only)</h2>
          <p className="text-neutral-400 break-all">
            Preview renders: <span className="text-neutral-200">{appDataDir}\renders</span>
          </p>
          <p className="text-neutral-400 break-all">
            Final renders: <span className="text-neutral-200">{appDataDir}\renders\final</span>
          </p>
          <p className="text-xs text-neutral-500 mt-2">
            Not configurable yet — the render directory is fixed to the app's own data
            folder because Tauri's asset-protocol scope (needed to play rendered videos
            in-app) is set at build time, not runtime.
          </p>
        </div>
      </div>
    </div>
  );
}
