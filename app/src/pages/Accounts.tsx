import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccountStore, AccountPlatform } from "../stores/accountStore";
import { useOnlineStore } from "../stores/onlineStore";
import { PLATFORM_LABELS, PLATFORM_BADGE_CLASSES, parseCredentials, formatCount } from "../lib/accountDisplay";

function AddAccountDialog({
  onClose,
  showToast,
}: {
  onClose: () => void;
  showToast: (type: "success" | "error", message: string) => void;
}) {
  const [platform, setPlatform] = useState<AccountPlatform>("tiktok");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectTikTok = useAccountStore((s) => s.connectTikTok);
  const connectYouTube = useAccountStore((s) => s.connectYouTube);
  const connectFacebook = useAccountStore((s) => s.connectFacebook);
  const isOnline = useOnlineStore((s) => s.isOnline);

  async function connectTikTokAccount() {
    setSubmitting(true);
    setError(null);
    try {
      await connectTikTok();
      const name = useAccountStore.getState().accounts[0]?.accountName ?? "TikTok account";
      showToast("success", `Connected ${name}`);
      onClose();
    } catch (e) {
      setError(String(e));
      showToast("error", `TikTok connect failed: ${String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function connectYouTubeAccount() {
    setSubmitting(true);
    setError(null);
    try {
      await connectYouTube();
      const name = useAccountStore.getState().accounts[0]?.accountName ?? "YouTube channel";
      showToast("success", `Connected ${name}`);
      onClose();
    } catch (e) {
      setError(String(e));
      showToast("error", `YouTube connect failed: ${String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function connectFacebookAccount() {
    setSubmitting(true);
    setError(null);
    try {
      await connectFacebook();
      showToast("success", "Facebook connected — personal profile and Pages synced");
      onClose();
    } catch (e) {
      setError(String(e));
      showToast("error", `Facebook connect failed: ${String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-neutral-900 text-neutral-100 rounded-lg p-6 w-[440px] space-y-4 border border-neutral-700">
        <h2 className="text-lg font-semibold">Add account</h2>

        <div className="space-y-1">
          <label className="text-sm text-neutral-400">Platform</label>
          <select
            className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm"
            value={platform}
            onChange={(e) => setPlatform(e.target.value as AccountPlatform)}
          >
            <option value="tiktok">TikTok</option>
            <option value="youtube">YouTube</option>
            <option value="facebook">Facebook</option>
          </select>
        </div>

        {platform === "tiktok" && (
          <>
            <p className="text-xs text-neutral-500">
              Opens TikTok's login/consent screen in your browser. Requires the app's
              Client key/secret to be set under Settings → TikTok app first.
            </p>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button className="px-4 py-2 rounded text-sm hover:bg-neutral-800" onClick={onClose}>
                Cancel
              </button>
              <button
                className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm disabled:opacity-50"
                disabled={submitting || !isOnline}
                title={!isOnline ? "No internet connection" : undefined}
                onClick={connectTikTokAccount}
              >
                {submitting ? "Waiting for browser…" : "Connect with TikTok"}
              </button>
            </div>
          </>
        )}

        {platform === "youtube" && (
          <>
            <p className="text-xs text-neutral-500">
              Opens Google's account picker + consent screen in your browser. Requires the
              app's Client ID/secret and API key to be set under Settings → YouTube app
              first.
            </p>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button className="px-4 py-2 rounded text-sm hover:bg-neutral-800" onClick={onClose}>
                Cancel
              </button>
              <button
                className="px-4 py-2 rounded bg-red-600 hover:bg-red-500 text-sm disabled:opacity-50"
                disabled={submitting || !isOnline}
                title={!isOnline ? "No internet connection" : undefined}
                onClick={connectYouTubeAccount}
              >
                {submitting ? "Waiting for browser…" : "Connect with YouTube"}
              </button>
            </div>
          </>
        )}

        {platform === "facebook" && (
          <>
            <p className="text-xs text-neutral-500">
              Opens Facebook's login/consent screen in your browser. Connects your personal
              profile AND every Page you manage in one go. Requires the app's App ID/secret
              to be set under Settings → Facebook app first. Posting to a personal profile
              additionally needs Meta App Review before it actually works outside your own
              app's testers — connecting still succeeds either way.
            </p>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button className="px-4 py-2 rounded text-sm hover:bg-neutral-800" onClick={onClose}>
                Cancel
              </button>
              <button
                className="px-4 py-2 rounded bg-blue-700 hover:bg-blue-600 text-sm disabled:opacity-50"
                disabled={submitting || !isOnline}
                title={!isOnline ? "No internet connection" : undefined}
                onClick={connectFacebookAccount}
              >
                {submitting ? "Waiting for browser…" : "Connect with Facebook"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function Accounts() {
  const navigate = useNavigate();
  const { accounts, fetchAccounts, isLoading, deleteAccount, connectTikTok, connectYouTube, refreshFacebookAccount } =
    useAccountStore();
  const isOnline = useOnlineStore((s) => s.isOnline);
  const [showDialog, setShowDialog] = useState(false);
  // No confirmation was shown after a successful (or failed) reconnect — the account row
  // just quietly updates or doesn't, and it wasn't clear whether anything happened at all.
  // This surfaces both outcomes explicitly for every connect/reconnect action on this page.
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(type: "success" | "error", message: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ type, message });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  async function reconnectTikTok() {
    try {
      await connectTikTok();
      const name = useAccountStore.getState().accounts[0]?.accountName ?? "TikTok account";
      showToast("success", `Reconnected ${name}`);
    } catch (e) {
      showToast("error", `TikTok reconnect failed: ${String(e)}`);
    }
  }

  async function reconnectYouTube() {
    try {
      await connectYouTube();
      const name = useAccountStore.getState().accounts[0]?.accountName ?? "YouTube channel";
      showToast("success", `Reconnected ${name}`);
    } catch (e) {
      showToast("error", `YouTube reconnect failed: ${String(e)}`);
    }
  }

  async function refreshFacebook(id: string, name: string) {
    try {
      await refreshFacebookAccount(id);
      showToast("success", `Refreshed ${name}`);
    } catch (e) {
      showToast("error", `Facebook refresh failed: ${String(e)}`);
    }
  }


  return (
    <div className="p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">Accounts</h1>
          <button
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm"
            onClick={() => setShowDialog(true)}
          >
            + Add account
          </button>
        </div>

        <p className="text-xs text-neutral-500 mb-4">
          Connect TikTok or Facebook (Page or personal profile) accounts to post real clips
          via their official APIs, or connect a YouTube channel to manage which account to
          pick later (YouTube upload automation isn't implemented yet).
        </p>

        {isLoading && <p className="text-neutral-400 text-sm">Loading…</p>}
        {!isLoading && accounts.length === 0 && (
          <p className="text-neutral-400 text-sm">No accounts yet.</p>
        )}

        <div className="space-y-3">
          {accounts.map((a) => {
            const creds = parseCredentials(a);
            const stats = [
              ["Followers", formatCount(creds.followerCount)],
              ["Following", formatCount(creds.followingCount)],
              ["Likes", formatCount(creds.likesCount)],
              ["Subscribers", formatCount(creds.subscriberCount)],
              ["Views", formatCount(creds.viewCount)],
              ["Videos", formatCount(creds.videoCount)],
            ].filter(([, v]) => v !== null) as [string, string][];

            return (
              <div
                key={a.id}
                className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 hover:border-neutral-700 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/accounts/${a.id}`)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && navigate(`/accounts/${a.id}`)}
                    title="View account information and statistics"
                    className="flex items-start gap-3 min-w-0 text-left rounded hover:bg-neutral-800/60 -mx-1 px-1 py-0.5 transition-colors cursor-pointer"
                  >
                    {creds.avatarUrl ? (
                      <img
                        src={creds.avatarUrl}
                        alt=""
                        className="w-12 h-12 rounded-full object-cover border border-neutral-700 shrink-0"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center text-neutral-500 text-sm shrink-0">
                        {a.accountName.slice(0, 1).toUpperCase() || "?"}
                      </div>
                    )}

                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">{a.accountName}</span>
                        {creds.isVerified && (
                          <span title="Verified" className="text-blue-400 text-xs">
                            ✓
                          </span>
                        )}
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            PLATFORM_BADGE_CLASSES[a.platform] ?? "bg-neutral-700"
                          }`}
                        >
                          {PLATFORM_LABELS[a.platform] ?? a.platform}
                        </span>
                        {a.platform === "facebook" && creds.accountType && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 border border-neutral-700">
                            {creds.accountType === "page" ? creds.category || "Page" : "Personal profile"}
                          </span>
                        )}
                        {!a.isActive && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-900/60 text-yellow-300">
                            Inactive
                          </span>
                        )}
                      </div>

                      {creds.bioDescription && (
                        <p className="text-xs text-neutral-400 mt-1 line-clamp-2 max-w-md">{creds.bioDescription}</p>
                      )}

                      {stats.length > 0 && (
                        <div className="flex items-center gap-3 mt-2 flex-wrap">
                          {stats.map(([label, value]) => (
                            <span key={label} className="text-xs text-neutral-400">
                              <span className="text-neutral-100 font-medium">{value}</span> {label}
                            </span>
                          ))}
                        </div>
                      )}

                      <p className="text-xs text-neutral-600 mt-1">
                        Added {new Date(a.createdAt).toLocaleDateString()}
                        {creds.profileDeepLink && (
                          <>
                            {" · "}
                            <a
                              href={creds.profileDeepLink}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-neutral-500 hover:text-neutral-300 underline"
                            >
                              View profile
                            </a>
                          </>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {a.platform === "tiktok" && (
                      <button
                        className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1 disabled:opacity-50"
                        disabled={!isOnline}
                        onClick={reconnectTikTok}
                        title={!isOnline ? "No internet connection" : "Refresh token and profile info for this account"}
                      >
                        Reconnect
                      </button>
                    )}
                    {a.platform === "youtube" && (
                      <button
                        className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1 disabled:opacity-50"
                        disabled={!isOnline}
                        onClick={reconnectYouTube}
                        title={!isOnline ? "No internet connection" : "Refresh token and profile info for this account"}
                      >
                        Reconnect
                      </button>
                    )}
                    {a.platform === "facebook" && (
                      <button
                        className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1 disabled:opacity-50"
                        disabled={!isOnline}
                        onClick={() => refreshFacebook(a.id, a.accountName)}
                        title={
                          !isOnline
                            ? "No internet connection"
                            : "Refresh profile info for this account (no browser needed — Facebook Page tokens don't expire)"
                        }
                      >
                        Refresh
                      </button>
                    )}
                    <button
                      className="text-xs text-red-400 hover:text-red-300 px-2 py-1"
                      onClick={() => deleteAccount(a.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showDialog && <AddAccountDialog onClose={() => setShowDialog(false)} showToast={showToast} />}

      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 max-w-sm px-4 py-3 rounded-lg shadow-lg text-sm border ${
            toast.type === "success"
              ? "bg-emerald-950 border-emerald-700 text-emerald-200"
              : "bg-red-950 border-red-800 text-red-200"
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
