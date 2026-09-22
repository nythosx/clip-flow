import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type Platform = "tiktok" | "youtube_shorts" | "youtube_video";
export type Scaling = "fit" | "fill" | "stretch" | "zoom";
export type Alignment = "left" | "center" | "right";

export interface CaptionOverlayConfig {
  enabled: boolean;
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: "normal" | "bold";
  fontColor: string;
  backgroundColor: string;
  backgroundOpacity: number;
  padding: number;
  position: { x: number; y: number };
  anchor: string;
  maxWidth: number;
  alignment: Alignment;
}

export interface SubtitleOverlayConfig {
  enabled: boolean;
  fontFamily: string;
  fontSize: number;
  fontWeight: "normal" | "bold";
  fontColor: string;
  backgroundColor: string;
  backgroundOpacity: number;
  padding: number;
  position: { x: number; y: number };
  maxWidth: number;
  alignment: Alignment;
}

export interface TemplateConfig {
  version: 2;
  platform: Platform;
  output: { width: number; height: number };
  transform: {
    mirror: boolean;
    revert: boolean;
    rotation: 0 | 90 | 180 | 270;
    scaling: Scaling;
    crop: { x: number; y: number };

    zoom: number;
  };
  watermark: {
    enabled: boolean;
    imagePath: string;
    position: { x: number; y: number };
    anchor: string;
    scale: number;
    opacity: number;
  };
  caption: CaptionOverlayConfig;

  caption2: CaptionOverlayConfig;

  subtitle: SubtitleOverlayConfig;
  encoding: {
    codec: "h264" | "h265";
    crf: number;
    preset: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium";
    maxResolution: 480 | 720 | 1080;
    audioBitrate: "128k" | "192k" | "256k";
  };
}

export function defaultTemplateConfig(platform: Platform = "tiktok"): TemplateConfig {
  return {
    version: 2,
    platform,
    output: { width: 1080, height: 1920 },
    transform: { mirror: false, revert: false, rotation: 0, scaling: "fill", crop: { x: 0.5, y: 0.5 }, zoom: 0.5 },
    watermark: {
      enabled: false,
      imagePath: "",
      position: { x: 0.85, y: 0.05 },
      anchor: "top-right",
      scale: 0.2,
      opacity: 0.8,
    },
    caption: {
      enabled: false,
      text: "{ai_caption}",
      fontFamily: "Arial",
      fontSize: 64,
      fontWeight: "normal",
      fontColor: "#ffffff",
      backgroundColor: "#000000",
      backgroundOpacity: 0.5,
      padding: 16,
      position: { x: 0.1, y: 0.8 },
      anchor: "bottom-left",
      maxWidth: 880,
      alignment: "left",
    },
    caption2: {
      enabled: false,
      text: "Part {part_number}",
      fontFamily: "Arial",
      fontSize: 64,
      fontWeight: "normal",
      fontColor: "#ffffff",
      backgroundColor: "#000000",
      backgroundOpacity: 0.5,
      padding: 16,
      position: { x: 0.1, y: 0.08 },
      anchor: "top-left",
      maxWidth: 880,
      alignment: "left",
    },
    subtitle: {
      enabled: false,
      fontFamily: "Arial",
      fontSize: 56,
      fontWeight: "bold",
      fontColor: "#ffffff",
      backgroundColor: "#000000",
      backgroundOpacity: 0.45,
      padding: 12,
      position: { x: 0.1, y: 0.5 },
      maxWidth: 880,
      alignment: "center",
    },
    encoding: {
      codec: "h264",
      crf: 23,
      preset: "veryfast",
      maxResolution: 1080,
      audioBitrate: "192k",
    },
  };
}

export interface Template {
  id: string;
  name: string;
  platform: string;
  configJson: string;
  isDefault: boolean;
  createdAt: string;
}

interface TemplateStore {
  templates: Template[];
  currentTemplate: Template | null;
  canvasState: TemplateConfig;
  isLoading: boolean;
  error: string | null;
  fetchTemplates: () => Promise<void>;
  loadTemplate: (id: string) => Promise<void>;
  createNew: (platform: Platform) => void;
  updateCanvasState: (partial: Partial<TemplateConfig>) => void;
  saveTemplate: (name: string) => Promise<string>;
  deleteTemplate: (id: string) => Promise<void>;
}

export const useTemplateStore = create<TemplateStore>((set, get) => ({
  templates: [],
  currentTemplate: null,
  canvasState: defaultTemplateConfig(),
  isLoading: false,
  error: null,

  fetchTemplates: async () => {
    set({ isLoading: true, error: null });
    try {
      const templates = await invoke<Template[]>("get_templates");
      set({ templates, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  loadTemplate: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const template = await invoke<Template>("get_template", { id });
      const parsed = JSON.parse(template.configJson) as Partial<TemplateConfig>;

      const defaults = defaultTemplateConfig(parsed.platform ?? "tiktok");
      const canvasState: TemplateConfig = {
        ...defaults,
        ...parsed,
        caption: { ...defaults.caption, ...parsed.caption },
        caption2: { ...defaults.caption2, ...parsed.caption2 },
        subtitle: { ...defaults.subtitle, ...parsed.subtitle },
      };
      set({ currentTemplate: template, canvasState, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  createNew: (platform) => {
    set({ currentTemplate: null, canvasState: defaultTemplateConfig(platform) });
  },

  updateCanvasState: (partial) => {
    set({ canvasState: { ...get().canvasState, ...partial } });
  },

  saveTemplate: async (name) => {
    const { currentTemplate, canvasState } = get();
    const configJson = JSON.stringify(canvasState);
    if (currentTemplate) {
      const updated = await invoke<Template>("update_template", {
        id: currentTemplate.id,
        name,
        configJson,
      });
      set({ currentTemplate: updated });
      await get().fetchTemplates();
      return updated.id;
    }
    const created = await invoke<Template>("create_template", {
      name,
      platform: canvasState.platform,
      configJson,
    });
    set({ currentTemplate: created });
    await get().fetchTemplates();
    return created.id;
  },

  deleteTemplate: async (id) => {
    await invoke("delete_template", { id });
    set({ templates: get().templates.filter((t) => t.id !== id) });
  },
}));
