import { useEffect, useState } from "react";
import { useTemplateStore } from "../stores/templateStore";
import { useAccountStore } from "../stores/accountStore";
import { useAutoUploadStore, AutoUploadSettings } from "../stores/autoUploadStore";

const PLATFORM_LABELS: Record<string, string> = { tiktok: "TikTok", youtube: "YouTube", facebook: "Facebook" };

export default function AutoUploadSettingsDialog({ onClose }: { onClose: () => void }) {
  const { templates, fetchTemplates } = useTemplateStore();
  const { accounts, fetchAccounts } = useAccountStore();
  const { settings, saveSettings } = useAutoUploadStore();

  const [mode, setMode] = useState<AutoUploadSettings["mode"]>(settings?.mode ?? "clips");
  const [templateId, setTemplateId] = useState(settings?.templateId ?? "");
  const [accountIds, setAccountIds] = useState<Set<string>>(new Set(settings?.accountIds ?? []));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchTemplates();
    fetchAccounts();
  }, [fetchTemplates, fetchAccounts]);

  useEffect(() => {
    if (!templateId && templates.length > 0) setTemplateId(templates[0].id);
  }, [templates, templateId]);

  function toggleAccount(id: string) {
    setAccountIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      await saveSettings({ mode, templateId, accountIds: [...accountIds] });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-neutral-900 text-neutral-100 rounded-lg p-6 w-[480px] space-y-4 border border-neutral-700">
        <div>
          <h2 className="text-lg font-semibold">Auto upload defaults</h2>
          <p className="text-xs text-neutral-500 mt-1">
            Used every time you click Auto upload: slice the video (if not already), generate
            missing AI captions, render with this template, and queue every result to these
            accounts — all without asking again.
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-sm text-neutral-400">What to slice into</label>
          <select
            className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm"
            value={mode}
            onChange={(e) => setMode(e.target.value as AutoUploadSettings["mode"])}
          >
            <option value="clips">Best-highlight clips</option>
            <option value="movie">Sequential full-video parts</option>
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-sm text-neutral-400">Template</label>
          {templates.length === 0 ? (
            <p className="text-xs text-neutral-500">No templates yet — create one under Templates first.</p>
          ) : (
            <select
              className="w-full rounded bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-sm text-neutral-400">Accounts to upload to</label>
          {accounts.length === 0 ? (
            <p className="text-xs text-neutral-500">No accounts connected yet — add one under Accounts first.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {accounts.map((a) => (
                <label
                  key={a.id}
                  className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border cursor-pointer ${
                    accountIds.has(a.id) ? "border-blue-500 bg-blue-500/10" : "border-neutral-700 hover:border-neutral-600"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="accent-blue-500"
                    checked={accountIds.has(a.id)}
                    onChange={() => toggleAccount(a.id)}
                  />
                  {a.accountName}
                  <span className="text-neutral-500">({PLATFORM_LABELS[a.platform] ?? a.platform})</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button className="px-4 py-2 rounded text-sm hover:bg-neutral-800" onClick={onClose}>
            Cancel
          </button>
          <button
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-sm disabled:opacity-50"
            disabled={saving || !templateId || accountIds.size === 0}
            onClick={save}
          >
            {saving ? "Saving…" : "Save defaults"}
          </button>
        </div>
      </div>
    </div>
  );
}
