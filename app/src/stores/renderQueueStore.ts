import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface RenderQueueItem {
  id: string;
  clipId: string;
  kind: "preview" | "final";
  templateId: string | null;
  status: "queued" | "rendering" | "completed" | "failed";
  errorMessage: string | null;
  createdAt: string;
}

interface RenderQueueStore {
  items: RenderQueueItem[];
  initListeners: () => void;
  fetchQueue: () => Promise<void>;
}

let listenersInitialized = false;

export const useRenderQueueStore = create<RenderQueueStore>((set, get) => ({
  items: [],

  initListeners: () => {
    if (listenersInitialized) return;
    listenersInitialized = true;
    listen("render_queue_update", () => {
      get().fetchQueue();
    });
  },

  fetchQueue: async () => {
    try {
      const items = await invoke<RenderQueueItem[]>("get_render_queue");
      set({ items });
    } catch {

    }
  },
}));
