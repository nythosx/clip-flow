import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { playVoice, playSfx, playErrorVoiceDebounced } from "../lib/soundManager";

export interface Project {
  id: string;
  name: string;
  moviePath: string;
  transcriptPath: string | null;
  transcriptFormat: string | null;
  sourceResolutionWidth: number | null;
  sourceResolutionHeight: number | null;
  sourceDurationSeconds: number | null;
  trimmedStartSeconds: number | null;
  trimmedEndSeconds: number | null;
  sourceThumbnailUrl: string | null;
  status: string;
  clipsStatus: string;
  movieStatus: string;
  clipsCount: number;
  partsCount: number;
  trendingHashtags: string[];
  transcriptOffsetSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptSyncStatus {
  movieDurationSeconds: number;
  transcriptStartSeconds: number;
  transcriptEndSeconds: number;
  offsetSeconds: number;
  mismatch: boolean;
}

export interface Clip {
  id: string;
  projectId: string;
  startSeconds: number;
  endSeconds: number;
  hookReason: string | null;
  transcriptExcerpt: string | null;
  aiCaption: string | null;
  customCaption: string | null;
  outputPath: string | null;
  finalOutputPath: string | null;
  status: string;
  kind: "clip" | "part";
  hashtags: string[];
  createdAt: string;
}

export interface AnalysisProgress {
  projectId: string;
  mode: "clips" | "movie";
  stage: string;
  progress: number;
  detail: string | null;
}

export interface ActivityLogEntry {
  id: string;
  projectId: string;
  mode: string;
  stage: string;
  progress: number;
  detail: string | null;
  timestamp: number;
}

const MAX_ACTIVITY_LOG_ENTRIES = 500;

interface ProjectStore {
  projects: Project[];
  currentProject: Project | null;
  clips: Clip[];
  isLoading: boolean;
  error: string | null;
  clipsAnalysisProgress: AnalysisProgress | null;
  movieAnalysisProgress: AnalysisProgress | null;
  activityLog: ActivityLogEntry[];
  initActivityLogListener: () => void;
  fetchProjects: () => Promise<void>;
  createProject: (name: string, moviePath: string, transcriptPath: string) => Promise<string>;
  fetchProject: (projectId: string) => Promise<void>;
  fetchClips: (projectId: string) => Promise<void>;

  renderAllMissingPreviews: (projectId: string) => void;
  analyzeClips: (projectId: string) => Promise<void>;
  analyzeMovie: (projectId: string) => Promise<void>;
  cancelAnalysis: (projectId: string, mode: "clips" | "movie") => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  updateProjectName: (projectId: string, name: string) => Promise<void>;
  getTranscriptSyncStatus: (projectId: string) => Promise<TranscriptSyncStatus>;
  setTranscriptOffset: (projectId: string, offsetSeconds: number) => Promise<void>;
  renderClipPreview: (clipId: string) => Promise<void>;
  renderClipFinal: (clipId: string, templateId: string) => Promise<void>;

  renderingClipIds: Set<string>;

  renderVersion: Record<string, number>;
  updateClipCaption: (clipId: string, caption: string) => Promise<void>;
  updateClipCustomCaption: (clipId: string, caption: string) => Promise<void>;
  generatingCaptionClipId: string | null;
  generateClipCaption: (clipId: string) => Promise<void>;
  generatingCaptionsForProject: string | null;
  generateMissingCaptions: (projectId: string, kind: "clip" | "part") => Promise<void>;
  refiningCaptionsForProject: string | null;
  refineCaptions: (projectId: string, kind: "clip" | "part") => Promise<void>;
  trendingHashtags: string[];
  fetchingTrendingHashtags: boolean;
  fetchTrendingHashtags: (projectId: string) => Promise<void>;
}

let clipsProgressUnlisten: (() => void) | null = null;
let movieProgressUnlisten: (() => void) | null = null;

const backgroundPreviewAttempted = new Set<string>();

async function runAnalysis(
  projectId: string,
  mode: "clips" | "movie",
  command: string,
  progressKey: "clipsAnalysisProgress" | "movieAnalysisProgress",
  set: (partial: Partial<ProjectStore>) => void,
  get: () => ProjectStore
) {
  set({
    error: null,
    [progressKey]: { projectId, mode, stage: "starting", progress: 0, detail: null },
  } as Partial<ProjectStore>);

  const existingUnlisten = mode === "clips" ? clipsProgressUnlisten : movieProgressUnlisten;
  if (existingUnlisten) existingUnlisten();
  const unlisten = await listen<AnalysisProgress>("project_analysis_progress", (event) => {
    if (event.payload.projectId === projectId && event.payload.mode === mode && event.payload.stage !== "ai_status") {
      set({ [progressKey]: event.payload } as Partial<ProjectStore>);
    }
  });
  if (mode === "clips") clipsProgressUnlisten = unlisten;
  else movieProgressUnlisten = unlisten;

  try {
    await invoke(command, { id: projectId });
    await get().fetchProject(projectId);
    await get().fetchClips(projectId);
    playVoice("analysisComplete");
  } catch (error) {
    set({ error: String(error) });
    playErrorVoiceDebounced();
  } finally {
    set({ [progressKey]: null } as Partial<ProjectStore>);
    const unlistenNow = mode === "clips" ? clipsProgressUnlisten : movieProgressUnlisten;
    if (unlistenNow) {
      unlistenNow();
      if (mode === "clips") clipsProgressUnlisten = null;
      else movieProgressUnlisten = null;
    }
  }
}

let activityLogListenerInitialized = false;

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  currentProject: null,
  clips: [],
  isLoading: false,
  error: null,
  clipsAnalysisProgress: null,
  movieAnalysisProgress: null,
  activityLog: [],

