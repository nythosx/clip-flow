import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "./projectStore";
import { useQueueStore } from "./queueStore";
import { playVoice, playErrorVoiceDebounced } from "../lib/soundManager";

export interface AutoUploadSettings {
  mode: "clips" | "movie";
  templateId: string;
  accountIds: string[];
}

const SETTING_KEY = "auto_upload_defaults";

interface AutoUploadStore {
  settings: AutoUploadSettings | null;
  fetchSettings: () => Promise<void>;
  saveSettings: (settings: AutoUploadSettings) => Promise<void>;
  running: boolean;
  progressLabel: string;
  runAutoUpload: (projectId: string) => Promise<void>;
}

export const useAutoUploadStore = create<AutoUploadStore>((set, get) => ({
  settings: null,
  running: false,
  progressLabel: "",

  fetchSettings: async () => {
    try {
      const settingsMap = await invoke<Record<string, string>>("get_settings");
      const raw = settingsMap[SETTING_KEY];
      if (raw) set({ settings: JSON.parse(raw) as AutoUploadSettings });
    } catch {

    }
  },

  saveSettings: async (settings) => {
    await invoke("set_setting", { key: SETTING_KEY, value: JSON.stringify(settings) });
    set({ settings });
  },

  runAutoUpload: async (projectId) => {
    const { settings } = get();
    if (!settings || !settings.templateId || settings.accountIds.length === 0) {
      throw new Error("Set up Auto upload defaults first — click Edit.");
    }

    set({ running: true, progressLabel: "Checking project…" });
    try {
      const projectStore = useProjectStore.getState();
      await projectStore.fetchProject(projectId);
      const project = useProjectStore.getState().currentProject;
      if (!project) throw new Error("Project not found");

      const kind: "clip" | "part" = settings.mode === "movie" ? "part" : "clip";
      const alreadySliced = (settings.mode === "movie" ? project.movieStatus : project.clipsStatus) === "ready";

      if (!alreadySliced) {
        set({ progressLabel: settings.mode === "movie" ? "Slicing full video…" : "Slicing clips…" });

        if (settings.mode === "movie") {
          await projectStore.analyzeMovie(projectId);
        } else {
          await projectStore.analyzeClips(projectId);
        }
        const analyzeError = useProjectStore.getState().error;
        if (analyzeError) throw new Error(analyzeError);
      }

      await projectStore.fetchClips(projectId);
      let clips = useProjectStore.getState().clips.filter((c) => c.kind === kind);

      if (clips.some((c) => !c.aiCaption)) {
        set({ progressLabel: "Generating captions…" });
        await invoke("generate_missing_captions", { projectId, kind });
        await projectStore.fetchClips(projectId);
        clips = useProjectStore.getState().clips.filter((c) => c.kind === kind);
      }

      const needsRender = clips.filter((c) => !c.finalOutputPath);
      for (let i = 0; i < needsRender.length; i++) {
        set({ progressLabel: `Rendering ${i + 1}/${needsRender.length}…` });
        await projectStore.renderClipFinal(needsRender[i].id, settings.templateId);
      }

      await projectStore.fetchClips(projectId);
      clips = useProjectStore.getState().clips.filter((c) => c.kind === kind && c.finalOutputPath);

      set({ progressLabel: "Queuing uploads…" });
      const queueStore = useQueueStore.getState();
      await queueStore.fetchQueue();
      for (const clip of clips) {
        const already = new Set(
          useQueueStore.getState().items.filter((q) => q.clipId === clip.id).map((q) => q.accountId)
        );
        const missing = settings.accountIds.filter((id) => !already.has(id));
        if (missing.length > 0) {
          await queueStore.addToQueue(clip.id, missing);
        }
      }
      playVoice("autoUploadComplete");
    } catch (error) {
      playErrorVoiceDebounced();
      throw error;
    } finally {
      set({ running: false, progressLabel: "" });
    }
  },
}));
