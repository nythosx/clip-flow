import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ListPlus, Film, Plus, UploadCloud, Zap, Pencil, RefreshCw, Eye, Trash2, X, Loader2, AlertTriangle, Clock } from "lucide-react";
import { useProjectStore, Clip, Project, TranscriptSyncStatus } from "../stores/projectStore";
import { useTemplateStore, TemplateConfig, CaptionOverlayConfig, defaultTemplateConfig } from "../stores/templateStore";
import { useSettingsStore, SETTING_DEFAULT_TEMPLATE_ID } from "../stores/settingsStore";
import { useAccountStore, Account } from "../stores/accountStore";
import { useQueueStore, QueueItem } from "../stores/queueStore";
import { useAutoUploadStore } from "../stores/autoUploadStore";
import { useOnlineStore } from "../stores/onlineStore";
import { videoPreviewStyle, hexToRgba, resolveCaptionText } from "../lib/templatePreview";
import NewProjectDialog from "../components/NewProjectDialog";
import AutoUploadSettingsDialog from "../components/AutoUploadSettingsDialog";

const PLATFORM_LABELS: Record<string, string> = { tiktok: "TikTok", youtube: "YouTube" };

const STAGE_LABELS: Record<string, string> = {
  starting: "Starting",
  parsing_transcript: "Parsing transcript",
  smart_trimmer: "Smart Trimmer (removing intro/credits)",
  clip_finder: "Clip Finder (picking best moments)",
  movie_segmenter: "Movie Segmenter (splitting into parts)",
  saving: "Saving",
  captions: "Generating captions",
  done: "Done",
  ai_status: "AI Engine",
};

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function useThumbnailSrc(moviePath: string | undefined, seekSeconds: number, cacheKey: string | undefined) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!moviePath || !cacheKey) return;
    let cancelled = false;
    setSrc(null);
    invoke<string>("get_thumbnail", { moviePath, seekSeconds, cacheKey })
      .then((path) => {
        if (!cancelled) setSrc(convertFileSrc(path));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [moviePath, seekSeconds, cacheKey]);
  return src;
}

// CapCut-style live preview: approximates the FFmpeg filter graph in ffmpeg.rs's
// render_final() with CSS so a template's effect is visible before a real render is
// kicked off. Position math mirrors ffmpeg's `(main_w-overlay_w)*x` overlay placement via
// an anchor-point transform, and font sizing uses container-query units (`cqw`) to scale
// with the actual rendered preview box instead of the template's authored 1080px width.
function CaptionOverlayBlock({
  caption,
  outputWidth,
  aiCaption,
  partNumber,
}: {
  caption: CaptionOverlayConfig;
  outputWidth: number;
  aiCaption: string | null;
  partNumber?: number;
}) {
  const text = resolveCaptionText(caption.text, aiCaption, partNumber);
  if (!caption.enabled || !text) return null;
  const bg = hexToRgba(caption.backgroundColor, caption.backgroundOpacity);

  return (
    <div
      className="absolute pointer-events-none whitespace-pre-wrap"
      style={{
        left: `${caption.position.x * 100}%`,
        top: `${caption.position.y * 100}%`,
        transform: `translate(-${caption.position.x * 100}%, -${caption.position.y * 100}%)`,
        fontFamily: caption.fontFamily,
        fontSize: `${(caption.fontSize / outputWidth) * 100}cqw`,
        color: caption.fontColor,
        background: bg,
        padding: `${(caption.padding / outputWidth) * 100}cqw`,
        textAlign: caption.alignment,
        maxWidth: `${(caption.maxWidth / outputWidth) * 100}%`,
      }}
    >
      {text}
    </div>
  );
}

// Subtitle has the same box/position/style fields as a caption but no fixed `text` — the
// line currently on screen is passed in from the parent's video-time-driven cue lookup.
function SubtitleOverlayBlock({
  subtitle,
  outputWidth,
  text,
}: {
  subtitle: TemplateConfig["subtitle"];
  outputWidth: number;
  text: string;
}) {
  if (!subtitle.enabled || !text) return null;
  const bg = hexToRgba(subtitle.backgroundColor, subtitle.backgroundOpacity);

  return (
    <div
      className="absolute pointer-events-none whitespace-pre-wrap"
      style={{
        left: `${subtitle.position.x * 100}%`,
        top: `${subtitle.position.y * 100}%`,
        transform: `translate(-${subtitle.position.x * 100}%, -${subtitle.position.y * 100}%)`,
        fontFamily: subtitle.fontFamily,
        fontWeight: subtitle.fontWeight,
        fontSize: `${(subtitle.fontSize / outputWidth) * 100}cqw`,
        color: subtitle.fontColor,
        background: bg,
        padding: `${(subtitle.padding / outputWidth) * 100}cqw`,
        textAlign: subtitle.alignment,
        maxWidth: `${(subtitle.maxWidth / outputWidth) * 100}%`,
      }}
    >
      {text}
    </div>
  );
}

function TemplatePreviewOverlay({
  config,
  clip,
  partNumber,
  subtitleText = "",
}: {
  config: TemplateConfig;
  clip: Clip;
  partNumber?: number;
  subtitleText?: string;
}) {
  return (
    <>
      {config.watermark.enabled && config.watermark.imagePath && (
        <img
          src={convertFileSrc(config.watermark.imagePath)}
          alt=""
          className="absolute pointer-events-none"
          style={{
            left: `${config.watermark.position.x * 100}%`,
            top: `${config.watermark.position.y * 100}%`,
            width: `${config.watermark.scale * 100}%`,
            opacity: config.watermark.opacity,
            transform: `translate(-${config.watermark.position.x * 100}%, -${config.watermark.position.y * 100}%)`,
          }}
        />
      )}
      <CaptionOverlayBlock
        caption={config.caption}
        outputWidth={config.output.width}
        aiCaption={clip.aiCaption}
        partNumber={partNumber}
      />
      <CaptionOverlayBlock
        caption={config.caption2}
        outputWidth={config.output.width}
        aiCaption={clip.aiCaption}
        partNumber={partNumber}
      />
      <SubtitleOverlayBlock subtitle={config.subtitle} outputWidth={config.output.width} text={subtitleText} />
    </>
  );
}

