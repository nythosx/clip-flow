import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type DownloadStatus =
  | "downloading"
  | "paused"
  | "captions"
  | "creating_project"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadRecord {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  status: DownloadStatus;
  percent: number | null;
  message: string;
  projectId: string | null;
  error: string | null;
}

interface DownloadsStore {
  downloads: DownloadRecord[];
  initListeners: () => void;
  fetchDownloads: () => Promise<void>;
  startDownload: (videoId: string, title: string, thumbnailUrl: string) => Promise<void>;
  pauseDownload: (videoId: string) => Promise<void>;
  resumeDownload: (videoId: string) => Promise<void>;
  cancelDownload: (videoId: string) => Promise<void>;
  removeDownload: (videoId: string) => Promise<void>;
}

let listenersInitialized = false;

export const useDownloadsStore = create<DownloadsStore>((set, get) => ({
  downloads: [],

  initListeners: () => {
    if (listenersInitialized) return;
    listenersInitialized = true;
    listen<DownloadRecord>("youtube_download_progress", (event) => {
      set({
        downloads: (() => {
          const list = get().downloads;
          const idx = list.findIndex((d) => d.videoId === event.payload.videoId);
          if (idx === -1) return [event.payload, ...list];
          const next = [...list];
          next[idx] = event.payload;
          return next;
        })(),
      });
    });
  },

  fetchDownloads: async () => {
    const downloads = await invoke<DownloadRecord[]>("get_youtube_downloads");
    set({ downloads });
  },

  startDownload: async (videoId, title, thumbnailUrl) => {
    await invoke("start_youtube_download", { videoId, title, thumbnailUrl });
    await get().fetchDownloads();
  },

  pauseDownload: async (videoId) => {
    await invoke("pause_youtube_download", { videoId });
  },

  resumeDownload: async (videoId) => {
    await invoke("resume_youtube_download", { videoId });
  },

  cancelDownload: async (videoId) => {
    await invoke("cancel_youtube_download", { videoId });
  },

  removeDownload: async (videoId) => {
    await invoke("remove_youtube_download", { videoId });
    set({ downloads: get().downloads.filter((d) => d.videoId !== videoId) });
  },
}));
