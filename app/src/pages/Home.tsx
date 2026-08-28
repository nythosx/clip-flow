import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useProjectStore } from "../stores/projectStore";
import NewProjectDialog from "../components/NewProjectDialog";

// "/" has no view of its own — ProjectDetail's own left-side project switcher already lists
// every project, so a separate project-list page was pure duplication. This just forwards to
// whichever project is most recent (get_projects orders by created_at DESC), or offers to
// create the first one if there isn't one yet.
export default function Home() {
  const { projects, fetchProjects, isLoading } = useProjectStore();
  const [showDialog, setShowDialog] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  if (projects.length > 0) {
    return <Navigate to={`/projects/${projects[0].id}`} replace />;
  }

  if (isLoading) {
    return (
      <div className="p-8">
        <p className="text-neutral-400 text-sm">Loading…</p>
      </div>
    );
  }

  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center">
        <p className="text-neutral-400 text-sm mb-4">No projects yet. Create one to get started.</p>
        <button
          className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm"
          onClick={() => setShowDialog(true)}
        >
          + New project
        </button>
      </div>
      {showDialog && (
        <NewProjectDialog
          onClose={() => setShowDialog(false)}
          onCreated={(newId) => navigate(`/projects/${newId}`)}
        />
      )}
    </div>
  );
}
