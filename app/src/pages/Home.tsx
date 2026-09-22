import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useProjectStore } from "../stores/projectStore";
import NewProjectDialog from "../components/NewProjectDialog";

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
