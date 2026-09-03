import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Stage, Layer, Image as KonvaImage, Text as KonvaText, Group, Rect } from "react-konva";
import Konva from "konva";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowLeft, Smartphone, Move, Image as ImageIcon, Type, Subtitles, SlidersHorizontal } from "lucide-react";
import { useTemplateStore, Platform, CaptionOverlayConfig, SubtitleOverlayConfig } from "../stores/templateStore";
import { useSettingsStore, SETTING_DEFAULT_ENCODING } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { useWatermarkStore } from "../stores/watermarkStore";
import { videoPreviewStyle } from "../lib/templatePreview";

const DISPLAY_WIDTH = 340;

type SectionId = "platform" | "transform" | "watermark" | "caption" | "subtitle" | "encoding";

const SECTIONS: { id: SectionId; label: string; icon: typeof Smartphone }[] = [
  { id: "platform", label: "Output", icon: Smartphone },
  { id: "transform", label: "Transform", icon: Move },
  { id: "watermark", label: "Watermark", icon: ImageIcon },
  { id: "caption", label: "Caption", icon: Type },
  { id: "subtitle", label: "Subtitles", icon: Subtitles },
  { id: "encoding", label: "Encoding", icon: SlidersHorizontal },
];

// Sample line shown only in the editor so the subtitle box has something to measure/drag —
// at render time each transcript cue's own text takes its place (see ffmpeg.rs's
// subtitle_drawtext_filters).
const SUBTITLE_PREVIEW_SAMPLE = "Synced lyric line appears here";

function formatDurationShort(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// The caption background box previously used a fixed single-line height (fontSize +
// padding*2), but KonvaText wraps to multiple lines once its content exceeds `width` — so
// a long caption's text spilled below the box instead of the box growing to fit it. Konva's
// own Text node already measures real wrapped-line height for these exact props, so reuse
// it here instead of re-deriving an estimate.
function measureCaptionBoxHeight(
  text: string,
  width: number,
  fontSize: number,
  fontStyle: string,
  padding: number
): number {
  if (width <= 0 || fontSize <= 0) return fontSize + padding * 2;
  const node = new Konva.Text({ text: text || " ", width, fontSize, fontStyle, padding, wrap: "word" });
  return node.height();
}

function useHtmlImage(src: string | null): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    const image = new window.Image();
    image.src = src;
    image.onload = () => setImg(image);
    return () => setImg(null);
  }, [src]);
  return img;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <label className="text-neutral-400">{label}</label>
      {children}
    </div>
  );
}

// Shared control set for a caption overlay — used twice (Caption 1 and the independent
// Caption 2), differing only in which config object they read/write and their textarea
// placeholder hint.
function CaptionFields({
  caption,
  onChange,
  placeholder,
}: {
  caption: CaptionOverlayConfig;
  onChange: (next: CaptionOverlayConfig) => void;
  placeholder: string;
}) {
  return (
    <>
      <Field label="Enabled">
        <input
          type="checkbox"
          checked={caption.enabled}
          onChange={(e) => onChange({ ...caption, enabled: e.target.checked })}
        />
      </Field>
      <textarea
        className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-xs"
        rows={2}
        value={caption.text}
        onChange={(e) => onChange({ ...caption, text: e.target.value })}
        placeholder={placeholder}
      />
      <Field label="Font size">
        <input
          type="number"
          className="w-16 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
          value={caption.fontSize}
          onChange={(e) => onChange({ ...caption, fontSize: Number(e.target.value) })}
        />
      </Field>
      <Field label="Font weight">
        <select
          className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
          value={caption.fontWeight}
          onChange={(e) => onChange({ ...caption, fontWeight: e.target.value as "normal" | "bold" })}
        >
          <option value="normal">Normal</option>
          <option value="bold">Bold</option>
        </select>
      </Field>
      <Field label="Font color">
        <input
          type="color"
          value={caption.fontColor}
          onChange={(e) => onChange({ ...caption, fontColor: e.target.value })}
        />
      </Field>
      <Field label="Background color">
        <input
          type="color"
          value={caption.backgroundColor}
          onChange={(e) => onChange({ ...caption, backgroundColor: e.target.value })}
        />
      </Field>
      <Field label="Background opacity">
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={caption.backgroundOpacity}
          onChange={(e) => onChange({ ...caption, backgroundOpacity: Number(e.target.value) })}
        />
      </Field>
      <Field label="Max width (px)">
        <input
          type="number"
          className="w-20 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
          value={caption.maxWidth}
          onChange={(e) => onChange({ ...caption, maxWidth: Number(e.target.value) })}
        />
      </Field>
      <Field label="Alignment">
        <select
          className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
          value={caption.alignment}
          onChange={(e) => onChange({ ...caption, alignment: e.target.value as "left" | "center" | "right" })}
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </Field>
    </>
  );
}

