import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Pause, Play, X, Trash2, Film } from "lucide-react";
import { useDownloadsStore, DownloadRecord } from "../stores/downloadsStore";

const STATUS_LABELS: Record<DownloadRecord["status"], string> = {
  downloading: "Downloading",
  paused: "Paused",
  captions: "Fetching captions",
  creating_project: "Creating project",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const CANCELLABLE: DownloadRecord["status"][] = ["downloading", "paused", "captions", "creating_project"];
const REMOVABLE: DownloadRecord["status"][] = ["completed", "failed", "cancelled"];

export default function DownloadsPanel({ onClose }: { onClose: () => void }) {
  const { downloads, fetchDownloads, pauseDownload, resumeDownload, cancelDownload, removeDownload } =
    useDownloadsStore();
  const navigate = useNavigate();

  useEffect(() => {
    fetchDownloads();
  }, [fetchDownloads]);

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        className="absolute top-2 left-[84px] w-[380px] max-h-[70vh] overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-neutral-800 flex items-center justify-between sticky top-0 bg-neutral-900">
          <h2 className="text-sm font-medium">Downloads</h2>
          <button className="text-neutral-500 hover:text-neutral-300" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {downloads.length === 0 ? (
          <p className="text-sm text-neutral-500 p-4">No downloads yet.</p>
        ) : (
          <div className="divide-y divide-neutral-800">
            {downloads.map((d) => (
              <div key={d.videoId} className="px-4 py-3 flex gap-3">
                <div className="w-16 aspect-video shrink-0 rounded overflow-hidden bg-neutral-800 flex items-center justify-center">
                  {d.thumbnailUrl ? (
                    <img src={d.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Film size={14} className="text-neutral-600" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate" title={d.title}>
                    {d.title || d.videoId}
                  </p>
                  <p className="text-[11px] text-neutral-500 mt-0.5">
                    {STATUS_LABELS[d.status]}
                    {d.status === "downloading" && d.percent != null && ` · ${d.percent.toFixed(0)}%`}
                  </p>

                  {(d.status === "downloading" || d.status === "paused") && (
                    <div className="h-1 rounded-full bg-neutral-800 overflow-hidden mt-1.5">
                      <div
                        className={`h-full rounded-full transition-[width] ${
                          d.status === "paused" ? "bg-neutral-600" : "bg-blue-500"
                        }`}
                        style={{ width: `${Math.min(100, Math.max(0, d.percent ?? 0))}%` }}
                      />
                    </div>
                  )}

                  {d.status === "failed" && d.error && (
                    <p className="text-[11px] text-red-400 mt-1 line-clamp-2">{d.error}</p>
                  )}

                  <div className="flex items-center gap-3 mt-1.5">
                    {d.status === "downloading" && (
                      <button
                        className="text-[11px] text-neutral-400 hover:text-neutral-200 flex items-center gap-1"
                        onClick={() => pauseDownload(d.videoId)}
                      >
                        <Pause size={11} /> Pause
                      </button>
                    )}
                    {(d.status === "paused" || d.status === "failed") && (
                      <button
                        className="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1"
                        onClick={() => resumeDownload(d.videoId)}
                      >
                        <Play size={11} /> Resume
                      </button>
                    )}
                    {CANCELLABLE.includes(d.status) && (
                      <button
                        className="text-[11px] text-red-400 hover:text-red-300 flex items-center gap-1"
                        onClick={() => cancelDownload(d.videoId)}
                      >
                        <X size={11} /> Cancel
                      </button>
                    )}
                    {d.status === "completed" && d.projectId && (
                      <button
                        className="text-[11px] text-blue-400 hover:text-blue-300"
                        onClick={() => {
                          navigate(`/projects/${d.projectId}`);
                          onClose();
                        }}
                      >
                        Open project
                      </button>
                    )}
                    {REMOVABLE.includes(d.status) && (
                      <button
                        className="text-[11px] text-neutral-500 hover:text-neutral-300 flex items-center gap-1 ml-auto"
                        onClick={() => removeDownload(d.videoId)}
                        title="Remove from list"
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
