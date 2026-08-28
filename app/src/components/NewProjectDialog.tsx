import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../stores/projectStore";

export default function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [moviePath, setMoviePath] = useState("");
  const [transcriptPath, setTranscriptPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createProject = useProjectStore((s) => s.createProject);

  async function pickMovie() {
    const path = await invoke<string | null>("pick_file", {
      filterName: "Video",
      extensions: ["mp4", "mkv", "mov"],
    });
    if (path) setMoviePath(path);
  }

  async function pickTranscript() {
    const path = await invoke<string | null>("pick_file", {
      filterName: "Transcript",
      extensions: ["srt", "vtt", "txt"],
    });
    if (path) setTranscriptPath(path);
  }

  // Basename without extension, e.g. "C:\...\Thrash-1080P.mp4" -> "Thrash-1080P" — used when
  // the user leaves the name field blank instead of falling back to a generic "Untitled
  // project" for every clip.
  function nameFromPath(path: string): string {
    const base = path.split(/[\\/]/).pop() ?? path;
    return base.replace(/\.[^.]+$/, "");
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const id = await createProject(name.trim() || nameFromPath(moviePath) || "Untitled project", moviePath, transcriptPath);
      onClose();
      onCreated?.(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-neutral-900 text-neutral-100 rounded-lg p-6 w-[480px] space-y-4 border border-neutral-700">
        <h2 className="text-lg font-semibold">New project</h2>

        <div className="space-y-1">
          <label className="text-sm text-neutral-400">Name</label>
          <input
            className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Leave blank to use the movie file's name"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-neutral-400">Movie file</label>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm truncate"
              value={moviePath}
              readOnly
              placeholder="No file selected"
            />
            <button
              className="px-3 py-2 rounded bg-neutral-700 hover:bg-neutral-600 text-sm"
              onClick={pickMovie}
            >
              Browse
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-sm text-neutral-400">Transcript file (SRT / VTT / plain text)</label>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm truncate"
              value={transcriptPath}
              readOnly
              placeholder="No file selected"
            />
            <button
              className="px-3 py-2 rounded bg-neutral-700 hover:bg-neutral-600 text-sm"
              onClick={pickTranscript}
            >
              Browse
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button className="px-4 py-2 rounded text-sm hover:bg-neutral-800" onClick={onClose}>
            Cancel
          </button>
          <button
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm disabled:opacity-50"
            disabled={!moviePath || !transcriptPath || submitting}
            onClick={submit}
          >
            {submitting ? "Creating…" : "Create project"}
          </button>
        </div>
      </div>
    </div>
  );
}
