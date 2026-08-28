import type { CSSProperties } from "react";
import type { TemplateConfig } from "../stores/templateStore";

// Shared between ProjectDetail.tsx's live clip-player overlay and TemplateEditor.tsx's
// editing-time preview so both approximate the same ffmpeg.rs filter graph consistently.

export interface NaturalSize {
  width: number;
  height: number;
}

function mirrorRevertRotate(transform: TemplateConfig["transform"]): string {
  return [
    transform.mirror && "scaleX(-1)",
    transform.revert && "scaleY(-1)",
    transform.rotation && `rotate(${transform.rotation}deg)`,
  ]
    .filter(Boolean)
    .join(" ");
}

// "zoom" blends "fit"'s scale factor with "fill"'s (same math as ffmpeg.rs's render_final)
// and needs the video's actual decoded resolution to compute — CSS's object-fit has no
// "partial cover" primitive, only the fixed contain/cover/fill/none keywords, so this mode
// falls back to `cover` (i.e. looks like "fill") until `naturalSize` is known.
export function videoPreviewStyle(config: TemplateConfig, naturalSize?: NaturalSize | null): CSSProperties {
  const { transform, output } = config;

  if (transform.scaling === "zoom" && naturalSize && naturalSize.width > 0 && naturalSize.height > 0) {
    const fitScale = Math.min(output.width / naturalSize.width, output.height / naturalSize.height);
    const fillScale = Math.max(output.width / naturalSize.width, output.height / naturalSize.height);
    const scale = fitScale + transform.zoom * (fillScale - fitScale);
    const widthPct = ((naturalSize.width * scale) / output.width) * 100;
    const heightPct = ((naturalSize.height * scale) / output.height) * 100;

    // Matches ffmpeg.rs's pad-then-crop: an axis that's still short of the target (needs
    // padding, not cropping) is always centered there regardless of the focus point —
    // only an axis that overflows (needs cropping) uses crop.x/y as its anchor.
    const anchorX = widthPct >= 100 ? transform.crop.x : 0.5;
    const anchorY = heightPct >= 100 ? transform.crop.y : 0.5;
    const transforms = [`translate(-${anchorX * 100}%, -${anchorY * 100}%)`, mirrorRevertRotate(transform)]
      .filter(Boolean)
      .join(" ");

    return {
      position: "absolute",
      left: `${anchorX * 100}%`,
      top: `${anchorY * 100}%`,
      // Both callers' `<video>` elements carry a Tailwind `inset-0` class (sets
      // right/bottom: 0 too) for their non-zoom layout — explicitly clearing those here
      // instead of relying on them being spec-ignored once left/top/width/height are set.
      right: "auto",
      bottom: "auto",
      width: `${widthPct}%`,
      height: `${heightPct}%`,
      maxWidth: "none",
      maxHeight: "none",
      // Dimensions above are already the exact intended box — no cropping/letterboxing
      // left for object-fit to do.
      objectFit: "fill",
      transform: transforms,
    };
  }

  const objectFit: CSSProperties["objectFit"] =
    transform.scaling === "fill" || transform.scaling === "zoom"
      ? "cover"
      : transform.scaling === "stretch"
        ? "fill"
        : "contain";
  // Only "fill"/"zoom" (crop-to-fill) have a meaningful focus point — "fit"/"stretch" show
  // the whole frame, so there's nothing to offset.
  const objectPosition =
    transform.scaling === "fill" || transform.scaling === "zoom"
      ? `${transform.crop.x * 100}% ${transform.crop.y * 100}%`
      : undefined;

  return { objectFit, objectPosition, transform: mirrorRevertRotate(transform) || undefined };
}

export function hexToRgba(hex: string, opacity: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(0, 0, 0, ${opacity})`;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

export function resolveCaptionText(
  text: string,
  aiCaption: string | null | undefined,
  partNumber?: number
): string {
  return text
    .replace("{ai_caption}", aiCaption ?? "")
    .replace("{part_number}", partNumber != null ? String(partNumber) : "");
}
