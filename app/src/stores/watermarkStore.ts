import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface Watermark {
  id: string;
  name: string;
  filePath: string;
  createdAt: string;
}

interface WatermarkStore {
  watermarks: Watermark[];
  isLoading: boolean;
  error: string | null;
  fetchWatermarks: () => Promise<void>;
  uploadWatermark: (name: string, sourcePath: string) => Promise<Watermark>;
  deleteWatermark: (id: string) => Promise<void>;
}

export const useWatermarkStore = create<WatermarkStore>((set, get) => ({
  watermarks: [],
  isLoading: false,
  error: null,

  fetchWatermarks: async () => {
    set({ isLoading: true, error: null });
    try {
      const watermarks = await invoke<Watermark[]>("get_watermarks");
      set({ watermarks, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  uploadWatermark: async (name, sourcePath) => {
    const watermark = await invoke<Watermark>("upload_watermark", { name, sourcePath });
    set({ watermarks: [watermark, ...get().watermarks] });
    return watermark;
  },

  deleteWatermark: async (id) => {
    await invoke("delete_watermark", { id });
    set({ watermarks: get().watermarks.filter((w) => w.id !== id) });
  },
}));
