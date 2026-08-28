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

// Read-only mirror of the backend's `render_queue` table (see render_manager.rs) — every
// render request across every project shares one ffmpeg-serializing semaphore there, so this
// is what lets the UI show "N renders pending in the background" instead of the user having
// to guess whether a render they kicked off from a project they've since left is still going.
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
      // Best-effort background indicator — a failed poll just leaves the last known state.
    }
  },
}));
