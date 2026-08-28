// FFmpeg wrapper: Phase 3's minimal preview trim, plus Phase 4's template-based final
// render (SPEC.md sections 4/5). Shells out to a system-installed `ffmpeg` on PATH — no
// bundling yet (SPEC.md section 1/17 is future work).
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Resolves `ffmpeg` via PATH. No settings-table override yet — not required for v1.
pub fn ffmpeg_path() -> Result<PathBuf, String> {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|_| PathBuf::from("ffmpeg"))
        .map_err(|_| "ffmpeg not found on PATH — install it (e.g. `winget install Gyan.FFmpeg`) and restart the app".to_string())
}

/// Some FFmpeg builds compiled with fontconfig support but no configured `fonts.conf` print
/// "Fontconfig error: Cannot load default config file" the moment `drawtext` initializes —
/// and at least one build tested against this app (gyan.dev's `ffmpeg 9.0-full_build`)
/// doesn't just error, it segfaults on literally any `drawtext` call, reproduced with a
/// trivial one-frame `color` source input completely independent of anything this app
/// constructs. Pointing `FONTCONFIG_FILE` at a trivial-but-valid config is the standard
/// workaround for the missing-config case; it does NOT fix a build that's simply broken
/// (that needs a different FFmpeg build), but it's a correct, harmless thing to always set.
fn fontconfig_conf_path() -> Option<PathBuf> {
    let path = std::env::temp_dir().join("clipflow-fontconfig").join("fonts.conf");
    if path.exists() {
        return Some(path);
    }
    let dir = path.parent()?;
    std::fs::create_dir_all(dir).ok()?;
    std::fs::write(
        &path,
        "<?xml version=\"1.0\"?>\n<!DOCTYPE fontconfig SYSTEM \"fonts.dtd\">\n<fontconfig>\n  <dir>C:\\Windows\\Fonts</dir>\n</fontconfig>\n",
    )
    .ok()?;
    Some(path)
}

fn with_fontconfig_env(cmd: &mut Command) {
    if let Some(path) = fontconfig_conf_path() {
        cmd.env("FONTCONFIG_FILE", path);
    }
}

/// Stream-copies `[start_seconds, end_seconds)` out of `movie_path` into `output_path`.
///
/// `-ss` before `-i` is a fast seek that can land on the nearest keyframe rather than the
/// exact frame — acceptable for a preview; frame-accurate trimming (`-ss` after `-i`) is
/// slower and not needed unless drift becomes a real complaint.
pub fn extract_clip(
    movie_path: &str,
    start_seconds: f64,
    end_seconds: f64,
    output_path: &Path,
) -> Result<(), String> {
    let ffmpeg = ffmpeg_path()?;
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create output dir: {e}"))?;
    }

    let output = Command::new(ffmpeg)
        .args([
            "-y",
            "-ss",
            &start_seconds.to_string(),
            "-to",
            &end_seconds.to_string(),
            "-i",
            movie_path,
            "-c",
            "copy",
        ])
        .arg(output_path)
        .output()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg failed: {stderr}"));
    }
    Ok(())
}

/// Grabs a single frame at `seek_seconds` as a JPEG thumbnail, scaled to 320px wide. Used
/// for the movie thumbnail and per-clip timeline thumbnails in the project editor UI.
pub fn extract_thumbnail(movie_path: &str, seek_seconds: f64, output_path: &Path) -> Result<(), String> {
    let ffmpeg = ffmpeg_path()?;
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create output dir: {e}"))?;
    }

    let output = Command::new(ffmpeg)
        .args([
            "-y",
            "-ss",
            &seek_seconds.to_string(),
            "-i",
            movie_path,
            "-frames:v",
            "1",
            "-update",
            "1",
            "-vf",
            "scale=320:-1",
        ])
        .arg(output_path)
        .output()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg failed: {stderr}"));
    }
    Ok(())
}

