import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useQueueStore } from "./queueStore";

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

        });
    });
    window.addEventListener("offline", () => set({ isOnline: false }));
  },
}));
