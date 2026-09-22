import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type AccountPlatform = "tiktok" | "youtube" | "facebook";

export interface Account {
  id: string;
  platform: string;
  accountName: string;
  credentialsJson: string;
  isActive: boolean;
  createdAt: string;
}

interface AccountStore {
  accounts: Account[];
  isLoading: boolean;
  error: string | null;
  fetchAccounts: () => Promise<void>;
  createAccount: (platform: AccountPlatform, accountName: string, credentials: Record<string, string | undefined>) => Promise<void>;
  connectTikTok: () => Promise<void>;
  connectYouTube: () => Promise<void>;
  connectFacebook: () => Promise<void>;
  refreshFacebookAccount: (id: string) => Promise<void>;
  refreshYouTubeAccount: (id: string) => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
}

export const useAccountStore = create<AccountStore>((set, get) => ({
  accounts: [],
  isLoading: false,
  error: null,

  fetchAccounts: async () => {
    set({ isLoading: true, error: null });
    try {
      const accounts = await invoke<Account[]>("get_accounts");
      set({ accounts, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  createAccount: async (platform, accountName, credentials) => {
    const account = await invoke<Account>("create_account", {
      platform,
      accountName,
      credentialsJson: JSON.stringify(credentials),
    });
    set({ accounts: [account, ...get().accounts] });
  },

  connectTikTok: async () => {

    const account = await invoke<Account>("connect_tiktok_account");
    set({ accounts: [account, ...get().accounts.filter((a) => a.id !== account.id)] });
  },

  connectYouTube: async () => {

    const account = await invoke<Account>("connect_youtube_account");
    set({ accounts: [account, ...get().accounts.filter((a) => a.id !== account.id)] });
  },

  connectFacebook: async () => {

    const newAccounts = await invoke<Account[]>("connect_facebook_account");
    const newIds = new Set(newAccounts.map((a) => a.id));
    set({ accounts: [...newAccounts, ...get().accounts.filter((a) => !newIds.has(a.id))] });
  },

  refreshFacebookAccount: async (id) => {
    const account = await invoke<Account>("refresh_facebook_account", { accountId: id });
    set({ accounts: get().accounts.map((a) => (a.id === account.id ? account : a)) });
  },

  refreshYouTubeAccount: async (id) => {
    const account = await invoke<Account>("refresh_youtube_account", { accountId: id });
    set({ accounts: get().accounts.map((a) => (a.id === account.id ? account : a)) });
  },

  deleteAccount: async (id) => {
    await invoke("delete_account", { id });
    set({ accounts: get().accounts.filter((a) => a.id !== id) });
  },
}));
