import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Pause, Play, Trash2, RotateCcw, X } from "lucide-react";
import { useQueueStore, QueueItem } from "../stores/queueStore";
import { useAccountStore } from "../stores/accountStore";
import { useOnlineStore } from "../stores/onlineStore";

const PLATFORM_LABELS: Record<string, string> = { tiktok: "TikTok", youtube: "YouTube" };

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
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
    default:
      return "text-neutral-400";
  }
}

// Full-card video preview modal — replaces a separate "view queue" affordance: any card
// with a rendered clip opens straight into playback on click, no extra button to find.
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
              <span className={statusColor(item.status)}>{STATUS_LABELS[item.status] ?? item.status}</span>
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
        </div>
      </div>
    </div>
  );
}

function QueueRow({ item, onPreview }: { item: QueueItem; onPreview: (item: QueueItem) => void }) {
  const { retryItem, removeItem } = useQueueStore();
  const isOnline = useOnlineStore((s) => s.isOnline);
  const thumbPath = item.clipFinalOutputPath || item.clipOutputPath;

  return (
    <div
      className={`flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 ${
        thumbPath ? "cursor-pointer hover:border-neutral-700" : ""
      }`}
      onClick={() => thumbPath && onPreview(item)}
    >
      <div className="w-16 h-10 rounded bg-neutral-800 overflow-hidden flex-shrink-0 flex items-center justify-center">
        {thumbPath ? (
          <video src={convertFileSrc(thumbPath)} className="w-full h-full object-cover pointer-events-none" />
        ) : (
          <span className="text-[10px] text-neutral-600">No preview</span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className={statusColor(item.status)}>{STATUS_LABELS[item.status] ?? item.status}</span>
          <span className="text-neutral-500 text-xs">
            → {item.accountName} ({PLATFORM_LABELS[item.platform] ?? item.platform})
          </span>
        </div>
        {item.status === "uploading" && (
          <div className="w-full h-1.5 rounded-full bg-neutral-800 mt-1.5 overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all"
              style={{ width: `${item.progress}%` }}
            />
          </div>
        )}
        {item.errorMessage && (
          <p className="text-xs text-red-400 mt-1 truncate">{item.errorMessage}</p>
        )}
      </div>

      <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
        {item.status === "failed" && (
          <button
            className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 disabled:opacity-50"
            disabled={!isOnline}
            title={!isOnline ? "No internet connection" : "Retry"}
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
  const { items, isPaused, isLoading, initListeners, fetchQueue, pauseAll, resumeAll, clearCompleted } =
    useQueueStore();
  const { accounts, fetchAccounts } = useAccountStore();
  const isOnline = useOnlineStore((s) => s.isOnline);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("all");
  const [previewItem, setPreviewItem] = useState<QueueItem | null>(null);

  useEffect(() => {
    initListeners();
    fetchQueue();
    fetchAccounts();
  }, [initListeners, fetchQueue, fetchAccounts]);

  const filtered = selectedAccountId === "all" ? items : items.filter((i) => i.accountId === selectedAccountId);
  const hasCompleted = items.some((i) => i.status === "completed");

  return (
    <div className="p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">Upload Queue</h1>
          <div className="flex gap-2">
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
          </div>
        </div>

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
            <QueueRow key={item.id} item={item} onPreview={setPreviewItem} />
          ))}
        </div>
      </div>

      {previewItem && <QueuePreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />}
    </div>
  );
}