  initActivityLogListener: () => {
    if (activityLogListenerInitialized) return;
    activityLogListenerInitialized = true;
    listen<AnalysisProgress>("project_analysis_progress", (event) => {
      const p = event.payload;
      const entry: ActivityLogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        projectId: p.projectId,
        mode: p.mode,
        stage: p.stage,
        progress: p.progress,
        detail: p.detail ?? null,
        timestamp: Date.now(),
      };
      set({ activityLog: [...get().activityLog, entry].slice(-MAX_ACTIVITY_LOG_ENTRIES) });
    });
  },

  renderingClipIds: new Set(),
  generatingCaptionClipId: null,
  generatingCaptionsForProject: null,
  refiningCaptionsForProject: null,
  trendingHashtags: [],
  fetchingTrendingHashtags: false,

  fetchProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const projects = await invoke<Project[]>("get_projects");
      set({ projects, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  createProject: async (name, moviePath, transcriptPath) => {
    const project = await invoke<Project>("create_project", {
      name,
      moviePath,
      transcriptPath,
    });
    set({ projects: [project, ...get().projects] });
    return project.id;
  },

  fetchProject: async (projectId) => {
    set({ isLoading: true, error: null });
    try {
      const project = await invoke<Project>("get_project", { id: projectId });
      set({ currentProject: project, trendingHashtags: project.trendingHashtags, isLoading: false });
    } catch (error) {
      set({ error: String(error), isLoading: false });
    }
  },

  fetchClips: async (projectId) => {
    try {
      const clips = await invoke<Clip[]>("get_clips", { projectId });
      set({ clips });
      get().renderAllMissingPreviews(projectId);
    } catch (error) {
      set({ error: String(error) });
    }
  },

  renderAllMissingPreviews: (projectId) => {
    const targets = get().clips.filter(
      (c) =>
        c.projectId === projectId &&
        !c.outputPath &&
        !c.finalOutputPath &&
        !backgroundPreviewAttempted.has(c.id)
    );
    if (targets.length === 0) return;
    for (const clip of targets) {
      backgroundPreviewAttempted.add(clip.id);
      set({ renderingClipIds: new Set(get().renderingClipIds).add(clip.id) });
      invoke<string>("render_clip_preview", { clipId: clip.id })
        .then((outputPath) => {
          set({
            clips: get().clips.map((c) => (c.id === clip.id ? { ...c, outputPath, status: "ready" } : c)),
            renderVersion: { ...get().renderVersion, [clip.id]: (get().renderVersion[clip.id] ?? 0) + 1 },
          });
        })
        .catch(() => {

        })
        .finally(() => {
          const next = new Set(get().renderingClipIds);
          next.delete(clip.id);
          set({ renderingClipIds: next });
        });
    }
  },

  analyzeClips: (projectId) => runAnalysis(projectId, "clips", "analyze_clips", "clipsAnalysisProgress", set, get),
  analyzeMovie: (projectId) => runAnalysis(projectId, "movie", "analyze_movie", "movieAnalysisProgress", set, get),

  cancelAnalysis: async (projectId, mode) => {
    try {
      await invoke("cancel_analysis", { projectId, mode });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  deleteProject: async (projectId) => {
    set({ error: null });
    try {
      await invoke("delete_project", { id: projectId });
      set({ projects: get().projects.filter((p) => p.id !== projectId) });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateProjectName: async (projectId, name) => {
    set({ error: null });
    try {
      const project = await invoke<Project>("update_project_name", { id: projectId, name });
      set({
        projects: get().projects.map((p) => (p.id === projectId ? project : p)),
        currentProject: get().currentProject?.id === projectId ? project : get().currentProject,
      });
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  getTranscriptSyncStatus: (projectId) => invoke<TranscriptSyncStatus>("get_transcript_sync_status", { projectId }),

  setTranscriptOffset: async (projectId, offsetSeconds) => {
    await invoke("set_transcript_offset", { projectId, offsetSeconds });
    const project = await invoke<Project>("get_project", { id: projectId });
    set({
      projects: get().projects.map((p) => (p.id === projectId ? project : p)),
      currentProject: get().currentProject?.id === projectId ? project : get().currentProject,
    });
  },

  renderVersion: {},

  renderClipPreview: async (clipId) => {
    set({ error: null, renderingClipIds: new Set(get().renderingClipIds).add(clipId) });
    try {

      const outputPath = await invoke<string>("render_clip_preview", { clipId });
      set({
        clips: get().clips.map((c) =>
          c.id === clipId ? { ...c, outputPath, status: "ready" } : c
        ),
        renderVersion: { ...get().renderVersion, [clipId]: (get().renderVersion[clipId] ?? 0) + 1 },
      });
      playSfx("success");
    } catch (error) {
      set({ error: String(error) });
      playSfx("error");
    } finally {
      const next = new Set(get().renderingClipIds);
      next.delete(clipId);
      set({ renderingClipIds: next });
    }
  },

  renderClipFinal: async (clipId, templateId) => {
    set({ error: null, renderingClipIds: new Set(get().renderingClipIds).add(clipId) });
    try {
      const finalOutputPath = await invoke<string>("render_clip_final", { clipId, templateId });
      set({
        clips: get().clips.map((c) => (c.id === clipId ? { ...c, finalOutputPath } : c)),
        renderVersion: { ...get().renderVersion, [clipId]: (get().renderVersion[clipId] ?? 0) + 1 },
      });
      playSfx("success");
    } catch (error) {
      set({ error: String(error) });
      playSfx("error");
    } finally {
      const next = new Set(get().renderingClipIds);
      next.delete(clipId);
      set({ renderingClipIds: next });
    }
  },

  updateClipCaption: async (clipId, caption) => {
    await invoke("update_clip_caption", { clipId, caption });
    set({
      clips: get().clips.map((c) => (c.id === clipId ? { ...c, aiCaption: caption } : c)),
    });
  },

  updateClipCustomCaption: async (clipId, caption) => {
    await invoke("update_clip_custom_caption", { clipId, caption });
    set({
      clips: get().clips.map((c) => (c.id === clipId ? { ...c, customCaption: caption } : c)),
    });
  },

  generateClipCaption: async (clipId) => {
    set({ error: null, generatingCaptionClipId: clipId });
    try {
      const { caption, hashtags } = await invoke<{ caption: string; hashtags: string[] }>(
        "generate_clip_caption",
        { clipId }
      );
      set({
        clips: get().clips.map((c) => (c.id === clipId ? { ...c, aiCaption: caption, hashtags } : c)),
      });
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ generatingCaptionClipId: null });
    }
  },

  generateMissingCaptions: async (projectId, kind) => {
    set({ error: null, generatingCaptionsForProject: projectId });
    try {
      await invoke("generate_missing_captions", { projectId, kind });
      await get().fetchClips(projectId);
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ generatingCaptionsForProject: null });
    }
  },

  refineCaptions: async (projectId, kind) => {
    set({ error: null, refiningCaptionsForProject: projectId });
    try {
      await invoke("refine_captions", { projectId, kind });
      await get().fetchClips(projectId);
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ refiningCaptionsForProject: null });
    }
  },

  fetchTrendingHashtags: async (projectId) => {
    set({ error: null, fetchingTrendingHashtags: true });
    try {
      const hashtags = await invoke<string[]>("fetch_trending_hashtags", { projectId });
      set({ trendingHashtags: hashtags });
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ fetchingTrendingHashtags: false });
    }
  },
}));