// Same field set as CaptionFields minus the text box — subtitle text comes from the
// project's transcript at render time (one cue at a time), not from anything typed here.
// Drag the box in the canvas above to position it; these controls only cover its styling.
function SubtitleFields({
  subtitle,
  onChange,
}: {
  subtitle: SubtitleOverlayConfig;
  onChange: (next: SubtitleOverlayConfig) => void;
}) {
  return (
    <>
      <Field label="Enabled">
        <input
          type="checkbox"
          checked={subtitle.enabled}
          onChange={(e) => onChange({ ...subtitle, enabled: e.target.checked })}
        />
      </Field>
      <p className="text-[11px] text-neutral-500 leading-snug">
        Text is pulled from the project's transcript as the clip plays — drag the box in the
        preview to position it, and use the fields below for styling.
      </p>
      <Field label="Font size">
        <input
          type="number"
          className="w-16 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
          value={subtitle.fontSize}
          onChange={(e) => onChange({ ...subtitle, fontSize: Number(e.target.value) })}
        />
      </Field>
      <Field label="Font weight">
        <select
          className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
          value={subtitle.fontWeight}
          onChange={(e) => onChange({ ...subtitle, fontWeight: e.target.value as "normal" | "bold" })}
        >
          <option value="normal">Normal</option>
          <option value="bold">Bold</option>
        </select>
      </Field>
      <Field label="Font color">
        <input
          type="color"
          value={subtitle.fontColor}
          onChange={(e) => onChange({ ...subtitle, fontColor: e.target.value })}
        />
      </Field>
      <Field label="Background color">
        <input
          type="color"
          value={subtitle.backgroundColor}
          onChange={(e) => onChange({ ...subtitle, backgroundColor: e.target.value })}
        />
      </Field>
      <Field label="Background opacity">
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={subtitle.backgroundOpacity}
          onChange={(e) => onChange({ ...subtitle, backgroundOpacity: Number(e.target.value) })}
        />
      </Field>
      <Field label="Max width (px)">
        <input
          type="number"
          className="w-20 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
          value={subtitle.maxWidth}
          onChange={(e) => onChange({ ...subtitle, maxWidth: Number(e.target.value) })}
        />
      </Field>
      <Field label="Alignment">
        <select
          className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
          value={subtitle.alignment}
          onChange={(e) => onChange({ ...subtitle, alignment: e.target.value as "left" | "center" | "right" })}
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </Field>
    </>
  );
}

