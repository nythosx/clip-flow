import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { Search, Clock, Eye, Loader2, Pause, Play, X, Download, SlidersHorizontal } from "lucide-react";
import { useDownloadsStore } from "../stores/downloadsStore";
import { useOnlineStore } from "../stores/onlineStore";

interface VideoSearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
  description: string;
  thumbnailUrl: string;
  publishedAt: string;
  durationSeconds: number;
  viewCount: string | null;
}

type SortOrder = "relevance" | "date" | "viewCount" | "rating";
type DurationFilter = "any" | "short" | "medium" | "long";
type UploadDateFilter = "any" | "hour" | "today" | "week" | "month" | "year";

const SORT_OPTIONS: { value: SortOrder; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "date", label: "Upload date (newest)" },
  { value: "viewCount", label: "View count" },
  { value: "rating", label: "Rating" },
];

const DURATION_OPTIONS: { value: DurationFilter; label: string }[] = [
  { value: "any", label: "Any duration" },
  { value: "short", label: "Under 4 minutes" },
  { value: "medium", label: "4–20 minutes" },
  { value: "long", label: "Over 20 minutes" },
];

const UPLOAD_DATE_OPTIONS: { value: UploadDateFilter; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "hour", label: "Last hour" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "year", label: "This year" },
];

function publishedAfterFor(filter: UploadDateFilter): string | undefined {
  if (filter === "any") return undefined;
  const now = new Date();
  const msAgo: Record<Exclude<UploadDateFilter, "any">, number> = {
    hour: 60 * 60 * 1000,
    today: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
  };
  return new Date(now.getTime() - msAgo[filter]).toISOString();
}

function formatPublishedAt(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1) return "Today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months > 1 ? "s" : ""} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years > 1 ? "s" : ""} ago`;
}

interface VideoDetails {
  videoId: string;
  title: string;
  channelTitle: string;
  description: string;
  thumbnailUrl: string;
  durationSeconds: number;
  viewCount: string | null;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function formatViews(n: string | null): string | null {
  if (!n) return null;
  const num = Number(n);
  if (Number.isNaN(num)) return n;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M views`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}K views`;
  return `${num} views`;
}

const STAGE_LABELS: Record<string, string> = {
  details: "Fetching video details…",
  downloading: "Downloading video…",
  paused: "Paused",
  captions: "Fetching captions…",
  creating_project: "Creating project…",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export default function YouTubeImport() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VideoSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const [showFilters, setShowFilters] = useState(false);
  const [sortOrder, setSortOrder] = useState<SortOrder>("relevance");
  const [durationFilter, setDurationFilter] = useState<DurationFilter>("any");
  const [uploadDateFilter, setUploadDateFilter] = useState<UploadDateFilter>("any");
  const filtersActive = sortOrder !== "relevance" || durationFilter !== "any" || uploadDateFilter !== "any";

  const [selected, setSelected] = useState<VideoSearchResult | null>(null);
  const [details, setDetails] = useState<VideoDetails | null>(null);
  const [captions, setCaptions] = useState<string | null | undefined>(undefined); // undefined = not fetched yet
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Downloads happen in the shared tray (Layout's Downloads button), not this page — this
  // just looks up the selected video's own entry (if any) to show inline progress/controls
  // without duplicating the download logic.
  const { downloads, initListeners, fetchDownloads, startDownload, pauseDownload, resumeDownload, cancelDownload } =
    useDownloadsStore();
  const activeDownload = selected ? downloads.find((d) => d.videoId === selected.videoId) : undefined;
  const isOnline = useOnlineStore((s) => s.isOnline);

  useEffect(() => {
    initListeners();
    fetchDownloads();
  }, [initListeners, fetchDownloads]);

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const items = await invoke<VideoSearchResult[]>("youtube_search", {
        query,
        order: sortOrder,
        videoDuration: durationFilter,
        publishedAfter: publishedAfterFor(uploadDateFilter),
      });
      setResults(items);
      setHasSearched(true);
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setSearching(false);
    }
  }

