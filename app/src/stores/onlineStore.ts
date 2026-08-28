import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useQueueStore } from "./queueStore";

// Single source of truth for "is this machine actually connected right now" — every button
// that fires an outbound network call (AI Engine calls, OAuth, YouTube search/download,
// TikTok/Facebook API calls) reads `isOnline` from here to disable itself instead of letting
// the user click it and watch it fail immediately. Queue-related buttons (Add to Queue,
// Queue uploads) are the deliberate exception — queuing is a local DB write, and an upload
// that fails purely because the connection was down gets auto-retried the moment `online`
// fires (see `retry_offline_failures` in commands/queue.rs), so those buttons stay enabled.
interface OnlineStore {
  isOnline: boolean;
  initListeners: () => void;
}

let listenersInitialized = false;

export const useOnlineStore = create<OnlineStore>((set) => ({
  isOnline: typeof navigator === "undefined" || navigator.onLine,

  initListeners: () => {
    if (listenersInitialized) return;
    listenersInitialized = true;

    window.addEventListener("online", () => {
      set({ isOnline: true });
      invoke<number>("retry_offline_failures")
        .then((count) => {
          if (count > 0) useQueueStore.getState().fetchQueue();
        })
        .catch(() => {
          // Best-effort — a manual "Retry" on the Queue page still works if this fails.
        });
    });
    window.addEventListener("offline", () => set({ isOnline: false }));
  },
}));