// TemplateConfig (SPEC.md section 4) — mirrors the frontend's TypeScript interface that
// the Konva canvas serializes to. Deserialized straight from templates.config_json.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateConfig {
    pub output: OutputConfig,
    pub transform: TransformConfig,
    pub watermark: WatermarkConfig,
    pub caption: CaptionConfig,
    // Independent second caption overlay — e.g. caption is a manually-typed or
    // `{ai_caption}` hook, caption2 an auto "Part {part_number}" label for Full Movie
    // mode — each with its own enabled flag, text, position and styling. Defaults to
    // disabled/empty for templates saved before this field existed.
    #[serde(default = "default_caption2")]
    pub caption2: CaptionConfig,
    pub encoding: EncodingConfig,
}

#[derive(Debug, Deserialize)]
pub struct OutputConfig {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformConfig {
    pub mirror: bool,
    pub revert: bool,
    pub rotation: u32, // 0 | 90 | 180 | 270
    pub scaling: String, // 'fit' | 'fill' | 'stretch' | 'zoom'
    // Focus point (0-1 fraction of the frame) used as the crop anchor when scaling is
    // "fill" or "zoom" — defaults to centered for templates saved before this field existed.
    #[serde(default = "default_crop")]
    pub crop: Point,
    // 0-1: how far to blend from "fit" (0, fully visible, letterboxed) to "fill" (1, no
    // letterbox, max side crop) when scaling is "zoom" — defaults to centered/half blend
    // for templates saved before this field existed.
    #[serde(default = "default_zoom")]
    pub zoom: f64,
}

fn default_crop() -> Point {
    Point { x: 0.5, y: 0.5 }
}

fn default_zoom() -> f64 {
    0.5
}

fn default_font_weight() -> String {
    "normal".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkConfig {
    pub enabled: bool,
    pub image_path: String,
    pub position: Point,
    pub scale: f64,
    pub opacity: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionConfig {
    pub enabled: bool,
    pub text: String,
    pub font_family: String,
    pub font_size: f64,
    // 'normal' | 'bold' — defaults to 'normal' for templates saved before this field existed.
    #[serde(default = "default_font_weight")]
    pub font_weight: String,
    pub font_color: String,
    pub background_color: String,
    pub background_opacity: f64,
    pub padding: f64,
    pub position: Point,
    pub max_width: f64,
    pub alignment: String, // 'left' | 'center' | 'right'
}

fn default_caption2() -> CaptionConfig {
    CaptionConfig {
        enabled: false,
        text: "Part {part_number}".to_string(),
        font_family: "Arial".to_string(),
        font_size: 64.0,
        font_weight: "normal".to_string(),
        font_color: "#ffffff".to_string(),
        background_color: "#000000".to_string(),
        background_opacity: 0.5,
        padding: 16.0,
        position: Point { x: 0.1, y: 0.08 },
        max_width: 880.0,
        alignment: "left".to_string(),
    }
}

#[derive(Debug, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodingConfig {
    pub codec: String,          // 'h264' | 'h265'
    pub crf: u32,                // 18-28
    pub preset: String,          // 'ultrafast'..'medium'
    pub max_resolution: u32,     // 480 | 720 | 1080 (height cap)
    pub audio_bitrate: String,   // '128k' | '192k' | '256k'
}

fn escape_drawtext(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "\u{2019}")
}

/// Greedily word-wraps `text` to fit `max_width_px` per line — ffmpeg's `drawtext` has no
/// built-in auto-wrap (unlike Konva's `Text` with a `width` prop, which wraps using real
/// measured glyph widths), so a long caption previously just drew as one line and ran past
/// its own box/the frame edge regardless of `maxWidth`. `avg_char_width_px` is a rough
/// per-character estimate (no font-shaping library here to measure real glyph widths) —
/// good enough to keep captions inside their box without needing pixel-perfect wrapping.
/// Existing `\n`s in the source text are preserved as hard paragraph breaks.
fn wrap_caption_text(text: &str, max_width_px: f64, avg_char_width_px: f64) -> Vec<String> {
    let max_chars = ((max_width_px / avg_char_width_px.max(1.0)).floor() as usize).max(1);
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut current = String::new();
        for word in paragraph.split_whitespace() {
            let candidate_len = if current.is_empty() { word.len() } else { current.len() + 1 + word.len() };
            if candidate_len > max_chars && !current.is_empty() {
                lines.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        }
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

/// Builds a `drawbox=...,drawtext=...` filter pair for a caption overlay — shared by the
/// primary `caption` and the independent `caption2` overlay, which differ only in their
/// own config values, not in how a caption gets burned in. Mirrors the Konva preview's
/// layout exactly (`TemplateEditor.tsx`'s `Group`/`Rect`/`KonvaText`): a fixed `maxWidth`-wide
/// box (not a text-width-dependent one — that was an earlier bug where `alignment` had no
/// effect on the render) placed edge-relative per `position.{x,y}` (see below), with
/// `alignment` placing the text horizontally inside that box.
fn caption_drawtext_filter(cap: &CaptionConfig, output_width: u32, output_height: u32) -> String {
    let font_scale = output_height as f64 / 1920.0;
    let font_file = resolve_font_file(&cap.font_family, &cap.font_weight);
    let size = (cap.font_size * font_scale).round() as i64;
    let pad = cap.padding * font_scale;
    let box_w = cap.max_width * font_scale;
    // 0.55x font size is a typical average glyph width for a proportional sans/serif face —
    // approximate (see wrap_caption_text's doc comment) but keeps captions from overflowing
    // their box the way an un-wrapped single `drawtext` line previously did.
    let avg_char_width = size as f64 * 0.55;
    let wrapped_lines = wrap_caption_text(&cap.text, (box_w - pad * 2.0).max(1.0), avg_char_width);
    let wrapped_text = wrapped_lines.join("\n");
    // ffmpeg's default line spacing (no `line_spacing` override) is close to 1.2x the font
    // size for most fonts — matches this box-height estimate closely enough to avoid the
    // background box clipping the last line or leaving a big gap under a short caption.
    let line_height = size as f64 * 1.2;
    let box_h = wrapped_lines.len() as f64 * line_height + pad * 2.0;
    // Edge-relative placement — `position.{x,y}` is where the box's *own* edge sits between
    // the frame's edges (0 = box's left/top flush with the frame's, 1 = box's right/bottom
    // flush with the frame's), the same basis the watermark's `(main_w-overlay_w)*x` overlay
    // filter and the live CSS preview (ProjectDetail.tsx's CaptionOverlayBlock) both already
    // use. It used to be `position.x * output_width` — a *full-width* basis under which a
    // box dragged near an edge could end up hanging off the frame entirely once its own
    // width/height was added on. Alignment only repositions text *inside* the box, so a box
    // already off-frame made "left/center/right" look like it had no effect at all — the
    // box's own placement, not the alignment math, was the actual bug. This also made the
    // live preview (already edge-relative) not match what ffmpeg actually rendered.
    let box_x = cap.position.x * (output_width as f64 - box_w).max(0.0);
    let box_y = cap.position.y * (output_height as f64 - box_h).max(0.0);
    // Positions the overall (possibly multi-line) text block — `text_w` is the widest
    // wrapped line's width, so this places that widest line as intended. `text_align` below
    // additionally aligns any *shorter* lines within that same block, which `x` alone can't
    // do since drawtext only evaluates one `x` expression for the whole block.
    let text_x = match cap.alignment.as_str() {
        "center" => format!("{box_x}+({box_w}-text_w)/2"),
        "right" => format!("{box_x}+{box_w}-text_w-{pad}"),
        _ => format!("{box_x}+{pad}"),
    };
    let text_align = match cap.alignment.as_str() {
        "center" => "center",
        "right" => "right",
        _ => "left",
    };
    format!(
        "drawbox=x={box_x}:y={box_y}:w={box_w}:h={box_h}:color={bg}@{bgop}:t=fill,drawtext=text='{text}':fontfile='{font}':fontsize={size}:fontcolor={color}:text_align={text_align}:x={text_x}:y={box_y}+({box_h}-text_h)/2",
        text = escape_drawtext(&wrapped_text),
        font = escape_drawtext(&font_file.to_string_lossy()),
        color = cap.font_color,
        bg = cap.background_color,
        bgop = cap.background_opacity,
    )
}

/// Resolves a font family name to an actual font file for drawtext's `fontfile=`. Using
/// `font=<name>` (fontconfig lookup) is more portable in principle, but this machine's
/// FFmpeg build has fontconfig compiled in without a configured `fonts.conf`, so lookups
/// fail at runtime ("Cannot load default config file"). `fontfile=` sidesteps that and
/// matches SPEC.md section 5's original pseudocode. Windows-only mapping for now — revisit
/// alongside cross-platform FFmpeg bundling (SPEC.md section 17, not started).
fn resolve_font_file(font_family: &str, font_weight: &str) -> PathBuf {
    let windows_fonts = PathBuf::from(r"C:\Windows\Fonts");
    let bold = font_weight.eq_ignore_ascii_case("bold") || font_family.eq_ignore_ascii_case("arial bold");
    let file = match (font_family.to_lowercase().as_str(), bold) {
        ("arial", true) | ("helvetica", true) | ("arial bold", _) => "arialbd.ttf",
        ("arial", false) | ("helvetica", false) => "arial.ttf",
        ("times new roman", true) | ("times", true) => "timesbd.ttf",
        ("times new roman", false) | ("times", false) => "times.ttf",
        ("courier new", true) | ("courier", true) => "courbd.ttf",
        ("courier new", false) | ("courier", false) => "cour.ttf",
        // Impact has no distinct bold cut on Windows — already a heavy display face.
        ("impact", _) => "impact.ttf",
        ("comic sans ms", true) => "comicbd.ttf",
        ("comic sans ms", false) => "comic.ttf",
        ("verdana", true) => "verdanab.ttf",
        ("verdana", false) => "verdana.ttf",
        ("georgia", true) => "georgiab.ttf",
        ("georgia", false) => "georgia.ttf",
        (_, true) => "arialbd.ttf",
        (_, false) => "arial.ttf",
    };
    windows_fonts.join(file)
}

/// Runs a clip through the full template pipeline (SPEC.md section 5): trim, scale/crop,
/// mirror/revert/rotate, watermark overlay, caption burn-in, encode. Known simplifications
/// vs. the full spec, acceptable for v1 — revisit only if a real template needs them:
/// - Caption `anchor` isn't applied; position.{x,y} directly drives a fractional x/y via
///   drawtext's `text_w`/`text_h`, which already approximates most anchors reasonably.
/// - Watermark `anchor` is likewise approximated by `position` alone.
pub fn render_final(
    movie_path: &str,
    start_seconds: f64,
    end_seconds: f64,
    template: &TemplateConfig,
    output_path: &Path,
) -> Result<(), String> {
    let ffmpeg = ffmpeg_path()?;
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create output dir: {e}"))?;
    }

    let (w, h) = (template.output.width, template.output.height);
    let mut filters: Vec<String> = Vec::new();
    let mut current = "0:v".to_string();

    let scale_filter = match template.transform.scaling.as_str() {
        "fill" => {
            let cx = template.transform.crop.x.clamp(0.0, 1.0);
            let cy = template.transform.crop.y.clamp(0.0, 1.0);
            format!(
                "scale=w={w}:h={h}:force_original_aspect_ratio=increase,crop=w={w}:h={h}:x=(in_w-{w})*{cx}:y=(in_h-{h})*{cy}"
            )
        }
        "zoom" => {
            let cx = template.transform.crop.x.clamp(0.0, 1.0);
            let cy = template.transform.crop.y.clamp(0.0, 1.0);
            let z = template.transform.zoom.clamp(0.0, 1.0);
            // Blends "fit"'s scale factor (min of the two fit ratios — fully visible,
            // letterboxed) with "fill"'s (max of the two — no letterbox, full crop) by
            // `z` instead of picking one outright, so raising zoom trades letterbox for a
            // little side crop instead of jumping straight from one extreme to the other.
            // Quoted since the expressions contain commas, which ffmpeg's filtergraph
            // parser would otherwise read as the next filter/option separator.
            let fit = format!("min({w}/iw,{h}/ih)");
            let fill = format!("max({w}/iw,{h}/ih)");
            let factor = format!("({fit}+{z}*({fill}-{fit}))");
            // `trunc(x/2)*2` forces an even pixel count — yuv420p's chroma subsampling
            // requires it, and an odd scaled dimension exactly matching the pad target
            // makes ffmpeg's pad filter fail with "Padded dimensions cannot be smaller
            // than input dimensions" (confirmed against a real ffmpeg build: a 3413px-wide
            // scale output raising that error at z=1, while the same width rounded up to
            // 3414 works) even though the two values are mathematically equal.
            format!(
                "scale=w='trunc(iw*{factor}/2)*2':h='trunc(ih*{factor}/2)*2',pad=w='max(iw,{w})':h='max(ih,{h})':x='(ow-iw)/2':y='(oh-ih)/2':color=black,crop=w={w}:h={h}:x=(in_w-{w})*{cx}:y=(in_h-{h})*{cy}"
            )
        }
        "stretch" => format!("scale={w}:{h}"),
        _ => format!(
            "scale=w={w}:h={h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black"
        ),
    };
    filters.push(format!("[{current}]{scale_filter}[scaled]"));
    current = "scaled".to_string();

    if template.transform.mirror {
        filters.push(format!("[{current}]hflip[mirrored]"));
        current = "mirrored".to_string();
    }
    if template.transform.revert {
        filters.push(format!("[{current}]vflip[reverted]"));
        current = "reverted".to_string();
    }
    let transpose = match template.transform.rotation {
        90 => Some("transpose=1"),
        180 => Some("transpose=1,transpose=1"),
        270 => Some("transpose=2"),
        _ => None,
    };
    if let Some(t) = transpose {
        filters.push(format!("[{current}]{t}[rotated]"));
        current = "rotated".to_string();
    }

    let has_watermark = template.watermark.enabled && !template.watermark.image_path.is_empty();
    if has_watermark {
        let wm = &template.watermark;
        // Watermark width is a fraction of the *output* width (matches the Konva canvas
        // preview), not the watermark image's own raw pixel size.
        let watermark_width = (w as f64 * wm.scale).round() as i64;
        filters.push(format!(
            "[1:v]scale=w={ww}:h=-2,format=rgba,colorchannelmixer=aa={a}[wm]",
            ww = watermark_width,
            a = wm.opacity
        ));
        filters.push(format!(
            "[{current}][wm]overlay=x=(main_w-overlay_w)*{x}:y=(main_h-overlay_h)*{y}[watermarked]",
            x = wm.position.x,
            y = wm.position.y
        ));
        current = "watermarked".to_string();
    }

    if template.caption.enabled && !template.caption.text.is_empty() {
        let drawtext = caption_drawtext_filter(&template.caption, w, h);
        filters.push(format!("[{current}]{drawtext}[captioned]"));
        current = "captioned".to_string();
    }
    if template.caption2.enabled && !template.caption2.text.is_empty() {
        let drawtext = caption_drawtext_filter(&template.caption2, w, h);
        filters.push(format!("[{current}]{drawtext}[captioned2]"));
        current = "captioned2".to_string();
    }

    if template.encoding.max_resolution < h {
        filters.push(format!(
            "[{current}]scale=-2:{}[resized]",
            template.encoding.max_resolution
        ));
        current = "resized".to_string();
    }

    let filter_complex = filters.join(";");
    let codec = match template.encoding.codec.as_str() {
        "h265" => "libx265",
        _ => "libx264",
    };

    let mut cmd = Command::new(ffmpeg);
    with_fontconfig_env(&mut cmd);
    cmd.args(["-y", "-ss", &start_seconds.to_string(), "-to", &end_seconds.to_string(), "-i", movie_path]);
    if has_watermark {
        cmd.args(["-i", &template.watermark.image_path]);
    }
    cmd.args(["-filter_complex", &filter_complex]);
    cmd.args(["-map", &format!("[{current}]"), "-map", "0:a?"]);
    cmd.args(["-c:v", codec, "-crf", &template.encoding.crf.to_string(), "-preset", &template.encoding.preset]);
    cmd.args(["-c:a", "aac", "-b:a", &template.encoding.audio_bitrate]);
    cmd.arg(output_path);

    let output = cmd.output().map_err(|e| format!("failed to run ffmpeg: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg failed: {stderr}"));
    }
    Ok(())
}
