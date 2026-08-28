import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useAccountStore } from "../stores/accountStore";
import { useOnlineStore } from "../stores/onlineStore";
import {
  PLATFORM_LABELS,
  PLATFORM_BADGE_CLASSES,
  parseCredentials,
  formatCount,
  statsRefreshablePlatform,
} from "../lib/accountDisplay";

export default function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { accounts, fetchAccounts, isLoading, refreshFacebookAccount, refreshYouTubeAccount } = useAccountStore();
  const isOnline = useOnlineStore((s) => s.isOnline);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    if (accounts.length === 0) fetchAccounts();
  }, [accounts.length, fetchAccounts]);

  const account = accounts.find((a) => a.id === id);

  async function handleRefresh() {
    if (!account) return;
    const refresh = account.platform === "facebook" ? refreshFacebookAccount : refreshYouTubeAccount;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await refresh(account.id);
    } catch (e) {
      setRefreshError(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  if (!account) {
    return (
      <div className="p-8">
        <div className="max-w-2xl mx-auto">
          <button
            className="flex items-center gap-1.5 text-sm text-neutral-400 hover:text-neutral-200 mb-6"
            onClick={() => navigate("/accounts")}
          >
            <ArrowLeft size={16} /> Back to accounts
          </button>
          <p className="text-neutral-500 text-sm">{isLoading ? "Loading…" : "Account not found."}</p>
        </div>
      </div>
    );
  }

  const creds = parseCredentials(account);
  const canRefresh = statsRefreshablePlatform(account.platform);
  const stats = [
    ["Followers", formatCount(creds.followerCount)],
    ["Following", formatCount(creds.followingCount)],
    ["Likes", formatCount(creds.likesCount)],
    ["Subscribers", formatCount(creds.subscriberCount)],
    ["Total views", formatCount(creds.viewCount)],
    ["Videos", formatCount(creds.videoCount)],
  ].filter(([, v]) => v !== null) as [string, string][];

  return (
    <div className="p-8">
      <div className="max-w-2xl mx-auto">
        <button
          className="flex items-center gap-1.5 text-sm text-neutral-400 hover:text-neutral-200 mb-6"
          onClick={() => navigate("/accounts")}
        >
          <ArrowLeft size={16} /> Back to accounts
        </button>

        <div className="flex items-start gap-4 mb-6">
          {creds.avatarUrl ? (
            <img
              src={creds.avatarUrl}
              alt=""
              className="w-20 h-20 rounded-full object-cover border border-neutral-700 shrink-0"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center text-neutral-400 text-2xl shrink-0">
              {account.accountName.slice(0, 1).toUpperCase() || "?"}
            </div>
          )}
          <div className="min-w-0 pt-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold truncate">{account.accountName}</h1>
              {creds.isVerified && (
                <span title="Verified" className="text-blue-400 text-sm">
                  ✓
                </span>
              )}
            </div>
            <span
              className={`inline-block mt-1.5 text-xs px-2 py-0.5 rounded-full ${
                PLATFORM_BADGE_CLASSES[account.platform] ?? "bg-neutral-700"
              }`}
            >
              {PLATFORM_LABELS[account.platform] ?? account.platform}
              {account.platform === "facebook" && creds.accountType
                ? ` · ${creds.accountType === "page" ? creds.category || "Page" : "Personal profile"}`
                : ""}
            </span>
          </div>
        </div>

        {creds.bioDescription && <p className="text-sm text-neutral-400 mb-6">{creds.bioDescription}</p>}

        <h2 className="text-sm font-medium text-neutral-300 mb-2">Statistics</h2>
        {stats.length > 0 ? (
          <div className="grid grid-cols-3 gap-3 mb-6">
            {stats.map(([label, value]) => (
              <div key={label} className="rounded-lg bg-neutral-900 border border-neutral-800 px-4 py-3 text-center">
                <div className="text-lg font-semibold">{value}</div>
                <div className="text-xs text-neutral-500 mt-0.5">{label}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-neutral-500 mb-6">
            No statistics available for this account yet{canRefresh ? " — try Refresh below." : "."}
          </p>
        )}

        <div className="rounded-lg bg-neutral-900 border border-neutral-800 px-4 py-3 text-sm text-neutral-400 space-y-1.5 mb-6">
          <p>Connected {new Date(account.createdAt).toLocaleString()}</p>
          {creds.expiresAt && <p>Login expires {new Date(creds.expiresAt).toLocaleString()}</p>}
          {creds.profileDeepLink && (
            <a
              href={creds.profileDeepLink}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-neutral-400 hover:text-neutral-200 underline"
            >
              View profile ↗
            </a>
          )}
        </div>

        {refreshError && <p className="text-sm text-red-400 mb-3">{refreshError}</p>}

        {canRefresh && (
          <button
            className="px-4 py-2 rounded bg-neutral-800 hover:bg-neutral-700 text-sm disabled:opacity-50"
            disabled={refreshing || !isOnline}
            title={!isOnline ? "No internet connection" : undefined}
            onClick={handleRefresh}
          >
            {refreshing ? "Refreshing…" : "Refresh stats"}
          </button>
        )}
      </div>
    </div>
  );
}
