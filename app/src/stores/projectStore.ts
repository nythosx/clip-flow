import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  createdAt: string;
  updatedAt: string;
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
}

interface ProjectStore {
  projects: Project[];
  currentProject: Project | null;
  clips: Clip[];
  isLoading: boolean;
  error: string | null;
  clipsAnalysisProgress: AnalysisProgress | null;
  movieAnalysisProgress: AnalysisProgress | null;
  fetchProjects: () => Promise<void>;
  createProject: (name: string, moviePath: string, transcriptPath: string) => Promise<string>;
  fetchProject: (projectId: string) => Promise<void>;
  fetchClips: (projectId: string) => Promise<void>;
  analyzeClips: (projectId: string) => Promise<void>;
  analyzeMovie: (projectId: string) => Promise<void>;
  cancelAnalysis: (projectId: string, mode: "clips" | "movie") => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  updateProjectName: (projectId: string, name: string) => Promise<void>;
  renderClipPreview: (clipId: string) => Promise<void>;
  renderClipFinal: (clipId: string, templateId: string) => Promise<void>;
  // A Set, not a single id — rendering is now queued/serialized entirely on the backend
  // (render_manager.rs's semaphore), so requesting a render for clip B while clip A is
  // still rendering is expected and safe; both need their own "rendering" UI state instead
  // of one clobbering the other.
  renderingClipIds: Set<string>;
  // Bumped on every successful render — the rendered file path is stable
  // (`{clipId}_{templateId}.mp4` / `{clipId}.mp4`), so a re-render doesn't change the src
  // string a <video> element uses. Without a cache-buster, the player keeps showing
  // whatever it already decoded from that URL instead of the freshly rendered bytes,
  // which made fixes like the caption-alignment render bug look like they hadn't applied.
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

// Shared by analyzeClips/analyzeMovie — both listen on the same event, filtered by mode,
// and drive one of the two independent progress trackers.
async function runAnalysis(
  projectId: string,
  mode: "clips" | "movie",
  command: string,
  progressKey: "clipsAnalysisProgress" | "movieAnalysisProgress",
  set: (partial: Partial<ProjectStore>) => void,
  get: () => ProjectStore
) {
  set({ error: null, [progressKey]: { projectId, mode, stage: "starting", progress: 0 } } as Partial<ProjectStore>);

  const existingUnlisten = mode === "clips" ? clipsProgressUnlisten : movieProgressUnlisten;
  if (existingUnlisten) existingUnlisten();
  const unlisten = await listen<AnalysisProgress>("project_analysis_progress", (event) => {
    if (event.payload.projectId === projectId && event.payload.mode === mode) {
      set({ [progressKey]: event.payload } as Partial<ProjectStore>);
    }
  });
  if (mode === "clips") clipsProgressUnlisten = unlisten;
  else movieProgressUnlisten = unlisten;

  try {
    await invoke(command, { id: projectId });
    await get().fetchProject(projectId);
    await get().fetchClips(projectId);
  } catch (error) {
    set({ error: String(error) });
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

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  currentProject: null,
  clips: [],
  isLoading: false,
  error: null,
  clipsAnalysisProgress: null,
  movieAnalysisProgress: null,
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
    } catch (error) {
      set({ error: String(error) });
    }
  },

  analyzeClips: (projectId) => runAnalysis(projectId, "clips", "analyze_clips", "clipsAnalysisProgress", set, get),
  analyzeMovie: (projectId) => runAnalysis(projectId, "movie", "analyze_movie", "movieAnalysisProgress", set, get),

  // Interrupts the in-flight AI call; the still-pending analyzeClips/analyzeMovie promise
  // above rejects shortly after (the Rust command's own error path), so its existing
  // catch/finally clears progress state and status — nothing more to do here.
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

  renderVersion: {},

  renderClipPreview: async (clipId) => {
    set({ error: null, renderingClipIds: new Set(get().renderingClipIds).add(clipId) });
    try {
      // This invoke can sit queued behind another clip's render (backend semaphore in
      // render_manager.rs) before it even starts — that's the point, not a bug: it lets
      // several renders be requested back to back and just processes them one at a time
      // instead of racing multiple ffmpeg encodes, while every other action in the app
      // (including starting yet another render) keeps working immediately.
      const outputPath = await invoke<string>("render_clip_preview", { clipId });
      set({
        clips: get().clips.map((c) =>
          c.id === clipId ? { ...c, outputPath, status: "ready" } : c
        ),
        renderVersion: { ...get().renderVersion, [clipId]: (get().renderVersion[clipId] ?? 0) + 1 },
      });
    } catch (error) {
      set({ error: String(error) });
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
    } catch (error) {
      set({ error: String(error) });
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

  // Kept fully separate from updateClipCaption/aiCaption — this is the user's own writing,
  // never overwritten by Generate with AI.
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

  // Backend already serializes every caption request per project (one shared AI Engine tab
  // — see CaptionLocks in commands/project.rs), so this is safe to fire even if a per-clip
  // generate is somehow also in flight; it'll just queue behind it.
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

  // Batch review pass: sends every already-generated caption in the project to a dedicated
  // review chat tab (with the transcript for context) and asks it to rewrite whichever ones
  // aren't chaotic/TikTok-slang enough, are too long/formal, aren't algorithm-optimized, or
  // repeat another clip's caption — see `refine_captions` in commands/project.rs.
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

  // Asks the AI Engine for hashtags actually trending right now (excluding evergreen ones
  // like #fyp) and saves them on the project — every clip queued afterward picks them up
  // automatically in its TikTok title (see build_tiktok_title in queue_manager.rs).
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
