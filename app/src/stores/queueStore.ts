import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { playSfx, playVoice } from "../lib/soundManager";

export interface QueueItem {
  id: string;
  clipId: string;
  accountId: string;
  accountName: string;
  platform: string;
  status: string;
  progress: number;
  retryCount: number;
  errorMessage: string | null;
  platformPostId: string | null;
  clipOutputPath: string | null;
  clipFinalOutputPath: string | null;
  scheduledAt: string | null;
  completedAt: string | null;
  createdAt: string;
  title: string;
  hashtags: string[];
}

interface UploadProgressEvent {
  id: string;
  accountId: string;
  progress: number;
  status: string;
}

interface QueueStore {
  items: QueueItem[];
  isPaused: boolean;
  isLoading: boolean;
  error: string | null;
  initListeners: () => void;
  fetchQueue: () => Promise<void>;
  addToQueue: (clipId: string, accountIds: string[]) => Promise<void>;
  pauseAll: () => Promise<void>;
  resumeAll: () => Promise<void>;
  retryItem: (id: string) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  clearCompleted: () => Promise<void>;
}

let listenersInitialized = false;
// Tracks whether a batch of uploads is actually "in flight" so the uploadsDone voice line
// fires once when the queue drains, not on every individual item (that's what the per-item
// success/error SFX below is for) and not on app startup when the queue simply starts empty.
let hadActiveUploads = false;

export const useQueueStore = create<QueueStore>((set, get) => ({
  items: [],
  isPaused: false,
  isLoading: false,
  error: null,

  initListeners: () => {
    if (listenersInitialized) return;
    listenersInitialized = true;

    listen<UploadProgressEvent>("upload_progress", (event) => {
      const { id, progress, status } = event.payload;
      const previousStatus = get().items.find((item) => item.id === id)?.status;
      const nextItems = get().items.map((item) => (item.id === id ? { ...item, progress, status } : item));
      set({ items: nextItems });

      // Per-item SFX — only on the transition into a terminal state, not on every progress
      // tick (progress updates keep the same "uploading" status) and not on a rate-limit
      // reschedule (that sets status back to "queued", not "failed").
      if (status === "completed" && previousStatus !== "completed") playSfx("success");
      if (status === "failed" && previousStatus !== "failed") playSfx("error");

      if (status === "uploading") hadActiveUploads = true;
      const stillActive = nextItems.some((item) => item.status === "queued" || item.status === "uploading");
      if (hadActiveUploads && !stillActive && nextItems.some((item) => item.status === "completed")) {
        hadActiveUploads = false;
        playVoice("uploadsDone");
      }
    });
    listen("queue_paused", () => set({ isPaused: true }));
    listen("queue_resumed", () => set({ isPaused: false }));
  },

  fetchQueue: async () => {
    set({ isLoading: true, error: null });
    try {
      const items = await invoke<QueueItem[]>("get_queue");
      set({ items, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  addToQueue: async (clipId, accountIds) => {
    await invoke("add_to_queue", { clipId, accountIds });
    await get().fetchQueue();
  },

  pauseAll: async () => {
    await invoke("pause_queue");
    set({ isPaused: true });
  },

  resumeAll: async () => {
    await invoke("resume_queue");
    set({ isPaused: false });
  },

  retryItem: async (id) => {
    await invoke("retry_queue_item", { itemId: id });
    await get().fetchQueue();
  },

  removeItem: async (id) => {
    await invoke("remove_queue_item", { itemId: id });
    set({ items: get().items.filter((item) => item.id !== id) });
  },

  clearCompleted: async () => {
    await invoke("clear_completed_queue");
    set({ items: get().items.filter((item) => item.status !== "completed") });
  },
}));
