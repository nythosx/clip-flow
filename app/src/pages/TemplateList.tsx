import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTemplateStore } from "../stores/templateStore";
import { useSettingsStore, SETTING_DEFAULT_TEMPLATE_ID } from "../stores/settingsStore";

export default function TemplateList() {
  const { templates, fetchTemplates, isLoading, deleteTemplate } = useTemplateStore();
  const { settings, fetchSettings, setSetting } = useSettingsStore();
  const navigate = useNavigate();

  useEffect(() => {
    fetchTemplates();
    fetchSettings();
  }, [fetchTemplates, fetchSettings]);

  const defaultTemplateId = settings[SETTING_DEFAULT_TEMPLATE_ID];

  return (
    <div className="p-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">Templates</h1>
          <button
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm"
            onClick={() => navigate("/templates/new")}
          >
            + New template
          </button>
        </div>

        {isLoading && <p className="text-neutral-400 text-sm">Loading…</p>}
        {!isLoading && templates.length === 0 && (
          <p className="text-neutral-400 text-sm">
            No templates yet. Create one to define crop, watermark, caption and encoding
            settings for final clip renders.
          </p>
        )}

        <div className="space-y-2">
          {templates.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 hover:border-neutral-600 transition-colors"
            >
              <Link to={`/templates/${t.id}`} className="flex-1">
                <span className="font-medium">{t.name}</span>
                <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-neutral-700">{t.platform}</span>
                {t.id === defaultTemplateId && (
                  <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-blue-600/30 text-blue-300">
                    Default
                  </span>
                )}
              </Link>
              <div className="flex items-center gap-3">
                {t.id !== defaultTemplateId && (
                  <button
                    className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1"
                    onClick={() => setSetting(SETTING_DEFAULT_TEMPLATE_ID, t.id)}
                  >
                    Set as default
                  </button>
                )}
                <button
                  className="text-xs text-red-400 hover:text-red-300 px-2 py-1"
                  onClick={() => deleteTemplate(t.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
