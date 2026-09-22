use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn ffmpeg_path() -> Result<PathBuf, String> {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|_| PathBuf::from("ffmpeg"))
        .map_err(|_| "ffmpeg not found on PATH — install it (e.g. `winget install Gyan.FFmpeg`) and restart the app".to_string())
}

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

pub fn probe_duration_seconds(movie_path: &str) -> Result<f64, String> {
    let ffmpeg = ffmpeg_path()?;
    let output = Command::new(ffmpeg)
        .args(["-i", movie_path])
        .output()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_duration_line(&stderr).ok_or_else(|| "could not determine movie duration".to_string())
}

fn parse_duration_line(stderr: &str) -> Option<f64> {
    let line = stderr.lines().find(|l| l.trim_start().starts_with("Duration:"))?;
    let after = line.trim_start().strip_prefix("Duration:")?;
    let ts = after.split(',').next()?.trim();
    let parts: Vec<&str> = ts.split(':').collect();
    match parts.as_slice() {
        [h, m, s] => Some(h.trim().parse::<f64>().ok()? * 3600.0 + m.trim().parse::<f64>().ok()? * 60.0 + s.trim().parse::<f64>().ok()?),
        _ => None,
    }
}

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateConfig {
    pub output: OutputConfig,
    pub transform: TransformConfig,
    pub watermark: WatermarkConfig,
    pub caption: CaptionConfig,
    #[serde(default = "default_caption2")]
    pub caption2: CaptionConfig,
    #[serde(default = "default_subtitle")]
    pub subtitle: SubtitleConfig,
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
    pub rotation: u32,
    pub scaling: String,
    #[serde(default = "default_crop")]
    pub crop: Point,
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
    #[serde(default = "default_font_weight")]
    pub font_weight: String,
    pub font_color: String,
    pub background_color: String,
    pub background_opacity: f64,
    pub padding: f64,
    pub position: Point,
    pub max_width: f64,
    pub alignment: String,
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
#[serde(rename_all = "camelCase")]
pub struct SubtitleConfig {
    pub enabled: bool,
    pub font_family: String,
    pub font_size: f64,
    #[serde(default = "default_font_weight")]
    pub font_weight: String,
    pub font_color: String,
    pub background_color: String,
    pub background_opacity: f64,
    pub padding: f64,
    pub position: Point,
    pub max_width: f64,
    pub alignment: String,
}

fn default_subtitle() -> SubtitleConfig {
    SubtitleConfig {
        enabled: false,
        font_family: "Arial".to_string(),
        font_size: 56.0,
        font_weight: "bold".to_string(),
        font_color: "#ffffff".to_string(),
        background_color: "#000000".to_string(),
        background_opacity: 0.45,
        padding: 12.0,
        position: Point { x: 0.1, y: 0.5 },
        max_width: 880.0,
        alignment: "center".to_string(),
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
    pub codec: String,
    pub crf: u32,
    pub preset: String,
    pub max_resolution: u32,
    pub audio_bitrate: String,
}

fn escape_drawtext(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "\u{2019}")
}

fn char_width_fraction(c: char) -> f64 {
    if c == ' ' {
        0.28
    } else if c.is_ascii_digit() {
        0.55
    } else if c.is_ascii_uppercase() {
        0.72
    } else if c.is_ascii_lowercase() {
        match c {
            'i' | 'l' | 'j' | 't' | 'f' => 0.28,
            'm' | 'w' => 0.9,
            _ => 0.5,
        }
    } else {
        0.55
    }
}

fn estimate_text_width_px(text: &str, size_px: f64, bold: bool) -> f64 {
    let width: f64 = text.chars().map(|c| char_width_fraction(c) * size_px).sum();
    if bold { width * 1.08 } else { width }
}

fn wrap_caption_text(text: &str, max_width_px: f64, size_px: f64, bold: bool) -> Vec<String> {
    let max_width_px = max_width_px.max(1.0);
    let space_width = estimate_text_width_px(" ", size_px, bold);
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut current = String::new();
        let mut current_width = 0.0_f64;
        for word in paragraph.split_whitespace() {
            let word_width = estimate_text_width_px(word, size_px, bold);
            let candidate_width = if current.is_empty() { word_width } else { current_width + space_width + word_width };
            if candidate_width > max_width_px && !current.is_empty() {
                lines.push(std::mem::take(&mut current));
                current_width = 0.0;
            }
            if !current.is_empty() {
                current.push(' ');
                current_width += space_width;
            }
            current.push_str(word);
            current_width += word_width;
        }
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

#[allow(clippy::too_many_arguments)]
fn build_text_box_filter(
    text: &str,
    font_family: &str,
    font_size: f64,
    font_weight: &str,
    font_color: &str,
    background_color: &str,
    background_opacity: f64,
    padding: f64,
    position: &Point,
    max_width: f64,
    alignment: &str,
    output_width: u32,
    output_height: u32,
    enable_range: Option<(f64, f64)>,
) -> String {
    let font_scale = output_height as f64 / 1920.0;
    let font_file = resolve_font_file(font_family, font_weight);
    let size = (font_size * font_scale).round() as i64;
    let pad = padding * font_scale;
    let box_w = max_width * font_scale;
    let bold = font_weight.eq_ignore_ascii_case("bold");
    let wrapped_lines = wrap_caption_text(text, (box_w - pad * 2.0).max(1.0), size as f64, bold);
    let wrapped_text = wrapped_lines.join("\n");
    let line_height = size as f64 * 1.2;
    let box_h = wrapped_lines.len() as f64 * line_height + pad * 2.0;
    let box_x = position.x * (output_width as f64 - box_w).max(0.0);
    let box_y = position.y * (output_height as f64 - box_h).max(0.0);
    let text_x = match alignment {
        "center" => format!("{box_x}+({box_w}-text_w)/2"),
        "right" => format!("{box_x}+{box_w}-text_w-{pad}"),
        _ => format!("{box_x}+{pad}"),
    };
    let text_align = match alignment {
        "center" => "center",
        "right" => "right",
        _ => "left",
    };
    let enable = enable_range
        .map(|(start, end)| format!(":enable='between(t,{start},{end})'"))
        .unwrap_or_default();
    format!(
        "drawbox=x={box_x}:y={box_y}:w={box_w}:h={box_h}:color={bg}@{bgop}:t=fill{enable},drawtext=text='{text}':fontfile='{font}':fontsize={size}:fontcolor={color}:text_align={text_align}:x={text_x}:y={box_y}+({box_h}-text_h)/2{enable}",
        text = escape_drawtext(&wrapped_text),
        font = escape_drawtext(&font_file.to_string_lossy()),
        color = font_color,
        bg = background_color,
        bgop = background_opacity,
    )
}

fn caption_drawtext_filter(cap: &CaptionConfig, output_width: u32, output_height: u32) -> String {
    build_text_box_filter(
        &cap.text,
        &cap.font_family,
        cap.font_size,
        &cap.font_weight,
        &cap.font_color,
        &cap.background_color,
        cap.background_opacity,
        cap.padding,
        &cap.position,
        cap.max_width,
        &cap.alignment,
        output_width,
        output_height,
        None,
    )
}

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

fn format_ass_time(seconds: f64) -> String {
    let total_cs = (seconds.max(0.0) * 100.0).round() as u64;
    let cs = total_cs % 100;
    let total_secs = total_cs / 100;
    let s = total_secs % 60;
    let m = (total_secs / 60) % 60;
    let h = total_secs / 3600;
    format!("{}:{:02}:{:02}.{:02}", h, m, s, cs)
}

fn ass_color(hex: &str, opacity: f64) -> String {
    let hex = hex.trim_start_matches('#');
    let (r, g, b) = if hex.len() == 6 {
        (
            u8::from_str_radix(&hex[0..2], 16).unwrap_or(255),
            u8::from_str_radix(&hex[2..4], 16).unwrap_or(255),
            u8::from_str_radix(&hex[4..6], 16).unwrap_or(255),
        )
    } else {
        (255, 255, 255)
    };
    let a = ((1.0 - opacity.clamp(0.0, 1.0)) * 255.0).round() as u8;
    format!("&H{:02X}{:02X}{:02X}{:02X}", a, b, g, r)
}

fn escape_ass_text(text: &str) -> String {
    text.replace('{', "\\{")
        .replace('}', "\\}")
        .replace('\n', "\\N")
}

fn build_ass_file(
    sub: &SubtitleConfig,
    cues: &[(f64, f64, String)],
    w: u32,
    h: u32,
    path: &Path,
) -> Result<(), String> {
    let font_scale = h as f64 / 1920.0;
    let font_size = (sub.font_size * font_scale).round().max(1.0) as i64;
    let padding = (sub.padding * font_scale).round().max(1.0) as i64;
    let bold = if sub.font_weight.eq_ignore_ascii_case("bold") { -1 } else { 0 };
    let primary = ass_color(&sub.font_color, 1.0);
    let outline = ass_color(&sub.background_color, sub.background_opacity);
    let back = ass_color(&sub.background_color, 0.0);

    let mut content = String::new();
    content.push_str("[Script Info]\n");
    content.push_str("ScriptType: v4.00+\n");
    content.push_str(&format!("PlayResX: {}\n", w));
    content.push_str(&format!("PlayResY: {}\n", h));
    content.push_str("WrapStyle: 0\n");
    content.push_str("ScaledBorderAndShadow: yes\n");
    content.push_str("YCbCr Matrix: TV.709\n\n");

    content.push_str("[V4+ Styles]\n");
    content.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");
    content.push_str(&format!(
        "Style: Sub,{fn_},{fs},{pc},&H000000FF,{oc},{bc},{b},0,0,0,100,100,0,0,3,{pad},0,5,40,40,60,1\n",
        fn_ = sub.font_family,
        fs = font_size,
        pc = primary,
        oc = outline,
        bc = back,
        b = bold,
        pad = padding,
    ));

    content.push_str("\n[Events]\n");
    content.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    let max_w = sub.max_width * (w as f64 / 1080.0);
    let cx = sub.position.x * (w as f64 - max_w) + max_w / 2.0;
    let cy = sub.position.y * (h as f64);

    for (start, end, text) in cues {
        if text.trim().is_empty() {
            continue;
        }
        let escaped = escape_ass_text(text);
        content.push_str(&format!(
            "Dialogue: 0,{start},{end},Sub,,0,0,0,,{{\\an5\\pos({cx:.0},{cy:.0})}}{text}\n",
            start = format_ass_time(*start),
            end = format_ass_time(*end),
            cx = cx,
            cy = cy,
            text = escaped,
        ));
    }

    std::fs::write(path, content).map_err(|e| format!("failed to write ASS file: {e}"))
}

fn build_structural_filters(template: &TemplateConfig, w: u32, h: u32) -> (Vec<String>, String) {
    let mut filters: Vec<String> = Vec::new();
    let mut current = "0:v".to_string();

    let scale_filter = match template.transform.scaling.as_str() {
        "fill" => {
            let cx = template.transform.crop.x.clamp(0.0, 1.0);
            let cy = template.transform.crop.y.clamp(0.0, 1.0);
            Some(format!(
                "scale=w={w}:h={h}:force_original_aspect_ratio=increase,crop=w={w}:h={h}:x=(in_w-{w})*{cx}:y=(in_h-{h})*{cy}"
            ))
        }
        "zoom" => {
            let cx = template.transform.crop.x.clamp(0.0, 1.0);
            let cy = template.transform.crop.y.clamp(0.0, 1.0);
            let z = template.transform.zoom.clamp(0.0, 1.0);
            let fit = format!("min({w}/iw,{h}/ih)");
            let fill = format!("max({w}/iw,{h}/ih)");
            let factor = format!("({fit}+{z}*({fill}-{fit}))");
            Some(format!(
                "scale=w='trunc(iw*{factor}/2)*2':h='trunc(ih*{factor}/2)*2',pad=w='max(iw,{w})':h='max(ih,{h})':x='(ow-iw)/2':y='(oh-ih)/2':color=black,crop=w={w}:h={h}:x=(in_w-{w})*{cx}:y=(in_h-{h})*{cy}"
            ))
        }
        "stretch" => Some(format!("scale={w}:{h}")),
        _ => Some(format!(
            "scale=w={w}:h={h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black"
        )),
    };
    if let Some(sf) = scale_filter {
        filters.push(format!("[{current}]{sf}[scaled]"));
        current = "scaled".to_string();
    }

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

    if template.watermark.enabled && !template.watermark.image_path.is_empty() {
        let wm = &template.watermark;
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

    if filters.is_empty() {
        return (Vec::new(), "0:v".to_string());
    }
    if current != "v_out" {
        filters.push(format!("[{current}]null[v_out]"));
        current = "v_out".to_string();
    }
    (filters, current)
}

fn build_overlay_chain(
    template: &TemplateConfig,
    subtitle_cues: &[(f64, f64, String)],
    w: u32,
    h: u32,
    temp_dir: &Path,
    ts: u128,
) -> Result<(String, Vec<PathBuf>), String> {
    let mut chain: Vec<String> = Vec::new();
    let mut temps: Vec<PathBuf> = Vec::new();

    if template.caption.enabled && !template.caption.text.is_empty() {
        chain.push(caption_drawtext_filter(&template.caption, w, h));
    }
    if template.caption2.enabled && !template.caption2.text.is_empty() {
        chain.push(caption_drawtext_filter(&template.caption2, w, h));
    }
    if template.subtitle.enabled && !subtitle_cues.is_empty() {
        let ass_name = format!("cf_ass_{ts}.ass");
        let ass_path = temp_dir.join(&ass_name);
        build_ass_file(&template.subtitle, subtitle_cues, w, h, &ass_path)?;
        chain.push(format!("ass=filename={}", ass_name));
        temps.push(ass_path);
    }
    if template.encoding.max_resolution < h {
        chain.push(format!("scale=-2:{}", template.encoding.max_resolution));
    }

    Ok((chain.join(","), temps))
}

pub fn render_final(
    movie_path: &str,
    start_seconds: f64,
    end_seconds: f64,
    template: &TemplateConfig,
    subtitle_cues: &[(f64, f64, String)],
    output_path: &Path,
) -> Result<(), String> {
    let ffmpeg = ffmpeg_path()?;
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create output dir: {e}"))?;
    }

    let (w, h) = (template.output.width, template.output.height);
    let (structural_filters, structural_out) = build_structural_filters(template, w, h);
    let has_watermark = template.watermark.enabled && !template.watermark.image_path.is_empty();
    let codec = match template.encoding.codec.as_str() {
        "h265" => "libx265",
        _ => "libx264",
    };

    let temp_dir = std::env::temp_dir();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let (overlay_chain, overlay_temps) = build_overlay_chain(template, subtitle_cues, w, h, &temp_dir, ts)?;

    if overlay_chain.is_empty() {
        let mut cmd = Command::new(&ffmpeg);
        with_fontconfig_env(&mut cmd);
        cmd.args(["-y", "-ss", &start_seconds.to_string(), "-to", &end_seconds.to_string(), "-i", movie_path]);
        if has_watermark {
            cmd.args(["-i", &template.watermark.image_path]);
        }
        if !structural_filters.is_empty() {
            cmd.args(["-filter_complex", &structural_filters.join(";")]);
            cmd.args(["-map", &format!("[{structural_out}]"), "-map", "0:a?"]);
        } else {
            cmd.args(["-map", "0:v", "-map", "0:a?"]);
        }
        cmd.args(["-c:v", codec, "-crf", &template.encoding.crf.to_string(), "-preset", &template.encoding.preset]);
        cmd.args(["-c:a", "aac", "-b:a", &template.encoding.audio_bitrate]);
        cmd.arg(output_path);
        let output = cmd.output().map_err(|e| format!("failed to run ffmpeg: {e}"))?;
        for t in &overlay_temps {
            let _ = std::fs::remove_file(t);
        }
        if !output.status.success() {
            return Err(format!("ffmpeg failed: {}", String::from_utf8_lossy(&output.stderr)));
        }
        return Ok(());
    }

    if structural_filters.is_empty() {
        let mut cmd = Command::new(&ffmpeg);
        with_fontconfig_env(&mut cmd);
        cmd.current_dir(&temp_dir);
        cmd.args(["-y", "-ss", &start_seconds.to_string(), "-to", &end_seconds.to_string(), "-i", movie_path]);
        cmd.args(["-vf", &overlay_chain]);
        cmd.args(["-c:v", codec, "-crf", &template.encoding.crf.to_string(), "-preset", &template.encoding.preset]);
        cmd.args(["-c:a", "aac", "-b:a", &template.encoding.audio_bitrate]);
        cmd.arg(output_path);
        let output = cmd.output().map_err(|e| format!("failed to run ffmpeg: {e}"))?;
        for t in &overlay_temps {
            let _ = std::fs::remove_file(t);
        }
        if !output.status.success() {
            return Err(format!("ffmpeg failed: {}", String::from_utf8_lossy(&output.stderr)));
        }
        return Ok(());
    }

    let pass1_name = format!("cf_pass1_{ts}.mkv");
    let pass1_path = temp_dir.join(&pass1_name);

    {
        let mut cmd = Command::new(&ffmpeg);
        with_fontconfig_env(&mut cmd);
        cmd.current_dir(&temp_dir);
        cmd.args(["-y", "-ss", &start_seconds.to_string(), "-to", &end_seconds.to_string(), "-i", movie_path]);
        if has_watermark {
            cmd.args(["-i", &template.watermark.image_path]);
        }
        cmd.args(["-filter_complex", &structural_filters.join(";")]);
        cmd.args(["-map", &format!("[{structural_out}]"), "-map", "0:a?"]);
        cmd.args(["-c:v", "libx264", "-crf", "14", "-preset", "ultrafast"]);
        cmd.args(["-c:a", "copy"]);
        cmd.arg(&pass1_name);
        let output = cmd.output().map_err(|e| {
            let _ = std::fs::remove_file(&pass1_path);
            for t in &overlay_temps {
                let _ = std::fs::remove_file(t);
            }
            format!("failed to run ffmpeg (pass 1): {e}")
        })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let _ = std::fs::remove_file(&pass1_path);
            for t in &overlay_temps {
                let _ = std::fs::remove_file(t);
            }
            return Err(format!("ffmpeg failed (pass 1): {stderr}"));
        }
    }

    let result = {
        let mut cmd = Command::new(&ffmpeg);
        with_fontconfig_env(&mut cmd);
        cmd.current_dir(&temp_dir);
        cmd.args(["-y", "-i", &pass1_name]);
        cmd.args(["-vf", &overlay_chain]);
        cmd.args(["-c:v", codec, "-crf", &template.encoding.crf.to_string(), "-preset", &template.encoding.preset]);
        cmd.args(["-c:a", "aac", "-b:a", &template.encoding.audio_bitrate]);
        cmd.arg(output_path);
        let output = cmd.output().map_err(|e| format!("failed to run ffmpeg (pass 2): {e}"))?;
        if !output.status.success() {
            Err(format!("ffmpeg failed (pass 2): {}", String::from_utf8_lossy(&output.stderr)))
        } else {
            Ok(())
        }
    };

    let _ = std::fs::remove_file(&pass1_path);
    for t in &overlay_temps {
        let _ = std::fs::remove_file(t);
    }
    result
}