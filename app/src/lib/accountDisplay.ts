import { Account } from "../stores/accountStore";

export const PLATFORM_LABELS: Record<string, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
  facebook: "Facebook",
};

export const PLATFORM_BADGE_CLASSES: Record<string, string> = {
  tiktok: "bg-black text-white border border-neutral-600",
  youtube: "bg-red-600/90 text-white",
  facebook: "bg-blue-700/90 text-white",
};

const PLATFORM_FALLBACK_URL: Record<string, string> = {
  tiktok: "https://www.tiktok.com/",
  youtube: "https://studio.youtube.com/",
  facebook: "https://www.facebook.com/",
};

export function launchUrlFor(account: Account, creds: AccountCredentials): string {
  return creds.profileDeepLink || PLATFORM_FALLBACK_URL[account.platform] || "https://www.google.com/";
}

export interface AccountCredentials {
  avatarUrl?: string;
  bioDescription?: string;
  profileDeepLink?: string;
  isVerified?: boolean;
  followerCount?: number;
  followingCount?: number;
  likesCount?: number;
  videoCount?: number;
  subscriberCount?: number;
  viewCount?: number;
  expiresAt?: string;
  accountType?: "user" | "page"; // Facebook only — personal profile vs. a managed Page
  category?: string; // Facebook Page only
}

export function parseCredentials(a: Account): AccountCredentials {
  try {
    return JSON.parse(a.credentialsJson) as AccountCredentials;
  } catch {
    return {};
  }
}

export function formatCount(n?: number): string | null {
  if (n === undefined || n === null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

// TikTok's granted scope (user.info.basic) can't re-fetch stats without the full OAuth
// browser round-trip, so it has no lightweight refresh — only Reconnect, from the list page.
export function statsRefreshablePlatform(platform: string): boolean {
  return platform === "facebook" || platform === "youtube";
}
