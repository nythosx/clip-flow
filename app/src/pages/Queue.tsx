import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Pause, Play, Trash2, RotateCcw, X, Download, Loader2, Copy, Check, Activity, ChevronDown, ChevronRight, SlidersHorizontal } from "lucide-react";
import { useQueueStore, QueueItem } from "../stores/queueStore";
import { useAccountStore } from "../stores/accountStore";
import { useOnlineStore } from "../stores/onlineStore";

const PLATFORM_LABELS: Record<string, string> = { tiktok: "TikTok", youtube: "YouTube" };

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  rendering: "Rendering…",
  uploading: "Uploading",
  completed: "Completed",
  failed: "Failed",
};

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "text-green-400";
    case "failed":
      return "text-red-400";
    case "uploading":
      return "text-blue-400";
    case "rendering":
      return "text-amber-400";
    default:
      return "text-neutral-400";
  }
}

function displayStatus(item: QueueItem): string {
  if (item.clipRendering && item.status !== "completed" && item.status !== "failed") {
    return "rendering";
  }
  return item.status;
}

function isRateLimited(item: QueueItem): boolean {
  const msg = (item.errorMessage ?? "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("rate-limit") ||
    msg.includes("rate limit") ||
    msg.includes("spam_risk") ||
    msg.includes("active_user_cap") ||
    msg.includes("kept rate-limiting")
  );
}