function TimelineClip({
  clip,
  moviePath,
  selected,
  onSelect,
  label,
}: {
  clip: Clip;
  moviePath: string;
  selected: boolean;
  onSelect: () => void;
  label?: string;
}) {
  const thumb = useThumbnailSrc(moviePath, clip.startSeconds, clip.id);
  const rendered = Boolean(clip.finalOutputPath || clip.outputPath);

  return (
    <button
      onClick={onSelect}
      className={`flex-shrink-0 w-[140px] h-[84px] rounded-md overflow-hidden relative border-2 transition-colors ${
        selected ? "border-blue-500" : "border-transparent hover:border-neutral-600"
      }`}
    >
      {thumb ? (
        <img src={thumb} alt="" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full bg-neutral-800 flex items-center justify-center">
          <Film size={18} className="text-neutral-600" />
        </div>
      )}
      {label && (
        <div className="absolute inset-x-0 top-0 bg-black/70 px-1.5 py-0.5">
          <span className="text-[10px] font-medium text-neutral-200">{label}</span>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1.5 py-0.5 flex items-center justify-between">
        <span className="text-[10px] font-mono text-neutral-200">
          {formatDuration(clip.startSeconds)}–{formatDuration(clip.endSeconds)}
        </span>
        {rendered && <span className="w-1.5 h-1.5 rounded-full bg-green-500" />}
      </div>
    </button>
  );
}

const STATUS_COLORS: Record<string, string> = {
  created: "bg-neutral-600",
  analyzing: "bg-yellow-600",
  ready: "bg-green-600",
  error: "bg-red-600",
};

// A project card: thumbnail with name/status/stats overlaid on top of it (not stacked
// below), so the sidebar can list every project as a compact switcher instead of only
// showing one project's details at a time.
/// Deleting is permanent (the Rust side cascades to the project's clips/upload_queue rows
/// and nothing un-deletes a movie file reference) — this is the only thing standing between
/// a stray click on the small trash icon and losing a whole project's work.
function DeleteProjectDialog({
  project,
  deleting,
  onConfirm,
  onClose,
}: {
  project: Project;
  deleting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="bg-neutral-900 text-neutral-100 rounded-lg p-5 w-[380px] border border-neutral-700"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <h2 className="text-sm font-semibold mb-2">Delete "{project.name}"?</h2>
        <p className="text-xs text-neutral-400 mb-4">
          This permanently deletes the project, its {project.clipsCount + project.partsCount} clip(s)/part(s), and
          their rendered files. Anything already posted to a platform stays posted — only the ClipFlow project is
          removed. This can't be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-xs disabled:opacity-50"
            disabled={deleting}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-xs disabled:opacity-50"
            disabled={deleting}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onConfirm();
            }}
          >
            {deleting ? "Deleting…" : "Delete project"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameProjectDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const updateProjectName = useProjectStore((s) => s.updateProjectName);
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name can't be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateProjectName(project.id, trimmed);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="bg-neutral-900 text-neutral-100 rounded-lg p-5 w-[380px] border border-neutral-700"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <h2 className="text-sm font-semibold mb-3">Edit project</h2>
        <label className="text-xs text-neutral-400">Name</label>
        <input
          autoFocus
          className="w-full mt-1 rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <p className="text-[11px] text-neutral-500 mt-2 truncate" title={project.moviePath}>
          Source: {project.moviePath}
        </p>
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button
            className="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-xs disabled:opacity-50"
            disabled={saving}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-xs disabled:opacity-50"
            disabled={saving}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              save();
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectCard({ project, selected }: { project: Project; selected: boolean }) {
  const seek = project.sourceDurationSeconds ? Math.min(10, project.sourceDurationSeconds * 0.05) : 3;
  // A YouTube-imported project's real thumbnail (youtube_import_project sets this) beats an
  // ffmpeg-extracted frame — cutting the local ffmpeg call entirely by passing `undefined`
  // when it exists, since it'd otherwise be wasted work on every render.
  const generatedThumb = useThumbnailSrc(project.sourceThumbnailUrl ? undefined : project.moviePath, seek, project.id);
  const thumb = project.sourceThumbnailUrl ?? generatedThumb;
  const { deleteProject } = useProjectStore();
  const navigate = useNavigate();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteProject(project.id);
      setConfirmingDelete(false);
      if (selected) navigate("/");
    } catch {
      // deleteProject's own error path already surfaces via projectStore.error / the
      // page-level error banner — leave the dialog open so the user can retry or cancel.
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="relative group flex-shrink-0 w-full aspect-video rounded-md overflow-hidden">
      <Link
        to={`/projects/${project.id}`}
        className={`absolute inset-0 border-2 transition-colors ${
          selected ? "border-blue-500" : "border-transparent hover:border-neutral-600"
        }`}
      >
        {thumb ? (
          <img src={thumb} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full bg-neutral-800 flex items-center justify-center">
            <Film size={20} className="text-neutral-600" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/10 to-transparent" />
        <span
          className={`absolute top-1.5 right-1.5 w-2 h-2 rounded-full ${STATUS_COLORS[project.status] ?? "bg-neutral-600"}`}
          title={project.status}
        />
        <div className="absolute inset-x-0 bottom-0 px-2 py-1.5">
          <p className="text-xs font-medium text-neutral-100 truncate" title={project.name}>
            {project.name}
          </p>
          <p className="text-[10px] text-neutral-300 font-mono">
            {project.sourceDurationSeconds != null ? formatDuration(project.sourceDurationSeconds) : "—"} · {project.clipsCount} clips · {project.partsCount} parts
          </p>
        </div>
      </Link>
      <div className="absolute top-1.5 left-1.5 z-10 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          className="p-1 rounded bg-black/60 hover:bg-neutral-700 text-neutral-300 hover:text-white"
          title="Edit project"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setRenaming(true);
          }}
        >
          <Pencil size={12} />
        </button>
        <button
          className="p-1 rounded bg-black/60 hover:bg-red-600 text-neutral-300 hover:text-white"
          title="Delete project"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setConfirmingDelete(true);
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {renaming && <RenameProjectDialog project={project} onClose={() => setRenaming(false)} />}

      {confirmingDelete && (
        <DeleteProjectDialog
          project={project}
          deleting={deleting}
          onConfirm={handleDelete}
          onClose={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}

// "Full Video" (not "Full Movie") since a project's source can now be a downloaded YouTube
// video via youtube_import_project, not just a locally-picked movie file — the underlying
// `kind = 'part'` pipeline (analyze_movie, movie_status, etc.) is unchanged either way.
const ANALYZE_MODE_LABELS: Record<"clips" | "movie", string> = { clips: "Clips", movie: "Full Video" };

/// "Ready to auto-upload" = rendered (has an output file the queue can actually pick up —
/// same definition TimelineClip uses for its own "rendered" badge) and not already sitting
/// in the upload queue for every connected account. Clips still mid-render or never
/// rendered don't have a video file for `queue_manager::run_job` to send.
function isReadyToUpload(clip: Clip): boolean {
  return Boolean(clip.finalOutputPath || clip.outputPath);
}

const QUEUE_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  uploading: "Uploading",
  completed: "Completed",
  failed: "Failed",
};

function queueStatusColor(status: string): string {
  switch (status) {
    case "completed":
      return "text-green-400";
    case "failed":
      return "text-red-400";
    case "uploading":
      return "text-blue-400";
    default:
      return "text-neutral-400";
  }
}

/// Lets you check on/play back this project's queued clips without leaving the editor for
/// the global Queue page — opened from the "View queue" toolbar button.
function QueueViewerDialog({ items, onClose }: { items: QueueItem[]; onClose: () => void }) {
  const { retryItem, removeItem } = useQueueStore();
  const [previewItem, setPreviewItem] = useState<QueueItem | null>(null);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-neutral-900 text-neutral-100 rounded-lg p-6 w-[600px] max-h-[80vh] flex flex-col border border-neutral-700">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold">Queued uploads</h2>
          <button className="p-1 rounded hover:bg-neutral-800 text-neutral-400" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <p className="text-xs text-neutral-500 mb-4">Clips from this project currently queued or uploading.</p>

        {previewItem ? (
          <div>
            <video
              key={previewItem.id}
              src={convertFileSrc(previewItem.clipFinalOutputPath || previewItem.clipOutputPath || "")}
              controls
              autoPlay
              className="w-full max-h-[420px] rounded bg-black"
            />
            <div className="mt-3">
              <p className="text-sm font-medium text-neutral-100 truncate">{previewItem.title}</p>
              {previewItem.hashtags.length > 0 && (
                <p className="text-xs text-blue-400 mt-1 break-words">{previewItem.hashtags.join(" ")}</p>
              )}
            </div>
            <button
              className="text-xs text-neutral-400 hover:text-neutral-200 mt-2"
              onClick={() => setPreviewItem(null)}
            >
              ← Back to list
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-neutral-500">Nothing from this project is queued yet.</p>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-2 -mr-2 pr-2">
            {items.map((item) => {
              const thumbPath = item.clipFinalOutputPath || item.clipOutputPath;
              return (
                <div
                  key={item.id}
                  className={`flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2.5 ${
                    thumbPath ? "cursor-pointer hover:border-neutral-700" : ""
                  }`}
                  onClick={() => thumbPath && setPreviewItem(item)}
                >
                  <div
                    className="w-16 h-10 rounded bg-neutral-800 overflow-hidden flex-shrink-0 flex items-center justify-center"
                    title={thumbPath ? "Play" : "No preview"}
                  >
                    {thumbPath ? (
                      <video src={convertFileSrc(thumbPath)} className="w-full h-full object-cover pointer-events-none" />
                    ) : (
                      <span className="text-[10px] text-neutral-600">No preview</span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className={queueStatusColor(item.status)}>
                        {QUEUE_STATUS_LABELS[item.status] ?? item.status}
                      </span>
                      <span className="text-neutral-500 text-xs truncate">
                        → {item.accountName} ({PLATFORM_LABELS[item.platform] ?? item.platform})
                      </span>
                    </div>
                    {item.status === "uploading" && (
                      <div className="w-full h-1.5 rounded-full bg-neutral-800 mt-1.5 overflow-hidden">
                        <div className="h-full bg-blue-500 transition-all" style={{ width: `${item.progress}%` }} />
                      </div>
                    )}
                    {item.errorMessage && <p className="text-xs text-red-400 mt-1 truncate">{item.errorMessage}</p>}
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                    {item.status === "failed" && (
                      <button
                        className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400"
                        title="Retry"
                        onClick={() => retryItem(item.id)}
                      >
                        <RefreshCw size={14} />
                      </button>
                    )}
                    <button
                      className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400"
                      title="Remove"
                      onClick={() => removeItem(item.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/// "Auto upload this project" is a one-click hands-off pipeline: slices the whole video if
/// needed, generates AI captions, renders every clip through a template, and queues (and
/// then actually uploads) every rendered clip to every configured account — real posts to
/// real accounts, potentially many clips at once, kicked off by a single click on a small
/// toolbar icon. This gate exists so that click is a deliberate confirmation, not a
/// misclick, and so the user knows up front what's about to run and where.
function AutoUploadConfirmDialog({
  project,
  templateName,
  accountNames,
  mode,
  running,
  isOnline,
  onConfirm,
  onClose,
}: {
  project: Project;
  templateName: string;
  accountNames: string[];
  mode: "clips" | "movie";
  running: boolean;
  isOnline: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-neutral-900 text-neutral-100 rounded-lg p-5 w-[420px] border border-neutral-700">
        <h2 className="text-sm font-semibold mb-2">Run Auto upload on "{project.name}"?</h2>
        <p className="text-xs text-neutral-400 mb-3">This is a big, mostly-irreversible job. It will, in order:</p>
        <ol className="text-xs text-neutral-300 list-decimal list-inside space-y-1 mb-3">
          <li>Slice the {mode === "movie" ? "full video into parts" : "movie into clips"} (if not already done)</li>
          <li>Generate AI captions for any clip/part missing one</li>
          <li>Render every clip through the "{templateName}" template</li>
          <li>
            Queue and upload every rendered clip to: <span className="text-neutral-100">{accountNames.join(", ")}</span>
          </li>
        </ol>
        <p className="text-xs text-amber-400 mb-4">
          Step 4 posts real videos to those accounts. Cancelling after this point means removing individual queue
          items or posts yourself — there's no single "undo".
        </p>
        {!isOnline && (
          <p className="text-xs text-amber-400 mb-2">No internet connection right now — reconnect to run this.</p>
        )}
        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-xs disabled:opacity-50"
            disabled={running}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-xs disabled:opacity-50"
            disabled={running || !isOnline}
            onClick={onConfirm}
          >
            {running ? "Running…" : "Run it"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AutoUploadDialog({
  clips,
  accounts,
  queueItems,
  selectedTemplateId,
  renderClipFinal,
  onClose,
}: {
  clips: Clip[];
  accounts: Account[];
  queueItems: QueueItem[];
  selectedTemplateId: string;
  renderClipFinal: (clipId: string, templateId: string) => Promise<void>;
  onClose: () => void;
}) {
  const { addToQueue } = useQueueStore();

  // clipId -> set of accountIds already queued/uploaded for it, regardless of status —
  // re-adding a pair that's already there would just create a duplicate queue row.
  const alreadyQueued = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const item of queueItems) {
      if (!map.has(item.clipId)) map.set(item.clipId, new Set());
      map.get(item.clipId)!.add(item.accountId);
    }
    return map;
  }, [queueItems]);

  const candidates = useMemo(
    () =>
      clips
        .filter(isReadyToUpload)
        .filter((c) => (alreadyQueued.get(c.id)?.size ?? 0) < Math.max(accounts.length, 1)),
    [clips, alreadyQueued, accounts.length]
  );

  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(() => new Set(candidates.map((c) => c.id)));
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(
    () => new Set(accounts.filter((a) => a.isActive).map((a) => a.id))
  );
  // A second click, not a second modal — this queues real uploads that start immediately
  // (queue_manager.rs's kick() picks them up right away), so the first click on "Queue N
  // items" just swaps that button for an explicit confirmation instead of firing right away.
  const [confirming, setConfirming] = useState(false);

  function toggleClip(id: string) {
    setSelectedClipIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAccount(id: string) {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function submit() {
    const clipIds = [...selectedClipIds];
    const accountIds = [...selectedAccountIds];
    // Fire-and-forget: rendering + queueing runs in the background (the render queue
    // already serializes/tracks itself via render_manager.rs, and queue items show up in
    // the Queue page immediately after each addToQueue) — the modal doesn't need to stay
    // open and block the user until every clip in the batch is done. Per-clip failures are
    // surfaced where the user will actually look afterward (the render queue indicator /
    // the queue item's own error state), not in this now-closed modal.
    (async () => {
      for (const clipId of clipIds) {
        try {
          // Template is applied here, at queue time, not while browsing — so switching
          // templates while looking at clips never kicks off a render. Always re-renders
          // (no "already has a final render for this template id" shortcut) because the
          // template's own config (alignment, text, colors, ...) can change without its id
          // changing — reusing an old render by id alone would silently serve stale output.
          if (selectedTemplateId) {
            await renderClipFinal(clipId, selectedTemplateId);
          }
          const already = alreadyQueued.get(clipId) ?? new Set<string>();
          const toQueue = accountIds.filter((accId) => !already.has(accId));
          if (toQueue.length > 0) {
            await addToQueue(clipId, toQueue);
          }
        } catch (e) {
          console.error(`Queue uploads: failed for clip ${clipId}:`, e);
        }
      }
    })();
    onClose();
  }

  const label = (c: Clip) => {
    const excerpt = (c.transcriptExcerpt ?? "").trim();
    const kindLabel = c.kind === "part" ? "Part" : "Clip";
    return `${kindLabel} · ${formatDuration(c.endSeconds - c.startSeconds)}${excerpt ? " · " + excerpt.slice(0, 60) : ""}`;
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-neutral-900 text-neutral-100 rounded-lg p-6 w-[560px] max-h-[80vh] flex flex-col border border-neutral-700">
        <h2 className="text-lg font-semibold mb-1">Queue uploads</h2>
        <p className="text-xs text-neutral-500 mb-4">
          Finds rendered clips and movie parts not yet queued for upload. Pick what to send
          and to which account(s), then queue it all at once.
        </p>

        {accounts.length === 0 ? (
          <p className="text-sm text-neutral-400">No accounts connected — add one under Accounts first.</p>
        ) : (
          <>
            <div className="mb-3">
              <p className="text-xs text-neutral-400 mb-1.5">Accounts</p>
              <div className="flex flex-wrap gap-2">
                {accounts.map((a) => (
                  <label
                    key={a.id}
                    className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border cursor-pointer ${
                      selectedAccountIds.has(a.id)
                        ? "border-blue-500 bg-blue-500/10"
                        : "border-neutral-700 hover:border-neutral-600"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-blue-500"
                      checked={selectedAccountIds.has(a.id)}
                      onChange={() => toggleAccount(a.id)}
                    />
                    {a.accountName}
                    <span className="text-neutral-500">({PLATFORM_LABELS[a.platform] ?? a.platform})</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs text-neutral-400">Clips &amp; parts ({candidates.length} ready)</p>
              <div className="flex gap-2 text-xs">
                <button
                  className="text-blue-400 hover:text-blue-300"
                  onClick={() => setSelectedClipIds(new Set(candidates.map((c) => c.id)))}
                >
                  Select all
                </button>
                <button className="text-neutral-500 hover:text-neutral-300" onClick={() => setSelectedClipIds(new Set())}>
                  Clear
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto border border-neutral-800 rounded divide-y divide-neutral-800">
              {candidates.length === 0 ? (
                <p className="text-sm text-neutral-500 p-3">
                  Nothing to upload — every rendered clip/part is already queued for all
                  accounts.
                </p>
              ) : (
                candidates.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-neutral-800/50">
                    <input
                      type="checkbox"
                      className="accent-blue-500"
                      checked={selectedClipIds.has(c.id)}
                      onChange={() => toggleClip(c.id)}
                    />
                    <span className="flex-1 truncate">{label(c)}</span>
                    {(alreadyQueued.get(c.id)?.size ?? 0) > 0 && (
                      <span className="text-[10px] text-neutral-500 shrink-0">
                        already queued for {alreadyQueued.get(c.id)!.size}
                      </span>
                    )}
                  </label>
                ))
              )}
            </div>
          </>
        )}

        {confirming && (
          <p className="text-xs text-amber-400 pt-3">
            This queues {selectedClipIds.size} clip{selectedClipIds.size === 1 ? "" : "s"} to{" "}
            {selectedAccountIds.size} account{selectedAccountIds.size === 1 ? "" : "s"} and starts uploading
            immediately.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-4">
          <button
            className="px-4 py-2 rounded text-sm hover:bg-neutral-800"
            onClick={() => (confirming ? setConfirming(false) : onClose())}
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm disabled:opacity-50"
            disabled={selectedClipIds.size === 0 || selectedAccountIds.size === 0}
            onClick={() => (confirming ? submit() : setConfirming(true))}
          >
            {confirming
              ? "Confirm & queue"
              : `Queue ${selectedClipIds.size} item${selectedClipIds.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// Automatic mismatch warning + manual re-sync control — see
// commands::project::get_transcript_sync_status/set_transcript_offset. There's no forced
// audio-alignment "matcher" here (that needs real speech-to-timing analysis, e.g. Whisper's
// word timestamps, which this app doesn't run) — this is a constant-offset correction: type
// how many seconds the transcript is early/late and every subtitle cue shifts by that much,
// both in this live preview and in the final render.
function TranscriptSyncWarning({
  status,
  expanded,
  onToggle,
  onApply,
}: {
  status: TranscriptSyncStatus;
  expanded: boolean;
  onToggle: () => void;
  onApply: (offsetSeconds: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(status.offsetSeconds));
  const [applying, setApplying] = useState(false);
  const suggested = status.offsetSeconds - status.transcriptStartSeconds;

  return (
    <div className="border-b border-amber-900 bg-amber-950/40">
      <button
        className="w-full flex items-center gap-2 px-4 py-1.5 text-xs text-amber-300 text-left"
        onClick={onToggle}
      >
        <AlertTriangle size={13} className="shrink-0" />
        <span className="flex-1">
          Transcript timing looks off — it runs {formatDuration(status.transcriptEndSeconds)} but the movie is{" "}
          {formatDuration(status.movieDurationSeconds)} long. Subtitles may not line up with what's on screen.
        </span>
        <span className="text-amber-500 underline">{expanded ? "Hide" : "Fix sync"}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-3 flex items-center gap-2 text-xs text-amber-200">
          <span>Shift transcript by</span>
          <input
            type="number"
            step="0.5"
            className="w-24 px-2 py-1 rounded bg-neutral-900 border border-amber-800 text-neutral-100"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <span>seconds (negative = earlier)</span>
          <button
            className="px-3 py-1 rounded bg-amber-700 hover:bg-amber-600 text-neutral-100 disabled:opacity-50"
            disabled={applying || !Number.isFinite(Number(draft))}
            onClick={async () => {
              setApplying(true);
              try {
                await onApply(Number(draft));
              } finally {
                setApplying(false);
              }
            }}
          >
            {applying ? "Applying…" : "Apply"}
          </button>
          <button
            className="text-amber-500 hover:text-amber-400 underline"
            onClick={() => setDraft(suggested.toFixed(1))}
            title="Shift the transcript's first line to start at 0:00 — a common fix when it starts partway into the movie"
          >
            Suggest ({suggested >= 0 ? "+" : ""}
            {suggested.toFixed(1)}s)
          </button>
          <span className="text-amber-500">
            This only re-times the subtitle overlay — it won't re-cut clips or re-run AI analysis.
          </span>
        </div>
      )}
    </div>
  );
}

function ActivityLogPanel({
  entries,
  onClose,
}: {
  entries: import("../stores/projectStore").ActivityLogEntry[];
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries.length]);

  return (
    <div className="fixed right-0 top-14 bottom-0 w-[380px] bg-[#161618] border-l border-black/40 z-40 flex flex-col shadow-2xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-black/40">
        <h2 className="text-sm font-medium">Activity log</h2>
        <button className="p-1 rounded hover:bg-neutral-800 text-neutral-400" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {entries.length === 0 ? (
          <p className="text-xs text-neutral-500">Nothing yet — run Analyze to see a live timeline here.</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className={entry.stage === "ai_status" ? "pl-3 border-l-2 border-neutral-800" : "pl-3 border-l-2 border-blue-600"}>
              <div className="flex items-center gap-2 text-[10px] text-neutral-500">
                <span className="font-mono">{formatClockTime(entry.timestamp)}</span>
                <span className="uppercase">{entry.mode}</span>
                {entry.progress >= 0 && <span>{Math.round(entry.progress * 100)}%</span>}
              </div>
              <p className={entry.stage === "ai_status" ? "text-xs text-neutral-400" : "text-xs text-neutral-200 font-medium"}>
                {entry.stage === "ai_status" ? entry.detail : stageLabel(entry.stage)}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const {
    currentProject,
    projects,
    fetchProjects,
    clips,
    fetchProject,
    fetchClips,
    analyzeClips,
    analyzeMovie,
    cancelAnalysis,
    clipsAnalysisProgress,
    movieAnalysisProgress,
    error,
    renderClipPreview,
    renderClipFinal,
    renderingClipIds,
    renderVersion,
    updateClipCaption,
    updateClipCustomCaption,
    generateClipCaption,
    generatingCaptionClipId,
    generatingCaptionsForProject,
    generateMissingCaptions,
    refiningCaptionsForProject,
    refineCaptions,
    trendingHashtags,
    fetchingTrendingHashtags,
    fetchTrendingHashtags,
    getTranscriptSyncStatus,
    setTranscriptOffset,
    activityLog,
    initActivityLogListener,
  } = useProjectStore();
  const isOnline = useOnlineStore((s) => s.isOnline);
  const OFFLINE_TITLE = "No internet connection — this needs to reach the AI Engine/platform.";
  const { templates, fetchTemplates } = useTemplateStore();
  const [partCaptionDraft, setPartCaptionDraft] = useState("");
  const [savingPartCaption, setSavingPartCaption] = useState(false);
  const { settings, fetchSettings } = useSettingsStore();
  const { accounts, fetchAccounts } = useAccountStore();
  const { addToQueue, items: queueItems, fetchQueue } = useQueueStore();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [captionDraft, setCaptionDraft] = useState("");
  const [customCaptionDraft, setCustomCaptionDraft] = useState("");
  const [queuedClipId, setQueuedClipId] = useState<string | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [videoNaturalSize, setVideoNaturalSize] = useState<{ width: number; height: number } | null>(null);
  // Subtitle cues (clip-relative start/end/text) for the currently selected clip — mirrors
  // exactly what render_final burns into the video via ffmpeg's drawtext `enable` windows
  // (see transcript::compute_cues), so the raw-trim live preview shows the same lines at the
  // same instants instead of the subtitle only ever appearing once a clip is uploaded.
  const [subtitleCues, setSubtitleCues] = useState<{ start: number; end: number; text: string }[]>([]);
  const [previewTime, setPreviewTime] = useState(0);
  const [syncStatus, setSyncStatus] = useState<TranscriptSyncStatus | null>(null);
  const [showSyncFixer, setShowSyncFixer] = useState(false);
  // Which analysis progress bar (clipsAnalysisProgress vs movieAnalysisProgress) is visible
  // is keyed off this — it used to always default to "clips" regardless of which mode a
  // project actually used, so a Full Video project's caption-backfill progress (still
  // running well after "parts" first appear) was silently invisible on the default tab,
  // with nothing telling you it was still working in the background. Fixed by the two
  // effects below: default to whichever kind the project actually has content in, and
  // always jump to whichever mode currently has a live analysis running.
  const [displayMode, setDisplayMode] = useState<"clips" | "movie">("clips");
  const [showAutoUpload, setShowAutoUpload] = useState(false);
  const [showQueueViewer, setShowQueueViewer] = useState(false);
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [showAutoUploadSettings, setShowAutoUploadSettings] = useState(false);
  const [showAutoUploadConfirm, setShowAutoUploadConfirm] = useState(false);
  const [autoUploadError, setAutoUploadError] = useState<string | null>(null);
  const {
    settings: autoUploadSettings,
    fetchSettings: fetchAutoUploadSettings,
    running: autoUploadRunning,
    progressLabel: autoUploadProgressLabel,
    runAutoUpload,
  } = useAutoUploadStore();
  const autoRenderAttempted = useRef<Set<string>>(new Set());
  // A clip's DB row can point at a rendered file that no longer exists on disk (deleted to
  // free space, wiped renders dir, etc. — see the disk-near-full note in project memory).
  // Previously the player just showed black forever in that case, since playerSrc being
  // "truthy" (path string still set) skipped the whole rendering/retry UI branch entirely.
  // Tracking playback failures here routes those clips back through the same render/retry
  // path a never-rendered clip already goes through.
  const [failedPlaybackClipIds, setFailedPlaybackClipIds] = useState<Set<string>>(new Set());
  const retryingClipIds = useRef<Set<string>>(new Set());
  // Caps the automatic playback-failure retry to one attempt per clip — without this, a
  // *persistent* failure (e.g. disk full, so the re-render fails too) retried forever: the
  // video tag would immediately error again on the same still-broken file, re-arming the
  // retry effect in an infinite loop that looked like rapid blinking.
  const autoRetryAttempts = useRef<Record<string, number>>({});

  useEffect(() => {
    initActivityLogListener();
  }, [initActivityLogListener]);

  useEffect(() => {
    if (!id) return;
    fetchProject(id);
    fetchClips(id);
    fetchProjects();
    fetchTemplates();
    fetchSettings();
    fetchAccounts();
    fetchQueue();
    fetchAutoUploadSettings();
  }, [
    id,
    fetchProject,
    fetchClips,
    fetchProjects,
    fetchTemplates,
    fetchSettings,
    fetchAccounts,
    fetchQueue,
    fetchAutoUploadSettings,
  ]);

  // Default the tab to whichever kind this project actually has content in, instead of
  // always "clips" — a Full Video project (parts, no clips) previously landed on an empty
  // "clips" tab whose (irrelevant) progress bar stayed blank the whole time.
  useEffect(() => {
    if (!currentProject) return;
    if (currentProject.partsCount > 0 && currentProject.clipsCount === 0) setDisplayMode("movie");
    else if (currentProject.clipsCount > 0 && currentProject.partsCount === 0) setDisplayMode("clips");
  }, [currentProject?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Warns automatically when a transcript's own timestamps don't line up with how long the
  // movie file actually is (wrong export, transcript for a different cut of the movie,
  // etc.) — probes the real file duration via ffmpeg rather than trusting anything derived
  // from the transcript itself. Re-checks whenever the project (or its saved offset fix)
  // changes.
  useEffect(() => {
    setSyncStatus(null);
    if (!currentProject?.transcriptPath) return;
    let cancelled = false;
    getTranscriptSyncStatus(currentProject.id)
      .then((status) => {
        if (!cancelled) setSyncStatus(status);
      })
      .catch((e) => {
        // Best-effort background check (e.g. ffmpeg not on PATH would fail this the same
        // way it fails everything else render-related, already surfaced elsewhere) — not
        // worth its own error banner.
        console.warn("Transcript sync check failed:", e);
      });
    return () => {
      cancelled = true;
    };
  }, [currentProject?.id, currentProject?.transcriptPath, currentProject?.transcriptOffsetSeconds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whichever mode currently has a live analysis (including the post-slicing caption
  // backfill, which can run long after "parts"/"clips" first appear) should always be
  // visible — otherwise switching tabs (or the default above picking the "wrong" one before
  // parts/clips exist yet) can hide an analysis that's still actively running.
  useEffect(() => {
    if (movieAnalysisProgress?.projectId === id) setDisplayMode("movie");
    else if (clipsAnalysisProgress?.projectId === id) setDisplayMode("clips");
  }, [id, movieAnalysisProgress, clipsAnalysisProgress]);

  useEffect(() => {
    if (selectedAccountIds.size === 0 && accounts.length > 0) setSelectedAccountIds(new Set([accounts[0].id]));
  }, [accounts, selectedAccountIds]);

  function toggleTargetAccount(id: string) {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  useEffect(() => {
    if (selectedTemplateId || templates.length === 0) return;
    const defaultId = settings[SETTING_DEFAULT_TEMPLATE_ID];
    const defaultExists = defaultId && templates.some((t) => t.id === defaultId);
    setSelectedTemplateId(defaultExists ? defaultId : templates[0].id);
  }, [templates, settings, selectedTemplateId]);

  const clipItems = useMemo(() => clips.filter((c) => c.kind === "clip"), [clips]);
  const partItems = useMemo(() => clips.filter((c) => c.kind === "part"), [clips]);
  const displayedItems = displayMode === "clips" ? clipItems : partItems;

  // Keep the selection within whichever list is currently displayed — switching modes (or
  // a fresh analysis result landing) should re-anchor to that list's first item.
  useEffect(() => {
    if (displayedItems.length === 0) {
      setSelectedClipId(null);
      return;
    }
    if (!displayedItems.some((c) => c.id === selectedClipId)) {
      setSelectedClipId(displayedItems[0].id);
    }
  }, [displayedItems, selectedClipId]);

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;
  const selectedPartIndex = selectedClip?.kind === "part" ? partItems.findIndex((c) => c.id === selectedClip.id) : -1;
  // 1-based rank among same-kind siblings ordered by start_seconds — matches
  // render.rs's part_number computation exactly, for the {part_number} caption token.
  const selectedItemIndex = displayedItems.findIndex((c) => c.id === selectedClipId);
  const selectedPartNumber = selectedItemIndex >= 0 ? selectedItemIndex + 1 : undefined;

  const selectedTemplateConfig = useMemo<TemplateConfig | null>(() => {
    const template = templates.find((t) => t.id === selectedTemplateId);
    if (!template) return null;
    try {
      const parsed = JSON.parse(template.configJson) as Partial<TemplateConfig>;
      // Templates saved before caption2/subtitle were added have no such field at all —
      // merge onto the defaults so older templates don't crash the caption overlay render.
      const defaults = defaultTemplateConfig(parsed.platform ?? "tiktok");
      return { ...defaults, ...parsed, caption2: parsed.caption2 ?? defaults.caption2, subtitle: parsed.subtitle ?? defaults.subtitle };
    } catch {
      return null;
    }
  }, [templates, selectedTemplateId]);

  useEffect(() => {
    setCaptionDraft(selectedClip?.aiCaption ?? "");
  }, [selectedClip?.id, selectedClip?.aiCaption]);

  useEffect(() => {
    setCustomCaptionDraft(selectedClip?.customCaption ?? "");
  }, [selectedClip?.id, selectedClip?.customCaption]);

  useEffect(() => {
    setPreviewTime(0);
    if (!selectedClip) {
      setSubtitleCues([]);
      return;
    }
    let cancelled = false;
    invoke<{ start: number; end: number; text: string }[]>("get_clip_subtitle_cues", { clipId: selectedClip.id })
      .then((cues) => {
        if (!cancelled) setSubtitleCues(cues);
      })
      .catch(() => {
        if (!cancelled) setSubtitleCues([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedClip?.id]);

  const activeSubtitleText = useMemo(() => {
    const cue = subtitleCues.find((c) => previewTime >= c.start && previewTime < c.end);
    return cue?.text ?? "";
  }, [subtitleCues, previewTime]);

  useEffect(() => {
    setPartCaptionDraft(selectedTemplateConfig?.caption2.text ?? "");
  }, [selectedTemplateId, selectedTemplateConfig?.caption2.text]);

  async function savePartCaptionTemplate() {
    if (!selectedTemplateConfig || !selectedTemplateId) return;
    const template = templates.find((t) => t.id === selectedTemplateId);
    if (!template) return;
    setSavingPartCaption(true);
    try {
      const updatedConfig = {
        ...selectedTemplateConfig,
        // Saving from here means the user is deliberately setting this up — force it on so
        // it actually shows up in the render instead of silently staying invisible because
        // caption2 defaults to disabled (the bug this panel exists to make discoverable).
        caption2: { ...selectedTemplateConfig.caption2, text: partCaptionDraft, enabled: true },
      };
      await invoke("update_template", {
        id: selectedTemplateId,
        name: template.name,
        configJson: JSON.stringify(updatedConfig),
      });
      await fetchTemplates();
    } finally {
      setSavingPartCaption(false);
    }
  }

  // Auto-render the selected clip's preview so picking a clip in the timeline just plays
  // it, instead of requiring a manual "Render preview" click first. The templated "final"
  // render is intentionally NOT auto-applied here — it's applied on demand when the clip is
  // actually queued for upload (see applyTemplateAndQueue), so picking/changing a template
  // while browsing doesn't kick off a background render pass across every clip in the
  // project.
  useEffect(() => {
    if (!selectedClip) return;
    if (selectedClip.outputPath || selectedClip.finalOutputPath) return;
    if (renderingClipIds.has(selectedClip.id)) return;
    if (autoRenderAttempted.current.has(selectedClip.id)) return;
    autoRenderAttempted.current.add(selectedClip.id);
    renderClipPreview(selectedClip.id);
  }, [selectedClip, renderingClipIds, renderClipPreview]);

  // If playback of an existing render fails (missing file on disk), re-render it rather
  // than leaving the player permanently black — same recovery a never-rendered clip gets.
  // Capped at one automatic attempt (see autoRetryAttempts) and gated on the store's own
  // `error` field rather than promise rejection, because renderClipPreview/renderClipFinal
  // catch their own errors internally and always resolve — trusting a bare `.then()` here
  // previously meant a *failed* re-render was still treated as success, clearing the retry
  // guard and immediately re-attempting playback of the same still-broken file forever.
  useEffect(() => {
    if (!selectedClip) return;
    if (!failedPlaybackClipIds.has(selectedClip.id)) return;
    if (renderingClipIds.has(selectedClip.id)) return;
    if (retryingClipIds.current.has(selectedClip.id)) return;
    const clipId = selectedClip.id;
    if ((autoRetryAttempts.current[clipId] ?? 0) >= 1) return;
    autoRetryAttempts.current[clipId] = (autoRetryAttempts.current[clipId] ?? 0) + 1;
    retryingClipIds.current.add(clipId);
    const rerender = selectedClip.finalOutputPath
      ? renderClipFinal(clipId, selectedTemplateId)
      : renderClipPreview(clipId);
    rerender.then(() => {
      retryingClipIds.current.delete(clipId);
      if (useProjectStore.getState().error) {
        // Re-render itself failed — leave failedPlaybackClipIds set so the player falls
        // through to the existing "failed to render / Retry" UI instead of looping.
        return;
      }
      setFailedPlaybackClipIds((prev) => {
        const next = new Set(prev);
        next.delete(clipId);
        return next;
      });
    });
  }, [selectedClip, failedPlaybackClipIds, renderingClipIds, renderClipFinal, renderClipPreview, selectedTemplateId]);

  const projectActivityLog = useMemo(
    () => activityLog.filter((e) => e.projectId === id),
    [activityLog, id]
  );

  if (!currentProject) {
    return (
      <div className="p-8">
        <p className="text-neutral-400 text-sm">Loading…</p>
      </div>
    );
  }

  const activeAnalysisProgress = displayMode === "clips" ? clipsAnalysisProgress : movieAnalysisProgress;
  const analyzing = activeAnalysisProgress?.projectId === id;
  const activeStatus = displayMode === "clips" ? currentProject.clipsStatus : currentProject.movieStatus;
  const playerSrcPath = selectedClip?.finalOutputPath || selectedClip?.outputPath || null;
  // A cache-busting `?v=` query string (projectStore's renderVersion, bumped on every
  // successful render) forces the <video> to actually re-fetch after any re-render — the
  // rendered file's on-disk path is stable (`{clipId}_{templateId}.mp4`), so without this
  // the <video> element (and the browser/webview's own cache) would keep showing whatever
  // it already decoded for that exact URL, making a fixed render look unchanged.
  const playerSrc =
    playerSrcPath && selectedClip && !failedPlaybackClipIds.has(selectedClip.id)
      ? `${convertFileSrc(playerSrcPath)}?v=${renderVersion[selectedClip.id] ?? 0}`
      : null;
  // Only overlay the live preview on the raw (un-templated) trim — a finalOutputPath
  // already has the template's crop/watermark/caption baked in by FFmpeg.
  const showTemplateOverlay = Boolean(selectedClip && !selectedClip.finalOutputPath && selectedClip.outputPath);

  return (
    <div className="h-screen flex flex-col">
      {/* Top toolbar */}
      <div className="h-14 flex-shrink-0 flex items-center justify-between px-4 border-b border-black/40 bg-[#161618]">
        <h1 className="text-sm font-medium truncate max-w-md">{currentProject.name}</h1>
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-xs font-medium"
            onClick={() => setShowAutoUpload(true)}
            disabled={clips.every((c) => !isReadyToUpload(c))}
            title="Pick specific rendered clips/parts and accounts to queue"
          >
            <UploadCloud size={14} /> Queue uploads
          </button>
          <button
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-xs font-medium"
            onClick={() => {
              setShowQueueViewer(true);
              fetchQueue();
            }}
            title="View this project's queued/uploading clips"
          >
            <Eye size={14} /> View queue
          </button>
          <button
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium ${
              showActivityLog ? "bg-blue-600 hover:bg-blue-500" : "bg-neutral-800 hover:bg-neutral-700"
            }`}
            onClick={() => setShowActivityLog((v) => !v)}
            title="Toggle the activity log — a detailed timeline of what Analyze is doing"
          >
            <Clock size={14} /> Activity
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-1.5 bg-red-950/50 border-b border-red-900 text-xs text-red-300">{error}</div>
      )}

      {syncStatus?.mismatch && currentProject && (
        <TranscriptSyncWarning
          status={syncStatus}
          expanded={showSyncFixer}
          onToggle={() => setShowSyncFixer((v) => !v)}
          onApply={async (offset) => {
            await setTranscriptOffset(currentProject.id, offset);
            setShowSyncFixer(false);
          }}
        />
      )}

      <div className="flex-1 flex min-h-0">
        {/* Left: project switcher — every project as a thumbnail card (stats overlaid on
            the image, not stacked below it) so you can jump between movies in place. */}
        <div className="w-[220px] flex-shrink-0 bg-[#161618] border-r border-black/40 p-3 overflow-y-auto space-y-2">
          <div className="flex gap-1.5 mb-1">
            <button
              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium"
              onClick={() => setShowNewProjectDialog(true)}
            >
              <Plus size={14} /> New project
            </button>
            <button
              className="flex items-center justify-center px-2 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50"
              disabled={autoUploadRunning || !isOnline}
              title={
                !isOnline
                  ? OFFLINE_TITLE
                  : "Auto upload this project — slice, caption, render, and queue using your saved defaults"
              }
              onClick={() => {
                if (!autoUploadSettings || !autoUploadSettings.templateId || autoUploadSettings.accountIds.length === 0) {
                  setShowAutoUploadSettings(true);
                  return;
                }
                setShowAutoUploadConfirm(true);
              }}
            >
              <Zap size={14} />
            </button>
            <button
              className="flex items-center justify-center px-2 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700"
              title="Edit Auto upload defaults"
              onClick={() => setShowAutoUploadSettings(true)}
            >
              <Pencil size={14} />
            </button>
          </div>
          {autoUploadRunning && (
            <p className="text-[10px] text-blue-400 px-0.5 -mt-1 mb-1 animate-pulse">{autoUploadProgressLabel}</p>
          )}
          {autoUploadError && !autoUploadRunning && (
            <p className="text-[10px] text-red-400 px-0.5 -mt-1 mb-1">{autoUploadError}</p>
          )}
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} selected={p.id === currentProject.id} />
          ))}
        </div>

        {/* Center: single video player */}
        <div className="flex-1 min-w-0 flex items-center justify-center bg-[#0a0a0b] p-6">
          {!selectedClip ? (
            <p className="text-neutral-500 text-sm">
              No {displayMode === "clips" ? "clips" : "parts"} yet — use Analyze on the timeline below.
            </p>
          ) : playerSrc ? (
            showTemplateOverlay && selectedTemplateConfig ? (
              <div
                className="relative h-full max-w-full rounded overflow-hidden bg-black"
                style={{
                  aspectRatio: `${selectedTemplateConfig.output.width} / ${selectedTemplateConfig.output.height}`,
                  containerType: "inline-size",
                }}
              >
                <video
                  key={playerSrc}
                  controls
                  autoPlay
                  src={playerSrc}
                  className="w-full h-full"
                  style={videoPreviewStyle(selectedTemplateConfig, videoNaturalSize)}
                  onLoadedMetadata={(e) =>
                    setVideoNaturalSize({
                      width: e.currentTarget.videoWidth,
                      height: e.currentTarget.videoHeight,
                    })
                  }
                  onError={() =>
                    setFailedPlaybackClipIds((prev) => new Set(prev).add(selectedClip.id))
                  }
                  onTimeUpdate={(e) => setPreviewTime(e.currentTarget.currentTime)}
                />
                <TemplatePreviewOverlay
                  config={selectedTemplateConfig}
                  clip={selectedClip}
                  partNumber={selectedPartNumber}
                  subtitleText={activeSubtitleText}
                />
              </div>
            ) : (
              <video
                key={playerSrc}
                controls
                autoPlay
                src={playerSrc}
                className="max-h-full max-w-full rounded"
                onError={() => setFailedPlaybackClipIds((prev) => new Set(prev).add(selectedClip.id))}
              />
            )
          ) : renderingClipIds.has(selectedClip.id) || !autoRenderAttempted.current.has(selectedClip.id) ? (
            <p className="text-neutral-500 text-sm animate-pulse">
              Rendering {formatDuration(selectedClip.startSeconds)}–{formatDuration(selectedClip.endSeconds)}…
            </p>
          ) : (
            <div className="text-center space-y-3">
              <p className="text-neutral-500 text-sm">
                {formatDuration(selectedClip.startSeconds)}–{formatDuration(selectedClip.endSeconds)} failed to
                render
              </p>
              <button
                className="px-4 py-2 rounded bg-neutral-700 hover:bg-neutral-600 text-xs disabled:opacity-50"
                disabled={renderingClipIds.has(selectedClip.id)}
                onClick={() => renderClipPreview(selectedClip.id)}
              >
                Retry
              </button>
            </div>
          )}
        </div>

        {/* Right: clip settings + upload panel */}
        <div className="w-[300px] flex-shrink-0 bg-[#161618] border-l border-black/40 p-4 overflow-y-auto space-y-5">
          {selectedClip && (
            <>
              <div>
                <h3 className="text-sm font-medium text-neutral-300 mb-2">
                  {selectedClip.kind === "part" ? `Part ${selectedPartIndex + 1}` : "Clip"}
                </h3>
                <p className="text-xs text-neutral-500 font-mono mb-1">
                  {formatDuration(selectedClip.startSeconds)} – {formatDuration(selectedClip.endSeconds)}
                </p>
                {selectedClip.hookReason && (
                  <p className="text-xs text-neutral-400">{selectedClip.hookReason}</p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-neutral-300">Your caption</h3>
                </div>
                <p className="text-[11px] text-neutral-600 -mt-1.5 mb-1.5">
                  Your own writing — never touched by Generate with AI.
                </p>
                <textarea
                  className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-xs"
                  rows={2}
                  value={customCaptionDraft}
                  onChange={(e) => setCustomCaptionDraft(e.target.value)}
                  placeholder="Write your own caption"
                />
                <button
                  className="mt-1.5 px-3 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-xs disabled:opacity-50"
                  disabled={customCaptionDraft === (selectedClip.customCaption ?? "")}
                  onClick={() => updateClipCustomCaption(selectedClip.id, customCaptionDraft)}
                >
                  Save
                </button>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-neutral-300">AI caption</h3>
                  <button
                    className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 disabled:text-neutral-500"
                    disabled={generatingCaptionClipId === selectedClip.id || generatingCaptionsForProject === currentProject.id || !isOnline}
                    onClick={() => generateClipCaption(selectedClip.id)}
                    title={
                      !isOnline
                        ? OFFLINE_TITLE
                        : selectedClip.aiCaption
                        ? "Not happy with this one? Ask the AI to try again — replaces the text below."
                        : undefined
                    }
                  >
                    {generatingCaptionClipId === selectedClip.id ? (
                      "Generating…"
                    ) : selectedClip.aiCaption ? (
                      <>
                        <RefreshCw size={12} /> Regenerate
                      </>
                    ) : (
                      "✨ Generate with AI"
                    )}
                  </button>
                </div>
                {(() => {
                  // The bulk backfill (after slicing a new project, or "Generate all
                  // missing") only reports project-wide progress, not which clip it's on —
                  // so this can't say "generating this one right now", only "still working
                  // through the list, this one just hasn't come up yet". That's still a lot
                  // better than an empty textarea with zero explanation, which previously
                  // looked identical to nothing happening at all.
                  const backfillRunning =
                    !selectedClip.aiCaption &&
                    generatingCaptionClipId !== selectedClip.id &&
                    (generatingCaptionsForProject === currentProject.id ||
                      (activeAnalysisProgress?.projectId === currentProject.id && activeAnalysisProgress?.stage === "captions"));
                  return (
                    <div className="relative">
                      <textarea
                        className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-xs"
                        rows={3}
                        value={captionDraft}
                        onChange={(e) => setCaptionDraft(e.target.value)}
                        placeholder={backfillRunning ? "" : "No AI caption yet"}
                      />
                      {backfillRunning && (
                        <div className="absolute inset-0 flex items-center gap-1.5 px-2 text-xs text-neutral-500 pointer-events-none">
                          <Loader2 size={12} className="animate-spin" />
                          AI is still generating captions for this project — this clip hasn't come up yet.
                        </div>
                      )}
                    </div>
                  );
                })()}
                <button
                  className="mt-1.5 px-3 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-xs disabled:opacity-50"
                  disabled={captionDraft === (selectedClip.aiCaption ?? "")}
                  onClick={() => updateClipCaption(selectedClip.id, captionDraft)}
                >
                  Save caption
                </button>
                <button
                  className="mt-1.5 ml-1.5 px-3 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-xs disabled:opacity-50"
                  disabled={generatingCaptionsForProject === currentProject.id || generatingCaptionClipId !== null || !isOnline}
                  onClick={() => generateMissingCaptions(currentProject.id, selectedClip.kind)}
                  title={
                    !isOnline
                      ? OFFLINE_TITLE
                      : `Generate AI captions for every ${selectedClip.kind === "part" ? "part" : "clip"} that doesn't have one yet`
                  }
                >
                  {generatingCaptionsForProject === currentProject.id ? "Generating all…" : "✨ Generate all missing"}
                </button>
                <button
                  className="mt-1.5 ml-1.5 px-3 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-xs disabled:opacity-50"
                  disabled={refiningCaptionsForProject === currentProject.id || generatingCaptionClipId !== null || !isOnline}
                  onClick={() => refineCaptions(currentProject.id, selectedClip.kind)}
                  title={
                    !isOnline
                      ? OFFLINE_TITLE
                      : "Send every generated caption (with the transcript) to a review AI pass — rewrites ones that aren't chaotic/TikTok enough, are too long, too formal, not algorithm-friendly, or repeat another clip's caption"
                  }
                >
                  {refiningCaptionsForProject === currentProject.id ? "Reviewing all…" : "🔍 Refine all with AI"}
                </button>
                {selectedClip.kind === "part" && (
                  <div className="mt-3 pt-3 border-t border-neutral-800">
                    <h3 className="text-sm font-medium text-neutral-300 mb-1">Part label</h3>
                    <p className="text-[11px] text-neutral-600 mb-1.5">
                      Shared by every part using the current template ({"{part_number}"} becomes
                      1, 2, 3…). Edit the word, keep the token.
                    </p>
                    <input
                      className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-xs font-mono"
                      value={partCaptionDraft}
                      onChange={(e) => setPartCaptionDraft(e.target.value)}
                      placeholder="Part {part_number}"
                    />
                    <div className="flex items-center justify-between mt-1.5">
                      <button
                        className="px-3 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-xs disabled:opacity-50"
                        disabled={savingPartCaption || partCaptionDraft === (selectedTemplateConfig?.caption2.text ?? "")}
                        onClick={savePartCaptionTemplate}
                      >
                        {savingPartCaption ? "Saving…" : "Save"}
                      </button>
                      <span className="text-[11px] text-neutral-500">
                        Preview: {resolveCaptionText(partCaptionDraft, selectedClip.aiCaption, selectedPartNumber)}
                      </span>
                    </div>
                  </div>
                )}
                {selectedClip.hashtags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {selectedClip.hashtags.map((tag) => (
                      <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-neutral-800 text-blue-300">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-neutral-300">Render</h3>
                  <Link to="/templates/new" className="text-xs text-blue-400 hover:text-blue-300">
                    + New template
                  </Link>
                </div>
                <select
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-xs mb-2"
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                >
                  {templates.length === 0 && <option value="">No templates yet</option>}
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.id === settings[SETTING_DEFAULT_TEMPLATE_ID] ? " (default)" : ""}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <button
                    className="flex-1 px-2 py-1.5 rounded bg-neutral-700 hover:bg-neutral-600 text-xs disabled:opacity-50"
                    disabled={renderingClipIds.has(selectedClip.id)}
                    onClick={() => renderClipPreview(selectedClip.id)}
                  >
                    {renderingClipIds.has(selectedClip.id) ? "…" : "Preview"}
                  </button>
                  <button
                    className="flex-1 px-2 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-xs disabled:opacity-50"
                    disabled={renderingClipIds.has(selectedClip.id) || !selectedTemplateId}
                    onClick={() => selectedTemplateId && renderClipFinal(selectedClip.id, selectedTemplateId)}
                  >
                    {renderingClipIds.has(selectedClip.id) ? "…" : "Final (template)"}
                  </button>
                </div>
              </div>

              <div className="pt-1 border-t border-neutral-800">
                <div className="flex items-center justify-between mb-1 pt-3">
                  <h3 className="text-sm font-medium text-neutral-300">Trending hashtags</h3>
                  <button
                    className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 disabled:text-neutral-500"
                    disabled={fetchingTrendingHashtags || !isOnline}
                    onClick={() => fetchTrendingHashtags(currentProject.id)}
                    title={
                      !isOnline
                        ? OFFLINE_TITLE
                        : "Ask the AI what's trending right now (excluding evergreen tags like #fyp) — saved for this project and added to every clip's TikTok title"
                    }
                  >
                    {fetchingTrendingHashtags ? (
                      "Checking…"
                    ) : (
                      <>
                        <RefreshCw size={12} /> {trendingHashtags.length > 0 ? "Refresh" : "Find trending"}
                      </>
                    )}
                  </button>
                </div>
                <p className="text-[11px] text-neutral-600 mb-1.5">
                  Added to every clip's TikTok title alongside its own hashtags, on top of #fyp-style tags.
                </p>
                {trendingHashtags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {trendingHashtags.map((tag) => (
                      <span key={tag} className="px-1.5 py-0.5 rounded bg-neutral-800 text-[11px] text-neutral-300">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="pt-1 border-t border-neutral-800">
                <h3 className="text-sm font-medium text-neutral-300 mb-2 pt-3">Upload</h3>
                <p className="text-xs text-neutral-500 mb-2">Target account(s)</p>
                {accounts.length === 0 ? (
                  <p className="text-xs text-neutral-500 mb-2">No accounts added</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {accounts.map((a) => (
                      <label
                        key={a.id}
                        className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border cursor-pointer ${
                          selectedAccountIds.has(a.id)
                            ? "border-blue-500 bg-blue-500/10"
                            : "border-neutral-700 hover:border-neutral-600"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="accent-blue-500"
                          checked={selectedAccountIds.has(a.id)}
                          onChange={() => toggleTargetAccount(a.id)}
                        />
                        {a.accountName}
                        <span className="text-neutral-500">({PLATFORM_LABELS[a.platform] ?? a.platform})</span>
                      </label>
                    ))}
                  </div>
                )}
                <button
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-xs disabled:opacity-50 disabled:cursor-not-allowed mb-2"
                  disabled={accounts.length === 0 || selectedAccountIds.size === 0 || queueing}
                  onClick={async () => {
                    if (selectedAccountIds.size === 0) return;
                    setQueueing(true);
                    try {
                      // Apply the selected template now, at queue time, instead of while
                      // just browsing the clip. Always re-renders (no "already rendered
                      // with this template id" shortcut) since the template's own config
                      // can change without its id changing.
                      if (selectedTemplateId) {
                        await renderClipFinal(selectedClip.id, selectedTemplateId);
                      }
                      await addToQueue(selectedClip.id, [...selectedAccountIds]);
                      setQueuedClipId(selectedClip.id);
                    } finally {
                      setQueueing(false);
                    }
                  }}
                >
                  <ListPlus size={12} />{" "}
                  {queueing
                    ? "Adding…"
                    : `Add to Queue${selectedAccountIds.size > 1 ? ` (${selectedAccountIds.size} accounts)` : ""}`}
                </button>
                {queuedClipId === selectedClip.id ? (
                  <p className="text-[11px] text-green-400">
                    Added to queue — <Link to="/queue" className="underline hover:text-green-300">view queue →</Link>
                  </p>
                ) : (
                  <p className="text-[11px] text-neutral-600">
                    {accounts.length === 0
                      ? "Add an account on the Accounts page to select an upload target."
                      : "Adds this clip to the upload queue for the selected account."}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bottom: timeline */}
      <div className="h-[108px] flex-shrink-0 bg-[#161618] border-t border-black/40 px-4 py-3 flex items-center gap-3">
        <div className="flex-shrink-0 flex flex-col gap-1">
          {(["clips", "movie"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setDisplayMode(mode)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                displayMode === mode
                  ? "bg-blue-600/15 text-blue-400"
                  : "text-neutral-400 hover:text-neutral-200 hover:bg-white/5"
              }`}
            >
              {ANALYZE_MODE_LABELS[mode]}
            </button>
          ))}
        </div>

        <div className="w-px h-full bg-black/40 flex-shrink-0" />

        <div className="flex-1 min-w-0 h-full flex items-center gap-2 overflow-x-auto">
          {displayedItems.length === 0 ? (
            analyzing ? (
              <div className="flex items-center gap-3">
                <p className="text-xs text-neutral-500 animate-pulse">
                  Analyzing {ANALYZE_MODE_LABELS[displayMode]}…{" "}
                  {Math.round((activeAnalysisProgress?.progress ?? 0) * 100)}% ({stageLabel(activeAnalysisProgress?.stage ?? "")})
                </p>
                <button
                  className="px-3 py-1 rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 text-xs font-medium"
                  onClick={() => id && cancelAnalysis(id, displayMode)}
                >
                  Stop
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <button
                  className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium disabled:opacity-50"
                  disabled={!currentProject.transcriptPath || !isOnline}
                  title={!isOnline ? OFFLINE_TITLE : undefined}
                  onClick={() => id && (displayMode === "clips" ? analyzeClips(id) : analyzeMovie(id))}
                >
                  Analyze {ANALYZE_MODE_LABELS[displayMode]}
                </button>
                {activeStatus === "error" && (
                  <span className="text-xs text-red-400">Last analysis failed — try again.</span>
                )}
                {!currentProject.transcriptPath && (
                  <span className="text-xs text-neutral-600">No transcript on this project.</span>
                )}
                {!isOnline && (
                  <span className="text-xs text-amber-400">Offline — analysis needs the AI Engine.</span>
                )}
              </div>
            )
          ) : (
            displayedItems.map((c, i) => (
              <TimelineClip
                key={c.id}
                clip={c}
                moviePath={currentProject.moviePath}
                selected={c.id === selectedClipId}
                onSelect={() => setSelectedClipId(c.id)}
                label={c.kind === "part" ? `Part ${i + 1}` : undefined}
              />
            ))
          )}
        </div>
      </div>

      {showNewProjectDialog && (
        <NewProjectDialog
          onClose={() => setShowNewProjectDialog(false)}
          onCreated={(newId) => navigate(`/projects/${newId}`)}
        />
      )}

      {showAutoUpload && (
        <AutoUploadDialog
          clips={clips}
          accounts={accounts}
          queueItems={queueItems.filter((item) => clips.some((c) => c.id === item.clipId))}
          selectedTemplateId={selectedTemplateId}
          renderClipFinal={renderClipFinal}
          onClose={() => {
            setShowAutoUpload(false);
            fetchQueue();
          }}
        />
      )}

      {showQueueViewer && (
        <QueueViewerDialog
          items={queueItems.filter((item) => clips.some((c) => c.id === item.clipId))}
          onClose={() => setShowQueueViewer(false)}
        />
      )}

      {showActivityLog && <ActivityLogPanel entries={projectActivityLog} onClose={() => setShowActivityLog(false)} />}

      {showAutoUploadSettings && <AutoUploadSettingsDialog onClose={() => setShowAutoUploadSettings(false)} />}

      {showAutoUploadConfirm && autoUploadSettings && (
        <AutoUploadConfirmDialog
          project={currentProject}
          mode={autoUploadSettings.mode}
          templateName={templates.find((t) => t.id === autoUploadSettings.templateId)?.name ?? "(unknown template)"}
          accountNames={
            accounts
              .filter((a) => autoUploadSettings.accountIds.includes(a.id))
              .map((a) => `${a.accountName} (${PLATFORM_LABELS[a.platform] ?? a.platform})`)
          }
          running={autoUploadRunning}
          isOnline={isOnline}
          onConfirm={async () => {
            setAutoUploadError(null);
            try {
              await runAutoUpload(currentProject.id);
              setShowAutoUploadConfirm(false);
            } catch (e) {
              setAutoUploadError(String(e));
              setShowAutoUploadConfirm(false);
            }
          }}
          onClose={() => setShowAutoUploadConfirm(false)}
        />
      )}
    </div>
  );
}
