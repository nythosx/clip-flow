import type { CSSProperties } from "react";
import type { TemplateConfig } from "../stores/templateStore";

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

export function videoPreviewStyle(config: TemplateConfig, naturalSize?: NaturalSize | null): CSSProperties {
  const { transform, output } = config;

  if (transform.scaling === "zoom" && naturalSize && naturalSize.width > 0 && naturalSize.height > 0) {
    const fitScale = Math.min(output.width / naturalSize.width, output.height / naturalSize.height);
    const fillScale = Math.max(output.width / naturalSize.width, output.height / naturalSize.height);
    const scale = fitScale + transform.zoom * (fillScale - fitScale);
    const widthPct = ((naturalSize.width * scale) / output.width) * 100;
    const heightPct = ((naturalSize.height * scale) / output.height) * 100;

    const anchorX = widthPct >= 100 ? transform.crop.x : 0.5;
    const anchorY = heightPct >= 100 ? transform.crop.y : 0.5;
    const transforms = [`translate(-${anchorX * 100}%, -${anchorY * 100}%)`, mirrorRevertRotate(transform)]
      .filter(Boolean)
      .join(" ");

    return {
      position: "absolute",
      left: `${anchorX * 100}%`,
      top: `${anchorY * 100}%`,

      right: "auto",
      bottom: "auto",
      width: `${widthPct}%`,
      height: `${heightPct}%`,
      maxWidth: "none",
      maxHeight: "none",

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