function formatTimestamp(value: string | null): string {
  if (!value) return "";
  const date = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function buildShareText(item: QueueItem): string {
  const tags = item.hashtags.length > 0 ? `\n\n${item.hashtags.join(" ")}` : "";
  return `${item.title}${tags}`;
}

interface AccountDiagnostics {
  accountId: string;
  accountName: string;
  platform: string;
  uploadsLast24h: number;
  maxUploadsPer24h: number;
  minIntervalSeconds: number;
  lastCompletedAt: string | null;
  secondsUntilNext: number | null;
  reason: string | null;
  activeUpload: boolean;
}

interface QueueDiagnostics {
  queuePaused: boolean;
  minIntervalSeconds: number;
  maxUploadsPer24h: number;
  accounts: AccountDiagnostics[];
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}m ${sec}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function QueueDiagnosticsCard({
  onToast,
}: {
  onToast: (type: "success" | "error", message: string) => void;
}) {
  const [diag, setDiag] = useState<QueueDiagnostics | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draftMin, setDraftMin] = useState(0);
  const [draftMax, setDraftMax] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const d = await invoke<QueueDiagnostics>("get_queue_diagnostics");
        if (active) setDiag(d);
      } catch {

      }
    };
    load();
    const t = setInterval(load, 3000);
    return () => { active = false; clearInterval(t); };
  }, []);

  function startEditing() {
    if (!diag) return;
    setDraftMin(diag.minIntervalSeconds);
    setDraftMax(diag.maxUploadsPer24h);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
  }

  async function save() {
    setSaving(true);
    try {
      await invoke("set_setting", { key: "queue_min_upload_interval_seconds", value: String(draftMin) });
      await invoke("set_setting", { key: "queue_max_uploads_per_24h", value: String(draftMax) });
      setEditing(false);
      onToast("success", "Queue pacing updated");
      try {
        const d = await invoke<QueueDiagnostics>("get_queue_diagnostics");
        setDiag(d);
      } catch {   }
    } catch (err) {
      onToast("error", String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!diag) return null;

  const anyBlocked = diag.accounts.some((a) => a.secondsUntilNext != null);
  const anyActive = diag.accounts.some((a) => a.activeUpload);

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 mb-4">
      <button
        className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-white/[0.02]"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown size={14} className="text-neutral-500" /> : <ChevronRight size={14} className="text-neutral-500" />}
        <Activity size={14} className={anyActive ? "text-blue-400" : anyBlocked ? "text-amber-400" : "text-neutral-500"} />
        <span className="text-xs font-medium text-neutral-300">Queue status</span>
        <span className="ml-auto flex items-center gap-2 text-[10px]">
          {diag.queuePaused && (
            <span className="px-1.5 py-0.5 rounded-full bg-amber-900/40 text-amber-300">Paused</span>
          )}
          {anyActive && (
            <span className="px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-300">Uploading</span>
          )}
          {anyBlocked && !anyActive && (
            <span className="px-1.5 py-0.5 rounded-full bg-amber-900/40 text-amber-300">Waiting on cooldown</span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-neutral-800 px-4 py-3 space-y-3">
          {editing ? (
            <div className="rounded-md border border-neutral-800 bg-neutral-950/40 p-3 space-y-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-neutral-400">Min gap between uploads (seconds)</label>
                  <input
                    type="number"
                    min={60}
                    step={60}
                    value={draftMin}
                    onChange={(e) => setDraftMin(Number(e.target.value))}
                    className="w-full mt-1 rounded-md bg-neutral-900 border border-neutral-800 px-2 py-1.5 text-xs font-mono"
                  />
                  <p className="text-[10px] text-neutral-600 mt-0.5">
                    = {Math.floor(draftMin / 60)}m {draftMin % 60}s
                  </p>
                </div>
                <div>
                  <label className="text-[10px] text-neutral-400">Max uploads per 24h</label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={draftMax}
                    onChange={(e) => setDraftMax(Number(e.target.value))}
                    className="w-full mt-1 rounded-md bg-neutral-900 border border-neutral-800 px-2 py-1.5 text-xs font-mono"
                  />
                  <p className="text-[10px] text-neutral-600 mt-0.5">
                    TikTok safe range: 10–15
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={save}
                  disabled={saving || draftMin < 60 || draftMax < 1}
                  className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-xs font-medium disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={cancelEditing}
                  disabled={saving}
                  className="px-3 py-1.5 rounded-md text-xs text-neutral-400 hover:text-neutral-200 hover:bg-white/5 disabled:opacity-50"
                >
                  Cancel
                </button>
                <div className="flex items-center gap-1.5 ml-auto">
                  <span className="text-[10px] text-neutral-600">Presets:</span>
                  <button
                    onClick={() => { setDraftMin(180); setDraftMax(10); }}
                    className="text-[10px] px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
                  >
                    Fast (3m)
                  </button>
                  <button
                    onClick={() => { setDraftMin(300); setDraftMax(12); }}
                    className="text-[10px] px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
                  >
                    Balanced (5m)
                  </button>
                  <button
                    onClick={() => { setDraftMin(900); setDraftMax(15); }}
                    className="text-[10px] px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
                  >
                    Safe (15m)
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-4 text-[10px] text-neutral-500">
              <span>Min gap: <span className="text-neutral-300 font-mono">{formatSeconds(diag.minIntervalSeconds)}</span></span>
              <span>Daily cap: <span className="text-neutral-300 font-mono">{diag.maxUploadsPer24h}/24h</span></span>
              <button
                onClick={startEditing}
                className="ml-auto flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
              >
                <SlidersHorizontal size={10} /> Adjust
              </button>
            </div>
          )}

          {diag.accounts.length === 0 ? (
            <p className="text-xs text-neutral-500">No accounts connected.</p>
          ) : (
            <div className="space-y-2">
              {diag.accounts.map((a) => (
                <div key={a.accountId} className="flex items-start gap-3 text-xs">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-neutral-200 truncate">{a.accountName}</span>
                      <span className="text-[10px] text-neutral-500 uppercase">{a.platform}</span>
                      {a.activeUpload && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">Uploading now</span>
                      )}
                    </div>
                    <p className="text-[10px] text-neutral-500 mt-0.5">
                      Uploads in last 24h: <span className="text-neutral-300 font-mono">{a.uploadsLast24h}/{a.maxUploadsPer24h}</span>
                      {a.lastCompletedAt && (
                        <> · Last: <span className="text-neutral-300 font-mono">{new Date(a.lastCompletedAt + "Z").toLocaleTimeString()}</span></>
                      )}
                    </p>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    {a.secondsUntilNext != null ? (
                      <>
                        <p className="text-amber-400 font-mono text-xs">+{formatSeconds(a.secondsUntilNext)}</p>
                        <p className="text-[10px] text-neutral-500 max-w-[200px] truncate" title={a.reason ?? ""}>{a.reason}</p>
                      </>
                    ) : (
                      <span className="text-emerald-400 text-[10px]">● Ready</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-neutral-600 pt-1 border-t border-neutral-800">
            Cooldown values can also be adjusted in Settings → Queue pacing.
          </p>
        </div>
      )}
    </div>
  );
}

function QueuePreviewModal({ item, onClose }: { item: QueueItem; onClose: () => void }) {
  const thumbPath = item.clipFinalOutputPath || item.clipOutputPath;
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-neutral-900 text-neutral-100 rounded-lg p-4 w-[640px] max-w-[90vw] border border-neutral-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm">
              <span className={statusColor(displayStatus(item))}>
                {STATUS_LABELS[displayStatus(item)] ?? item.status}
              </span>
              {item.kind === "part" && (
                <span className="text-neutral-400 text-xs flex-shrink-0">Part {item.partNumber}</span>
              )}
              <span className="text-neutral-500 text-xs truncate">
                → {item.accountName} ({PLATFORM_LABELS[item.platform] ?? item.platform})
              </span>
            </div>
          </div>
          <button className="p-1 rounded hover:bg-neutral-800 text-neutral-400 flex-shrink-0" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <video
          key={item.id}
          src={convertFileSrc(thumbPath ?? "")}
          controls
          autoPlay
          className="w-full max-h-[70vh] rounded bg-black"
        />
        <div className="mt-3">
          <p className="text-sm font-medium text-neutral-100 truncate">{item.title}</p>
          {item.hashtags.length > 0 && (
            <p className="text-xs text-blue-400 mt-1 break-words">{item.hashtags.join(" ")}</p>
          )}
          {(item.status === "completed" || item.status === "failed") && (
            <p className="text-xs text-neutral-500 mt-1">
              {item.status === "failed" ? "Failed" : "Completed"} at{" "}
              {formatTimestamp(item.finishedAt ?? item.createdAt)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function QueueRow({
  item,
  onPreview,
  selected,
  onToggleSelect,
  onToast,
}: {
  item: QueueItem;
  onPreview: (item: QueueItem) => void;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onToast: (type: "success" | "error", message: string) => void;
}) {
  const { retryItem, removeItem } = useQueueStore();
  const isOnline = useOnlineStore((s) => s.isOnline);
  const thumbPath = item.clipFinalOutputPath || item.clipOutputPath;
  const [downloading, setDownloading] = useState(false);
  const [copied, setCopied] = useState(false);

  const rateLimited = isRateLimited(item);
  const canDownload = Boolean(thumbPath) && rateLimited;
  const canCopy = rateLimited;
  const canRetry = item.status === "failed" || (rateLimited && item.status === "queued");

  async function copyShareText(e: React.MouseEvent) {
    e.stopPropagation();
    const text = buildShareText(item);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      onToast("success", "Caption + hashtags copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onToast("error", "Couldn't access clipboard — copy the text manually from the preview");
    }
  }

  async function handleDownload(e: React.MouseEvent) {
    e.stopPropagation();
    setDownloading(true);
    try {
      const savedPath = await invoke<string | null>("download_queue_video", { itemId: item.id });
      if (savedPath) {
        try {
          await navigator.clipboard.writeText(buildShareText(item));
          onToast("success", "Video saved + caption copied. Paste in TikTok when you upload.");
        } catch {
          onToast("success", "Video saved — copy the caption from the preview");
        }
      }
    } catch (err) {
      onToast("error", String(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div
      className={`flex items-center gap-3 rounded-lg border ${
        rateLimited ? "border-amber-700/50 bg-amber-950/15" : "border-neutral-800 bg-neutral-900"
      } px-3 py-2.5 ${thumbPath ? "cursor-pointer hover:border-neutral-700" : ""}`}
      onClick={() => thumbPath && onPreview(item)}
    >
      <input
        type="checkbox"
        className="accent-blue-500 flex-shrink-0"
        checked={selected}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggleSelect(item.id)}
      />
      <div className="w-16 h-10 rounded bg-neutral-800 overflow-hidden flex-shrink-0 flex items-center justify-center">
        {thumbPath ? (
          <video src={convertFileSrc(thumbPath)} className="w-full h-full object-cover pointer-events-none" />
        ) : (
          <span className="text-[10px] text-neutral-600">No preview</span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className={statusColor(displayStatus(item))}>
            {STATUS_LABELS[displayStatus(item)] ?? item.status}
          </span>
          {item.kind === "part" && (
            <span className="text-neutral-400 text-xs flex-shrink-0">Part {item.partNumber}</span>
          )}
          <span className="text-neutral-500 text-xs truncate">
            → {item.accountName} ({PLATFORM_LABELS[item.platform] ?? item.platform})
          </span>
          {rateLimited && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-900/40 text-amber-300 flex-shrink-0">
              Rate limited
            </span>
          )}
        </div>
        {displayStatus(item) === "rendering" && (
          <div className="w-full h-1.5 rounded-full bg-neutral-800 mt-1.5 overflow-hidden">
            <div className="h-full w-1/3 bg-amber-500 rounded-full animate-[queueIndeterminate_1.2s_ease-in-out_infinite]" />
          </div>
        )}
        {displayStatus(item) === "uploading" && (
          <div className="w-full h-1.5 rounded-full bg-neutral-800 mt-1.5 overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all"
              style={{ width: `${item.progress}%` }}
            />
          </div>
        )}
        {item.blockReason && item.status === "queued" && !item.errorMessage && (
          <p className="text-xs text-amber-300/90 mt-1 truncate" title={item.blockReason}>
            ⏳ {item.blockReason}
          </p>
        )}
        {item.errorMessage && (
          <p className="text-xs text-amber-400 mt-1 truncate">{item.errorMessage}</p>
        )}
        {rateLimited && (
          <div className="mt-1.5 rounded-md bg-neutral-950/40 border border-neutral-800 px-2 py-1.5">
            <p className="text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">Caption + hashtags</p>
            <p className="text-[11px] text-neutral-300 truncate">{item.title}</p>
            {item.hashtags.length > 0 && (
              <p className="text-[10px] text-blue-400 truncate mt-0.5">{item.hashtags.join(" ")}</p>
            )}
          </div>
        )}
        {(item.status === "completed" || item.status === "failed") && !rateLimited && (
          <p className="text-xs text-neutral-500 mt-1">
            {item.status === "failed" ? "Failed" : "Completed"} at{" "}
            {formatTimestamp(item.finishedAt ?? item.createdAt)}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
        {canCopy && (
          <button
            className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200"
            title="Copy caption + hashtags"
            onClick={copyShareText}
          >
            {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
          </button>
        )}
        {canDownload && (
          <button
            className="p-1.5 rounded hover:bg-neutral-800 text-amber-400 hover:text-amber-300 disabled:opacity-50"
            disabled={downloading}
            title="Download video + copy caption for manual upload"
            onClick={handleDownload}
          >
            {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          </button>
        )}
        {canRetry && (
          <button
            className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 disabled:opacity-50"
            disabled={!isOnline}
            title={!isOnline ? "No internet connection" : "Retry upload now"}
            onClick={() => retryItem(item.id)}
          >
            <RotateCcw size={14} />
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
}

export default function Queue() {
  const {
    items,
    isPaused,
    isLoading,
    initListeners,
    fetchQueue,
    pauseAll,
    resumeAll,
    clearCompleted,
    clearFailed,
    removeItems,
  } = useQueueStore();
  const { accounts, fetchAccounts } = useAccountStore();
  const isOnline = useOnlineStore((s) => s.isOnline);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("all");
  const [selectedStatus, setSelectedStatus] = useState<string>("all");
  const [previewItem, setPreviewItem] = useState<QueueItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    initListeners();
    fetchQueue();
    fetchAccounts();
  }, [initListeners, fetchQueue, fetchAccounts]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = items
    .filter((i) => selectedAccountId === "all" || i.accountId === selectedAccountId)
    .filter((i) => selectedStatus === "all" || displayStatus(i) === selectedStatus);
  const hasCompleted = items.some((i) => i.status === "completed");
  const hasFailed = items.some((i) => i.status === "failed");
  const rateLimitedCount = items.filter(isRateLimited).length;

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const allFilteredSelected = filtered.length > 0 && filtered.every((i) => selectedIds.has(i.id));
  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((i) => i.id)));
    }
  };

  const deleteSelected = async () => {
    await removeItems([...selectedIds]);
    setSelectedIds(new Set());
  };

  return (
    <div className="p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">Upload Queue</h1>
          <div className="flex gap-2">
            <select
              className="px-3 py-2 rounded bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-100"
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="rendering">Rendering</option>
              <option value="queued">Queued</option>
              <option value="uploading">Uploading</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>
            {isPaused ? (
              <button
                className="flex items-center gap-1.5 px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm"
                onClick={() => resumeAll()}
              >
                <Play size={14} /> Resume All
              </button>
            ) : (
              <button
                className="flex items-center gap-1.5 px-3 py-2 rounded bg-neutral-800 hover:bg-neutral-700 text-sm"
                onClick={() => pauseAll()}
              >
                <Pause size={14} /> Pause All
              </button>
            )}
            <button
              className="px-3 py-2 rounded bg-neutral-800 hover:bg-neutral-700 text-sm disabled:opacity-50"
              disabled={!hasCompleted}
              onClick={() => clearCompleted()}
            >
              Clear Completed
            </button>
            <button
              className="px-3 py-2 rounded bg-neutral-800 hover:bg-neutral-700 text-sm disabled:opacity-50"
              disabled={!hasFailed}
              onClick={() => clearFailed()}
            >
              Clear Failed
            </button>
          </div>
        </div>

        <QueueDiagnosticsCard onToast={(type, message) => setToast({ type, message })} />

        {rateLimitedCount > 0 && (
          <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 px-4 py-3 mb-4 flex items-start gap-3">
            <Download size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-amber-200 font-medium">
                {rateLimitedCount} item{rateLimitedCount === 1 ? "" : "s"} rate-limited by TikTok
              </p>
              <p className="text-xs text-amber-300/80 mt-0.5">
                TikTok's daily post limit (typically ~15 per account) has been reached. Use Download to save the video + copy the caption for manual upload, or Retry to try again — the queue will resume automatically once the limit resets.
              </p>
            </div>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="flex items-center gap-3 mb-3">
            <label className="flex items-center gap-1.5 text-xs text-neutral-400 cursor-pointer">
              <input
                type="checkbox"
                className="accent-blue-500"
                checked={allFilteredSelected}
                onChange={toggleSelectAll}
              />
              Select all
            </label>
            {selectedIds.size > 0 && (
              <>
                <span className="text-xs text-neutral-500">{selectedIds.size} selected</span>
                <button
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-red-900/60 hover:bg-red-800 text-xs text-red-200"
                  onClick={deleteSelected}
                >
                  <Trash2 size={12} /> Delete Selected
                </button>
              </>
            )}
          </div>
        )}

        {isPaused && (
          <p className="text-xs text-amber-400 mb-4">
            Queue paused — uploads in progress will finish, but no new ones will start.
          </p>
        )}

        {!isOnline && (
          <p className="text-xs text-amber-400 mb-4">
            No internet connection — uploads that fail because of it will retry automatically once you're back
            online. You can still add clips to the queue while offline.
          </p>
        )}

        {accounts.length > 0 && (
          <div className="flex gap-1 mb-4 border-b border-neutral-800">
            <button
              className={`px-3 py-1.5 text-xs rounded-t ${
                selectedAccountId === "all" ? "text-blue-400 border-b-2 border-blue-400" : "text-neutral-500"
              }`}
              onClick={() => setSelectedAccountId("all")}
            >
              All ({items.length})
            </button>
            {accounts.map((a) => (
              <button
                key={a.id}
                className={`px-3 py-1.5 text-xs rounded-t ${
                  selectedAccountId === a.id ? "text-blue-400 border-b-2 border-blue-400" : "text-neutral-500"
                }`}
                onClick={() => setSelectedAccountId(a.id)}
              >
                {a.accountName} ({items.filter((i) => i.accountId === a.id).length})
              </button>
            ))}
          </div>
        )}

        {isLoading && <p className="text-neutral-400 text-sm">Loading…</p>}
        {!isLoading && filtered.length === 0 && (
          <p className="text-neutral-400 text-sm">
            Nothing in the queue. Add a clip to the queue from a project's Upload panel.
          </p>
        )}

        <div className="space-y-2">
          {filtered.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              onPreview={setPreviewItem}
              selected={selectedIds.has(item.id)}
              onToggleSelect={toggleSelect}
              onToast={(type, message) => setToast({ type, message })}
            />
          ))}
        </div>
      </div>

      {previewItem && <QueuePreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />}

      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-50 rounded-lg border px-4 py-3 text-sm shadow-lg max-w-sm ${
            toast.type === "success"
              ? "bg-emerald-950 border-emerald-800 text-emerald-200"
              : "bg-red-950 border-red-800 text-red-200"
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}