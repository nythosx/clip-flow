import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NavLink, Outlet } from "react-router-dom";
import { FolderKanban, LayoutTemplate, Users, ListChecks, Settings as SettingsIcon, Film, Clapperboard, Download, WifiOff, Loader2 } from "lucide-react";
import { useDownloadsStore } from "../stores/downloadsStore";
import { useOnlineStore } from "../stores/onlineStore";
import { useRenderQueueStore } from "../stores/renderQueueStore";
import DownloadsPanel from "./DownloadsPanel";

const NAV_ITEMS = [
  { to: "/", label: "Projects", icon: FolderKanban, end: true },
  { to: "/youtube", label: "YouTube", icon: Clapperboard, end: false },
  { to: "/templates", label: "Templates", icon: LayoutTemplate, end: false },
  { to: "/accounts", label: "Accounts", icon: Users, end: false },
  { to: "/queue", label: "Queue", icon: ListChecks, end: false },
  { to: "/settings", label: "Settings", icon: SettingsIcon, end: false },
];

const ACTIVE_STATUSES = new Set(["downloading", "paused", "captions", "creating_project"]);

export default function Layout() {
  const [showDownloads, setShowDownloads] = useState(false);
  const { downloads, initListeners, fetchDownloads } = useDownloadsStore();
  const activeCount = downloads.filter((d) => ACTIVE_STATUSES.has(d.status)).length;
  const isOnline = useOnlineStore((s) => s.isOnline);
  const initOnlineListeners = useOnlineStore((s) => s.initListeners);
  const renderQueueItems = useRenderQueueStore((s) => s.items);
  const initRenderQueueListeners = useRenderQueueStore((s) => s.initListeners);
  const fetchRenderQueue = useRenderQueueStore((s) => s.fetchQueue);

  useEffect(() => {
    initListeners();
    fetchDownloads();
    initOnlineListeners();
    initRenderQueueListeners();
    fetchRenderQueue();

    const timer = setTimeout(() => {
      invoke("close_splashscreen").catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [initListeners, fetchDownloads, initOnlineListeners, initRenderQueueListeners, fetchRenderQueue]);

  return (
    <div className="h-screen w-screen flex bg-[#0e0e10] text-neutral-100 overflow-hidden">
      <nav className="w-[76px] flex-shrink-0 bg-[#161618] border-r border-black/40 flex flex-col items-center py-4 gap-1">
        <div className="mb-4 flex flex-col items-center gap-1 text-blue-500">
          <Film size={26} strokeWidth={2} />
          <span className="text-[9px] font-semibold tracking-wide text-neutral-500">CLIPFLOW</span>
        </div>

        {!isOnline && (
          <div
            className="mb-2 flex flex-col items-center gap-0.5 text-amber-400"
            title="No internet connection — actions that need it are disabled until it's back. Queued uploads will retry automatically."
          >
            <WifiOff size={16} strokeWidth={1.75} />
            <span className="text-[8px] leading-none">Offline</span>
          </div>
        )}

        {renderQueueItems.length > 0 && (
          <div
            className="mb-2 flex flex-col items-center gap-0.5 text-blue-400"
            title={`${renderQueueItems.length} render${renderQueueItems.length === 1 ? "" : "s"} running in the background — safe to navigate away, they keep going and are processed one at a time.`}
          >
            <Loader2 size={16} strokeWidth={1.75} className="animate-spin" />
            <span className="text-[8px] leading-none">{renderQueueItems.length} render{renderQueueItems.length === 1 ? "" : "s"}</span>
          </div>
        )}

        { }
        <button
          onClick={() => setShowDownloads((v) => !v)}
          className={`relative w-[60px] flex flex-col items-center gap-1 py-2.5 rounded-lg transition-colors ${
            showDownloads ? "bg-blue-600/15 text-blue-400" : "text-neutral-400 hover:text-neutral-200 hover:bg-white/5"
          }`}
        >
          <Download size={20} strokeWidth={1.75} />
          <span className="text-[10px] leading-none">Downloads</span>
          {activeCount > 0 && (
            <span className="absolute top-1 right-2.5 w-4 h-4 rounded-full bg-blue-500 text-[9px] font-medium flex items-center justify-center text-white">
              {activeCount}
            </span>
          )}
        </button>

        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `w-[60px] flex flex-col items-center gap-1 py-2.5 rounded-lg transition-colors ${
                isActive
                  ? "bg-blue-600/15 text-blue-400"
                  : "text-neutral-400 hover:text-neutral-200 hover:bg-white/5"
              }`
            }
          >
            <Icon size={20} strokeWidth={1.75} />
            <span className="text-[10px] leading-none">{label}</span>
          </NavLink>
        ))}
      </nav>

      <main className="flex-1 min-w-0 overflow-y-auto">
        <Outlet />
      </main>

      {showDownloads && <DownloadsPanel onClose={() => setShowDownloads(false)} />}
    </div>
  );
}