export default function TemplateEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { canvasState, currentTemplate, updateCanvasState, loadTemplate, createNew, saveTemplate } =
    useTemplateStore();
  const { settings, fetchSettings } = useSettingsStore();
  const { projects, clips: previewClips, fetchProjects, fetchClips } = useProjectStore();
  const { watermarks, fetchWatermarks, uploadWatermark } = useWatermarkStore();
  const [name, setName] = useState("New template");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>("transform");
  const [previewProjectId, setPreviewProjectId] = useState("");
  const [previewClipId, setPreviewClipId] = useState("");
  const [uploadingWatermark, setUploadingWatermark] = useState(false);
  const [videoNaturalSize, setVideoNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const stageRef = useRef<Konva.Stage>(null);

  useEffect(() => {
    fetchSettings();
    fetchProjects();
    fetchWatermarks();
  }, [fetchSettings, fetchProjects, fetchWatermarks]);

  useEffect(() => {
    if (!previewProjectId && projects.length > 0) setPreviewProjectId(projects[0].id);
  }, [projects, previewProjectId]);

  useEffect(() => {
    if (!previewProjectId) return;
    setPreviewClipId("");
    fetchClips(previewProjectId);
  }, [previewProjectId, fetchClips]);

  useEffect(() => {
    if (previewClipId || previewClips.length === 0) return;
    const withVideo = previewClips.find((c) => c.outputPath || c.finalOutputPath) ?? previewClips[0];
    setPreviewClipId(withVideo.id);
  }, [previewClips, previewClipId]);

  const previewClip = previewClips.find((c) => c.id === previewClipId) ?? null;
  const previewSrc = previewClip?.outputPath
    ? convertFileSrc(previewClip.outputPath)
    : previewClip?.finalOutputPath
      ? convertFileSrc(previewClip.finalOutputPath)
      : null;

  useEffect(() => {
    if (!id || id === "new") {
      createNew("tiktok");
      setName("New template");
    } else {
      loadTemplate(id);
    }
  }, [id, createNew, loadTemplate]);

  useEffect(() => {
    if (id !== "new") return;
    const raw = settings[SETTING_DEFAULT_ENCODING];
    if (!raw) return;
    try {
      updateCanvasState({ encoding: JSON.parse(raw) });
    } catch {
      // ignore malformed stored default, keep the built-in fallback
    }
    // Only seed once when landing on a fresh "new" template, not on every settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, settings]);

  useEffect(() => {
    if (currentTemplate) setName(currentTemplate.name);
  }, [currentTemplate]);

  const displayScale = DISPLAY_WIDTH / canvasState.output.width;
  const stageWidth = DISPLAY_WIDTH;
  const stageHeight = canvasState.output.height * displayScale;

  const watermarkSrc = canvasState.watermark.imagePath
    ? convertFileSrc(canvasState.watermark.imagePath)
    : null;
  const watermarkImg = useHtmlImage(canvasState.watermark.enabled ? watermarkSrc : null);
  const watermarkDisplayWidth = watermarkImg ? DISPLAY_WIDTH * canvasState.watermark.scale : 0;
  const watermarkDisplayHeight = watermarkImg
    ? watermarkDisplayWidth * (watermarkImg.height / watermarkImg.width)
    : 0;

  async function pickWatermark() {
    const path = await invoke<string | null>("pick_file", {
      filterName: "Image",
      extensions: ["png", "jpg", "jpeg"],
    });
    if (!path) return;
    setUploadingWatermark(true);
    try {
      const fileName = path.split(/[\\/]/).pop() ?? "watermark";
      const watermark = await uploadWatermark(fileName, path);
      updateCanvasState({
        watermark: { ...canvasState.watermark, enabled: true, imagePath: watermark.filePath },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setUploadingWatermark(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const savedId = await saveTemplate(name);
      if (id === "new") navigate(`/templates/${savedId}`, { replace: true });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // Edge-relative placement (matches ffmpeg.rs's caption_drawtext_filter and
  // ProjectDetail.tsx's live CSS preview): position.{x,y} is where the box's own edge sits
  // between the canvas's edges, not a fraction of the full canvas — so a box can never be
  // dragged off-frame the way a full-width basis would allow once its own size is added on.
  const captionDisplayFontSize = canvasState.caption.fontSize * displayScale;
  const captionDisplayMaxWidth = canvasState.caption.maxWidth * displayScale;
  const captionDisplayPadding = canvasState.caption.padding * displayScale;
  const captionDisplayHeight = useMemo(
    () =>
      measureCaptionBoxHeight(
        canvasState.caption.text,
        captionDisplayMaxWidth,
        captionDisplayFontSize,
        canvasState.caption.fontWeight,
        captionDisplayPadding
      ),
    [canvasState.caption.text, captionDisplayMaxWidth, captionDisplayFontSize, canvasState.caption.fontWeight, captionDisplayPadding]
  );
  const captionX = canvasState.caption.position.x * Math.max(0, stageWidth - captionDisplayMaxWidth);
  const captionY = canvasState.caption.position.y * Math.max(0, stageHeight - captionDisplayHeight);

  const caption2DisplayFontSize = canvasState.caption2.fontSize * displayScale;
  const caption2DisplayMaxWidth = canvasState.caption2.maxWidth * displayScale;
  const caption2DisplayPadding = canvasState.caption2.padding * displayScale;
  const caption2DisplayHeight = useMemo(
    () =>
      measureCaptionBoxHeight(
        canvasState.caption2.text,
        caption2DisplayMaxWidth,
        caption2DisplayFontSize,
        canvasState.caption2.fontWeight,
        caption2DisplayPadding
      ),
    [canvasState.caption2.text, caption2DisplayMaxWidth, caption2DisplayFontSize, canvasState.caption2.fontWeight, caption2DisplayPadding]
  );
  const caption2X = canvasState.caption2.position.x * Math.max(0, stageWidth - caption2DisplayMaxWidth);
  const caption2Y = canvasState.caption2.position.y * Math.max(0, stageHeight - caption2DisplayHeight);

  const subtitleDisplayFontSize = canvasState.subtitle.fontSize * displayScale;
  const subtitleDisplayMaxWidth = canvasState.subtitle.maxWidth * displayScale;
  const subtitleDisplayPadding = canvasState.subtitle.padding * displayScale;
  const subtitleDisplayHeight = useMemo(
    () =>
      measureCaptionBoxHeight(
        SUBTITLE_PREVIEW_SAMPLE,
        subtitleDisplayMaxWidth,
        subtitleDisplayFontSize,
        canvasState.subtitle.fontWeight,
        subtitleDisplayPadding
      ),
    [subtitleDisplayMaxWidth, subtitleDisplayFontSize, canvasState.subtitle.fontWeight, subtitleDisplayPadding]
  );
  const subtitleX = canvasState.subtitle.position.x * Math.max(0, stageWidth - subtitleDisplayMaxWidth);
  const subtitleY = canvasState.subtitle.position.y * Math.max(0, stageHeight - subtitleDisplayHeight);

  return (
    <div className="h-screen flex flex-col">
      {/* Top toolbar */}
      <div className="h-14 flex-shrink-0 flex items-center justify-between px-4 border-b border-black/40 bg-[#161618]">
        <div className="flex items-center gap-3 min-w-0">
          <button
            className="text-neutral-400 hover:text-neutral-200 p-1"
            onClick={() => navigate("/templates")}
            title="Back to templates"
          >
            <ArrowLeft size={18} />
          </button>
          <input
            className="text-sm font-medium bg-neutral-800/60 border border-neutral-700 hover:border-neutral-600 focus:border-blue-500 outline-none rounded px-2 py-1 min-w-0"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Template name"
            title="Template name — click to rename"
          />
        </div>
        <div className="flex items-center gap-3">
          {error && <span className="text-xs text-red-400">{error}</span>}
          <button
            className="px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium disabled:opacity-50"
            disabled={saving}
            onClick={handleSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Left tool rail */}
        <div className="w-[72px] flex-shrink-0 bg-[#161618] border-r border-black/40 flex flex-col items-center py-3 gap-1">
          {SECTIONS.map(({ id: sectionId, label, icon: Icon }) => (
            <button
              key={sectionId}
              onClick={() => setActiveSection(sectionId)}
              className={`w-[58px] flex flex-col items-center gap-1 py-2.5 rounded-lg transition-colors ${
                activeSection === sectionId
                  ? "bg-blue-600/15 text-blue-400"
                  : "text-neutral-400 hover:text-neutral-200 hover:bg-white/5"
              }`}
            >
              <Icon size={18} strokeWidth={1.75} />
              <span className="text-[9px] leading-none">{label}</span>
            </button>
          ))}
        </div>

        {/* Center canvas workspace */}
        <div className="flex-1 min-w-0 flex flex-col items-center justify-center bg-[#0a0a0b] p-6">
          <div className="flex items-center gap-2 mb-3">
            <select
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs max-w-[160px]"
              value={previewProjectId}
              onChange={(e) => setPreviewProjectId(e.target.value)}
            >
              {projects.length === 0 && <option value="">No projects yet</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs max-w-[160px]"
              value={previewClipId}
              onChange={(e) => setPreviewClipId(e.target.value)}
              disabled={previewClips.length === 0}
            >
              {previewClips.length === 0 && <option value="">No clips</option>}
              {previewClips.map((c) => (
                <option key={c.id} value={c.id}>
                  {formatDurationShort(c.startSeconds)}–{formatDurationShort(c.endSeconds)}
                </option>
              ))}
            </select>
          </div>

          <div className="relative shadow-2xl overflow-hidden" style={{ width: stageWidth, height: stageHeight }}>
            {previewSrc ? (
              <video
                key={previewSrc}
                src={previewSrc}
                className="absolute inset-0 w-full h-full bg-black"
                style={videoPreviewStyle(canvasState, videoNaturalSize)}
                controls
                muted
                loop
                autoPlay
                onLoadedMetadata={(e) =>
                  setVideoNaturalSize({ width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })
                }
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-[#18181b] border border-neutral-700 text-center px-4">
                <p className="text-xs text-neutral-500">
                  {projects.length === 0
                    ? "No projects yet — create one and render a clip to preview against it here."
                    : "This clip has no rendered preview yet — render one from its project page first."}
                </p>
              </div>
            )}

            <Stage ref={stageRef} width={stageWidth} height={stageHeight} className="absolute inset-0">
              <Layer>
                <Rect x={0} y={0} width={stageWidth} height={stageHeight} stroke="#3f3f46" />
              </Layer>

              {canvasState.watermark.enabled && watermarkImg && (
              <Layer>
                <KonvaImage
                  image={watermarkImg}
                  x={canvasState.watermark.position.x * (stageWidth - watermarkDisplayWidth)}
                  y={canvasState.watermark.position.y * (stageHeight - watermarkDisplayHeight)}
                  width={watermarkDisplayWidth}
                  height={watermarkDisplayHeight}
                  opacity={canvasState.watermark.opacity}
                  draggable
                  onDragEnd={(e) => {
                    const maxX = stageWidth - watermarkDisplayWidth;
                    const maxY = stageHeight - watermarkDisplayHeight;
                    updateCanvasState({
                      watermark: {
                        ...canvasState.watermark,
                        position: {
                          x: maxX > 0 ? Math.min(1, Math.max(0, e.target.x() / maxX)) : 0,
                          y: maxY > 0 ? Math.min(1, Math.max(0, e.target.y() / maxY)) : 0,
                        },
                      },
                    });
                  }}
                />
              </Layer>
            )}

            {canvasState.caption.enabled && (
              <Layer>
                <Group
                  x={captionX}
                  y={captionY}
                  draggable
                  onDragEnd={(e) => {
                    const maxX = Math.max(0, stageWidth - captionDisplayMaxWidth);
                    const maxY = Math.max(0, stageHeight - captionDisplayHeight);
                    const x = Math.min(maxX, Math.max(0, e.target.x()));
                    const y = Math.min(maxY, Math.max(0, e.target.y()));
                    updateCanvasState({
                      caption: {
                        ...canvasState.caption,
                        position: {
                          x: maxX > 0 ? x / maxX : 0,
                          y: maxY > 0 ? y / maxY : 0,
                        },
                      },
                    });
                  }}
                >
                  <Rect
                    width={captionDisplayMaxWidth}
                    height={captionDisplayHeight}
                    fill={canvasState.caption.backgroundColor}
                    opacity={canvasState.caption.backgroundOpacity}
                  />
                  <KonvaText
                    text={canvasState.caption.text}
                    width={captionDisplayMaxWidth}
                    padding={canvasState.caption.padding * displayScale}
                    fontSize={captionDisplayFontSize}
                    fontStyle={canvasState.caption.fontWeight}
                    fill={canvasState.caption.fontColor}
                    align={canvasState.caption.alignment}
                  />
                </Group>
              </Layer>
            )}

            {canvasState.caption2.enabled && (
              <Layer>
                <Group
                  x={caption2X}
                  y={caption2Y}
                  draggable
                  onDragEnd={(e) => {
                    const maxX = Math.max(0, stageWidth - caption2DisplayMaxWidth);
                    const maxY = Math.max(0, stageHeight - caption2DisplayHeight);
                    const x = Math.min(maxX, Math.max(0, e.target.x()));
                    const y = Math.min(maxY, Math.max(0, e.target.y()));
                    updateCanvasState({
                      caption2: {
                        ...canvasState.caption2,
                        position: {
                          x: maxX > 0 ? x / maxX : 0,
                          y: maxY > 0 ? y / maxY : 0,
                        },
                      },
                    });
                  }}
                >
                  <Rect
                    width={caption2DisplayMaxWidth}
                    height={caption2DisplayHeight}
                    fill={canvasState.caption2.backgroundColor}
                    opacity={canvasState.caption2.backgroundOpacity}
                  />
                  <KonvaText
                    text={canvasState.caption2.text}
                    width={caption2DisplayMaxWidth}
                    padding={canvasState.caption2.padding * displayScale}
                    fontSize={caption2DisplayFontSize}
                    fontStyle={canvasState.caption2.fontWeight}
                    fill={canvasState.caption2.fontColor}
                    align={canvasState.caption2.alignment}
                  />
                </Group>
              </Layer>
            )}

            {canvasState.subtitle.enabled && (
              <Layer>
                <Group
                  x={subtitleX}
                  y={subtitleY}
                  draggable
                  onDragEnd={(e) => {
                    const maxX = Math.max(0, stageWidth - subtitleDisplayMaxWidth);
                    const maxY = Math.max(0, stageHeight - subtitleDisplayHeight);
                    const x = Math.min(maxX, Math.max(0, e.target.x()));
                    const y = Math.min(maxY, Math.max(0, e.target.y()));
                    updateCanvasState({
                      subtitle: {
                        ...canvasState.subtitle,
                        position: {
                          x: maxX > 0 ? x / maxX : 0,
                          y: maxY > 0 ? y / maxY : 0,
                        },
                      },
                    });
                  }}
                >
                  <Rect
                    width={subtitleDisplayMaxWidth}
                    height={subtitleDisplayHeight}
                    fill={canvasState.subtitle.backgroundColor}
                    opacity={canvasState.subtitle.backgroundOpacity}
                  />
                  <KonvaText
                    text={SUBTITLE_PREVIEW_SAMPLE}
                    width={subtitleDisplayMaxWidth}
                    padding={subtitleDisplayPadding}
                    fontSize={subtitleDisplayFontSize}
                    fontStyle={canvasState.subtitle.fontWeight}
                    fill={canvasState.subtitle.fontColor}
                    align={canvasState.subtitle.alignment}
                  />
                </Group>
              </Layer>
            )}
            </Stage>
          </div>
          <p className="text-xs text-neutral-500 mt-3 text-center max-w-xs">
            Drag the watermark, caption, or subtitle box to position them over the real clip.
            Pick a different project/clip above to preview against other footage.
          </p>
        </div>

        {/* Right properties panel — shows only the active section */}
        <div className="w-[300px] flex-shrink-0 bg-[#161618] border-l border-black/40 p-4 overflow-y-auto space-y-3">
          {activeSection === "platform" && (
            <>
              <h3 className="text-sm font-medium text-neutral-300 mb-1">Output</h3>
              <Field label="Platform">
                <select
                  className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
                  value={canvasState.platform}
                  onChange={(e) => updateCanvasState({ platform: e.target.value as Platform })}
                >
                  <option value="tiktok">TikTok</option>
                  <option value="youtube_shorts">YouTube Shorts</option>
                  <option value="youtube_video">YouTube Video</option>
                </select>
              </Field>
            </>
          )}

          {activeSection === "transform" && (
            <>
              <h3 className="text-sm font-medium text-neutral-300 mb-1">Transform</h3>
              <Field label="Mirror (horizontal flip)">
                <input
                  type="checkbox"
                  checked={canvasState.transform.mirror}
                  onChange={(e) =>
                    updateCanvasState({ transform: { ...canvasState.transform, mirror: e.target.checked } })
                  }
                />
              </Field>
              <Field label="Revert (vertical flip)">
                <input
                  type="checkbox"
                  checked={canvasState.transform.revert}
                  onChange={(e) =>
                    updateCanvasState({ transform: { ...canvasState.transform, revert: e.target.checked } })
                  }
                />
              </Field>
              <Field label="Scaling">
                <select
                  className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
                  value={canvasState.transform.scaling}
                  onChange={(e) =>
                    updateCanvasState({
                      transform: {
                        ...canvasState.transform,
                        scaling: e.target.value as "fit" | "fill" | "stretch" | "zoom",
                      },
                    })
                  }
                >
                  <option value="fit">Fit (letterbox)</option>
                  <option value="fill">Fill (crop to fill)</option>
                  <option value="zoom">Zoom (partial crop)</option>
                  <option value="stretch">Stretch</option>
                </select>
              </Field>
              {canvasState.transform.scaling === "zoom" && (
                <>
                  <Field label="Zoom amount">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={canvasState.transform.zoom ?? 0.5}
                      onChange={(e) =>
                        updateCanvasState({
                          transform: { ...canvasState.transform, zoom: Number(e.target.value) },
                        })
                      }
                    />
                  </Field>
                  <p className="text-[11px] text-neutral-600">
                    0% = Fit (full width visible, black bars top/bottom). 100% = Fill (no
                    black bars, most side crop). In between trades a little side overflow
                    for a taller view of the frame — the subject is usually centered in the
                    shot, so a small side crop rarely cuts anything important.
                  </p>
                </>
              )}
              {(canvasState.transform.scaling === "fill" || canvasState.transform.scaling === "zoom") && (
                <>
                  <Field label="Focus X">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={canvasState.transform.crop.x}
                      onChange={(e) =>
                        updateCanvasState({
                          transform: {
                            ...canvasState.transform,
                            crop: { ...canvasState.transform.crop, x: Number(e.target.value) },
                          },
                        })
                      }
                    />
                  </Field>
                  <Field label="Focus Y">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={canvasState.transform.crop.y}
                      onChange={(e) =>
                        updateCanvasState({
                          transform: {
                            ...canvasState.transform,
                            crop: { ...canvasState.transform.crop, y: Number(e.target.value) },
                          },
                        })
                      }
                    />
                  </Field>
                  <p className="text-[11px] text-neutral-600">
                    Customizes which part of the source frame stays visible when cropping —
                    e.g. keep a subject centered instead of the frame's middle.
                  </p>
                </>
              )}
              <Field label="Rotation">
                <select
                  className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
                  value={canvasState.transform.rotation}
                  onChange={(e) =>
                    updateCanvasState({
                      transform: {
                        ...canvasState.transform,
                        rotation: Number(e.target.value) as 0 | 90 | 180 | 270,
                      },
                    })
                  }
                >
                  <option value={0}>0°</option>
                  <option value={90}>90°</option>
                  <option value={180}>180°</option>
                  <option value={270}>270°</option>
                </select>
              </Field>
            </>
          )}

          {activeSection === "watermark" && (
            <>
              <h3 className="text-sm font-medium text-neutral-300 mb-1">Watermark</h3>
              <Field label="Enabled">
                <input
                  type="checkbox"
                  checked={canvasState.watermark.enabled}
                  onChange={(e) =>
                    updateCanvasState({ watermark: { ...canvasState.watermark, enabled: e.target.checked } })
                  }
                />
              </Field>
              <div className="space-y-1.5">
                <p className="text-xs text-neutral-400">Image</p>
                {watermarks.length > 0 && (
                  <div className="grid grid-cols-4 gap-1.5">
                    {watermarks.map((w) => (
                      <button
                        key={w.id}
                        title={w.name}
                        onClick={() =>
                          updateCanvasState({
                            watermark: { ...canvasState.watermark, enabled: true, imagePath: w.filePath },
                          })
                        }
                        className={`aspect-square rounded border-2 bg-neutral-900 flex items-center justify-center overflow-hidden ${
                          canvasState.watermark.imagePath === w.filePath
                            ? "border-blue-500"
                            : "border-neutral-700 hover:border-neutral-500"
                        }`}
                      >
                        <img src={convertFileSrc(w.filePath)} alt={w.name} className="max-w-full max-h-full" />
                      </button>
                    ))}
                  </div>
                )}
                <button
                  className="w-full px-2 py-1 rounded bg-neutral-700 hover:bg-neutral-600 text-xs disabled:opacity-50"
                  onClick={pickWatermark}
                  disabled={uploadingWatermark}
                >
                  {uploadingWatermark ? "Uploading…" : "+ Upload new image"}
                </button>
              </div>
              <Field label="Scale">
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={canvasState.watermark.scale}
                  onChange={(e) =>
                    updateCanvasState({ watermark: { ...canvasState.watermark, scale: Number(e.target.value) } })
                  }
                />
              </Field>
              <Field label="Opacity">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={canvasState.watermark.opacity}
                  onChange={(e) =>
                    updateCanvasState({ watermark: { ...canvasState.watermark, opacity: Number(e.target.value) } })
                  }
                />
              </Field>
            </>
          )}

          {activeSection === "caption" && (
            <>
              <h3 className="text-sm font-medium text-neutral-300 mb-1">Caption 1</h3>
              <CaptionFields
                caption={canvasState.caption}
                onChange={(caption) => updateCanvasState({ caption })}
                placeholder="Use {ai_caption} to insert the AI-generated caption"
              />
              <div className="pt-3 mt-3 border-t border-neutral-800 space-y-3">
                <h3 className="text-sm font-medium text-neutral-300 mb-1">Caption 2</h3>
                <p className="text-[11px] text-neutral-600 -mt-2">
                  A second, independent caption — e.g. a manually-typed one alongside an
                  auto {"{ai_caption}"}, or an auto part label for Full Movie mode using{" "}
                  {"{part_number}"} (e.g. "Part {"{part_number}"}").
                </p>
                <CaptionFields
                  caption={canvasState.caption2}
                  onChange={(caption2) => updateCanvasState({ caption2 })}
                  placeholder="e.g. Part {part_number} — {part_number} is replaced with 1, 2, 3..."
                />
              </div>
            </>
          )}

          {activeSection === "subtitle" && (
            <>
              <h3 className="text-sm font-medium text-neutral-300 mb-1">Subtitles</h3>
              <SubtitleFields
                subtitle={canvasState.subtitle}
                onChange={(subtitle) => updateCanvasState({ subtitle })}
              />
            </>
          )}

          {activeSection === "encoding" && (
            <>
              <h3 className="text-sm font-medium text-neutral-300 mb-1">Encoding</h3>
              <Field label="Codec">
                <select
                  className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
                  value={canvasState.encoding.codec}
                  onChange={(e) =>
                    updateCanvasState({
                      encoding: { ...canvasState.encoding, codec: e.target.value as "h264" | "h265" },
                    })
                  }
                >
                  <option value="h264">H.264</option>
                  <option value="h265">H.265</option>
                </select>
              </Field>
              <Field label="Quality (CRF)">
                <input
                  type="range"
                  min={18}
                  max={28}
                  value={canvasState.encoding.crf}
                  onChange={(e) =>
                    updateCanvasState({ encoding: { ...canvasState.encoding, crf: Number(e.target.value) } })
                  }
                />
              </Field>
              <Field label="Preset">
                <select
                  className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
                  value={canvasState.encoding.preset}
                  onChange={(e) =>
                    updateCanvasState({
                      encoding: { ...canvasState.encoding, preset: e.target.value as typeof canvasState.encoding.preset },
                    })
                  }
                >
                  <option value="ultrafast">Ultrafast</option>
                  <option value="superfast">Superfast</option>
                  <option value="veryfast">Veryfast</option>
                  <option value="faster">Faster</option>
                  <option value="fast">Fast</option>
                  <option value="medium">Medium</option>
                </select>
              </Field>
              <Field label="Max resolution">
                <select
                  className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
                  value={canvasState.encoding.maxResolution}
                  onChange={(e) =>
                    updateCanvasState({
                      encoding: { ...canvasState.encoding, maxResolution: Number(e.target.value) as 480 | 720 | 1080 },
                    })
                  }
                >
                  <option value={480}>480p</option>
                  <option value={720}>720p</option>
                  <option value={1080}>1080p</option>
                </select>
              </Field>
              <Field label="Audio bitrate">
                <select
                  className="bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs"
                  value={canvasState.encoding.audioBitrate}
                  onChange={(e) =>
                    updateCanvasState({
                      encoding: { ...canvasState.encoding, audioBitrate: e.target.value as "128k" | "192k" | "256k" },
                    })
                  }
                >
                  <option value="128k">128k</option>
                  <option value="192k">192k</option>
                  <option value="256k">256k</option>
                </select>
              </Field>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