  // YouTube's own filters apply immediately on change, not just on the next Search click —
  // matched here, but only once a search has actually run so changing filters before typing
  // anything doesn't silently fire a request.
  useEffect(() => {
    if (hasSearched && query.trim()) {
      runSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortOrder, durationFilter, uploadDateFilter]);

  async function selectVideo(video: VideoSearchResult) {
    setSelected(video);
    setDetails(null);
    setCaptions(undefined);
    setDetailError(null);
    setLoadingDetail(true);
    try {
      const [d, c] = await Promise.all([
        invoke<VideoDetails>("youtube_video_details", { videoId: video.videoId }),
        invoke<string | null>("youtube_fetch_captions", { videoId: video.videoId }),
      ]);
      setDetails(d);
      setCaptions(c);
    } catch (e) {
      setDetailError(String(e));
    } finally {
      setLoadingDetail(false);
    }
  }

  async function importVideo() {
    if (!selected) return;
    await startDownload(selected.videoId, selected.title, selected.thumbnailUrl);
  }

  // Rough caption excerpt for the preview panel — the SRT text is imported verbatim as the
  // project's transcript file, this is just so the user can sanity-check a video actually
  // has usable captions before spending time downloading it.
  const captionPreview = captions
    ? captions
        .split("\n\n")
        .slice(0, 6)
        .map((block) => block.split("\n").slice(2).join(" "))
        .join(" ")
        .slice(0, 400)
    : null;

  return (
    <div className="p-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-semibold mb-1">Import from YouTube</h1>
        <p className="text-xs text-neutral-500 mb-6">
          Search public YouTube videos, preview captions, and import one as a project — cut
          into clips or full-video parts the same way as a locally-picked movie file.
        </p>

        <form onSubmit={runSearch} className="flex gap-2 mb-3">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              className="w-full rounded bg-neutral-800 border border-neutral-700 pl-9 pr-3 py-2 text-sm"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search YouTube…"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded border text-sm ${
              showFilters || filtersActive
                ? "border-blue-500 text-blue-400 bg-blue-500/10"
                : "border-neutral-700 text-neutral-400 hover:text-neutral-200"
            }`}
            title="Filters"
          >
            <SlidersHorizontal size={14} />
            Filters
            {filtersActive && <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />}
          </button>
          <button
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm disabled:opacity-50"
            disabled={searching || !query.trim() || !isOnline}
            title={!isOnline ? "No internet connection" : undefined}
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </form>
        {!isOnline && (
          <p className="text-xs text-amber-400 -mt-2 mb-4">No internet connection — search and import need it.</p>
        )}

        {showFilters && (
          <div className="flex flex-wrap gap-2 mb-4 text-xs">
            <select
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5"
              value={uploadDateFilter}
              onChange={(e) => setUploadDateFilter(e.target.value as UploadDateFilter)}
            >
              {UPLOAD_DATE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5"
              value={durationFilter}
              onChange={(e) => setDurationFilter(e.target.value as DurationFilter)}
            >
              {DURATION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value as SortOrder)}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  Sort: {o.label}
                </option>
              ))}
            </select>
            {filtersActive && (
              <button
                className="text-neutral-500 hover:text-neutral-300 px-2 py-1.5"
                onClick={() => {
                  setSortOrder("relevance");
                  setDurationFilter("any");
                  setUploadDateFilter("any");
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        {searchError && (
          <p className="text-sm text-red-400 mb-4">
            {searchError}
            {searchError.includes("Settings") && (
              <>
                {" "}
                — set it under <span className="underline">Settings → YouTube app</span>.
              </>
            )}
          </p>
        )}

        <div className="flex gap-6">
          <div className="flex-1 min-w-0 grid grid-cols-2 gap-3 content-start">
            {results.map((v) => (
              <button
                key={v.videoId}
                onClick={() => selectVideo(v)}
                className={`text-left rounded-lg overflow-hidden border transition-colors ${
                  selected?.videoId === v.videoId
                    ? "border-blue-500 bg-blue-500/5"
                    : "border-neutral-800 bg-neutral-900 hover:border-neutral-700"
                }`}
              >
                <div className="aspect-video bg-neutral-800 relative">
                  {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" className="w-full h-full object-cover" />}
                  {v.durationSeconds > 0 && (
                    <span className="absolute bottom-1 right-1 bg-black/80 text-white text-[10px] font-medium px-1.5 py-0.5 rounded">
                      {formatDuration(v.durationSeconds)}
                    </span>
                  )}
                </div>
                <div className="p-2.5">
                  <p className="text-xs font-medium line-clamp-2">{v.title}</p>
                  <p className="text-[11px] text-neutral-500 mt-1">{v.channelTitle}</p>
                  <p className="text-[11px] text-neutral-600 mt-0.5">
                    {formatViews(v.viewCount) ?? "— views"} · {formatPublishedAt(v.publishedAt)}
                  </p>
                </div>
              </button>
            ))}
            {!searching && results.length === 0 && (
              <p className="text-sm text-neutral-500 col-span-2">
                {query ? "No results yet — try Search." : "Search for a video to get started."}
              </p>
            )}
          </div>

          {selected && (
            <div className="w-[400px] shrink-0 rounded-lg border border-neutral-800 bg-neutral-900 p-4 h-fit sticky top-4 space-y-3">
              {/* Real player (not just the thumbnail) so you can actually watch it and
                  decide it's worth downloading before spending the time/bandwidth. */}
              <div className="aspect-video rounded overflow-hidden bg-black">
                <iframe
                  key={selected.videoId}
                  src={`https://www.youtube.com/embed/${selected.videoId}`}
                  title={selected.title}
                  className="w-full h-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
              <h2 className="text-sm font-medium leading-snug">{selected.title}</h2>
              <p className="text-xs text-neutral-500">{selected.channelTitle}</p>

              {loadingDetail ? (
                <p className="text-xs text-neutral-500 flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> Loading details…
                </p>
              ) : (
                details && (
                  <div className="flex items-center gap-3 text-xs text-neutral-400">
                    <span className="flex items-center gap-1">
                      <Clock size={12} /> {formatDuration(details.durationSeconds)}
                    </span>
                    {formatViews(details.viewCount) && (
                      <span className="flex items-center gap-1">
                        <Eye size={12} /> {formatViews(details.viewCount)}
                      </span>
                    )}
                  </div>
                )
              )}

              <div className="text-xs">
                <p className="text-neutral-400 mb-1">Captions</p>
                {captions === undefined ? (
                  <p className="text-neutral-600">—</p>
                ) : captions === null ? (
                  <p className="text-yellow-500/80">
                    No captions found for this video — you can still import it and add a
                    transcript manually.
                  </p>
                ) : (
                  <p className="text-neutral-500 line-clamp-4">{captionPreview}…</p>
                )}
              </div>

              {detailError && <p className="text-xs text-red-400">{detailError}</p>}

              {activeDownload && ["downloading", "paused", "captions", "creating_project"].includes(activeDownload.status) ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-neutral-400">
                    <span>{STAGE_LABELS[activeDownload.status]}</span>
                    {activeDownload.status === "downloading" && activeDownload.percent != null && (
                      <span className="font-mono">{activeDownload.percent.toFixed(0)}%</span>
                    )}
                  </div>
                  {activeDownload.status === "downloading" && activeDownload.percent != null ? (
                    <div className="h-1.5 rounded-full bg-neutral-800 overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-[width]"
                        style={{ width: `${Math.min(100, Math.max(0, activeDownload.percent))}%` }}
                      />
                    </div>
                  ) : (
                    <div className="h-1.5 rounded-full bg-neutral-800 overflow-hidden">
                      <div className="h-full w-1/3 bg-blue-500/70 animate-pulse rounded-full" />
                    </div>
                  )}
                  <div className="flex gap-2">
                    {activeDownload.status === "downloading" && (
                      <button
                        className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded bg-neutral-800 hover:bg-neutral-700 text-sm"
                        onClick={() => pauseDownload(activeDownload.videoId)}
                      >
                        <Pause size={14} /> Pause
                      </button>
                    )}
                    {activeDownload.status === "paused" && (
                      <button
                        className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm disabled:opacity-50"
                        disabled={!isOnline}
                        title={!isOnline ? "No internet connection" : undefined}
                        onClick={() => resumeDownload(activeDownload.videoId)}
                      >
                        <Play size={14} /> Resume
                      </button>
                    )}
                    <button
                      className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded bg-neutral-800 hover:bg-neutral-700 text-sm"
                      onClick={() => cancelDownload(activeDownload.videoId)}
                    >
                      <X size={14} /> Cancel
                    </button>
                  </div>
                  <p className="text-[11px] text-neutral-600 flex items-center gap-1">
                    <Download size={11} /> Also visible in the Downloads tray
                  </p>
                </div>
              ) : activeDownload?.status === "completed" ? (
                <button
                  className="w-full px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-sm"
                  onClick={() => activeDownload.projectId && navigate(`/projects/${activeDownload.projectId}`)}
                >
                  Imported — open project
                </button>
              ) : (
                <>
                  {activeDownload?.status === "failed" && activeDownload.error && (
                    <p className="text-xs text-red-400">{activeDownload.error}</p>
                  )}
                  <button
                    className="w-full px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm disabled:opacity-50"
                    disabled={loadingDetail || !isOnline}
                    title={!isOnline ? "No internet connection" : undefined}
                    onClick={importVideo}
                  >
                    {activeDownload?.status === "failed" ? "Retry import" : "Import as project"}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
