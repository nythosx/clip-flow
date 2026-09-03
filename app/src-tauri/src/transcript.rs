// Transcript parser (SPEC.md section 7): SRT, VTT, and plain-text formats, auto-detected
// by file extension first, falling back to content sniffing.
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptFormat {
    Srt,
    Vtt,
    Plain,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TranscriptEntry {
    pub start: f64, // seconds
    pub end: f64,   // seconds (may equal start for plain text)
    pub text: String,
}

/// Parses "HH:MM:SS,mmm" / "HH:MM:SS.mmm" / "HH:MM:SS" / "MM:SS" into seconds.
pub fn parse_timestamp(raw: &str) -> Option<f64> {
    let raw = raw.trim();
    let (main, millis) = match raw.split_once([',', '.']) {
        Some((m, f)) => (m, f.chars().take(3).collect::<String>().parse::<f64>().ok()),
        None => (raw, None),
    };
    let parts: Vec<&str> = main.split(':').collect();
    let (h, m, s) = match parts.as_slice() {
        [h, m, s] => (h.parse::<f64>().ok()?, m.parse::<f64>().ok()?, s.parse::<f64>().ok()?),
        [m, s] => (0.0, m.parse::<f64>().ok()?, s.parse::<f64>().ok()?),
        _ => return None,
    };
    let frac = millis.map(|ms| ms / 1000.0).unwrap_or(0.0);
    Some(h * 3600.0 + m * 60.0 + s + frac)
}

fn parse_timestamp_range(line: &str) -> Option<(f64, f64)> {
    let (start_raw, end_raw) = line.split_once("-->")?;
    let start = parse_timestamp(start_raw)?;
    // The end side may carry trailing cue settings (VTT), e.g. "00:00:05.000 align:start".
    let end_raw = end_raw.split_whitespace().next()?;
    let end = parse_timestamp(end_raw)?;
    Some((start, end))
}

fn normalize_line_endings(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

fn split_blocks(content: &str) -> Vec<Vec<&str>> {
    content
        .split("\n\n")
        .map(|block| block.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>())
        .filter(|block| !block.is_empty())
        .collect()
}

/// Strips inline markup — WebVTT/SRT text lines commonly carry styling tags like `<i>`,
/// `<b>`, `<font color="...">`, `<c.classname>`, or per-word timestamp tags like
/// `<00:00:01.000>` — and decodes the handful of HTML entities exported alongside them.
/// Without this, burning the raw text into the frame (or showing it in the in-app preview)
/// puts literal "<i>"/"&amp;" on screen instead of the styling/character it represents.
fn strip_markup(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .trim()
        .to_string()
}

fn parse_srt(content: &str) -> Vec<TranscriptEntry> {
    let normalized = normalize_line_endings(content);
    let mut entries = Vec::new();
    for block in split_blocks(&normalized) {
        // Block shape: [index, "00:00:00,000 --> 00:00:05,000", text..., text...]
        // (the index line is optional/malformed in some exports — search for the arrow
        // line rather than assuming it's always line 1.)
        let Some(ts_line_idx) = block.iter().position(|l| l.contains("-->")) else { continue };
        let Some((start, end)) = parse_timestamp_range(block[ts_line_idx]) else { continue };
        let text = strip_markup(&block[ts_line_idx + 1..].join("\n"));
        if !text.is_empty() {
            entries.push(TranscriptEntry { start, end, text });
        }
    }
    entries
}

fn parse_vtt(content: &str) -> Vec<TranscriptEntry> {
    let normalized = normalize_line_endings(content);
    // Strip the WEBVTT header block (and any NOTE blocks) — everything else has the same
    // cue shape as SRT: optional identifier line, timestamp line, text lines.
    let mut entries = Vec::new();
    for block in split_blocks(&normalized) {
        let Some(ts_line_idx) = block.iter().position(|l| l.contains("-->")) else { continue };
        let Some((start, end)) = parse_timestamp_range(block[ts_line_idx]) else { continue };
        let text = strip_markup(&block[ts_line_idx + 1..].join("\n"));
        if !text.is_empty() {
            entries.push(TranscriptEntry { start, end, text });
        }
    }
    entries
}

/// Matches a leading `[HH:MM:SS]` or `HH:MM:SS -` / `HH:MM:SS:` prefix on a line.
fn parse_plain_line(line: &str) -> Option<(f64, String)> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix('[') {
        let (ts, after) = rest.split_once(']')?;
        let start = parse_timestamp(ts)?;
        return Some((start, after.trim_start_matches([' ', '-', ':']).trim().to_string()));
    }
    // "HH:MM:SS - text" or "HH:MM:SS: text" or "HH:MM:SS text"
    let ts_end = line
        .char_indices()
        .find(|(_, c)| !(c.is_ascii_digit() || *c == ':' || *c == '.' || *c == ','))
        .map(|(i, _)| i)
        .unwrap_or(line.len());
    if ts_end == 0 {
        return None;
    }
    let ts_candidate = &line[..ts_end];
    if !ts_candidate.contains(':') {
        return None; // not timestamp-shaped — avoid false positives on plain prose
    }
    let start = parse_timestamp(ts_candidate)?;
    let rest = line[ts_end..].trim_start_matches([' ', '-', ':']).trim();
    if rest.is_empty() {
        return None;
    }
    Some((start, rest.to_string()))
}

fn parse_plain(content: &str) -> Vec<TranscriptEntry> {
    normalize_line_endings(content)
        .lines()
        .filter_map(parse_plain_line)
        .map(|(start, text)| TranscriptEntry { start, end: start, text: strip_markup(&text) })
        .filter(|e| !e.text.is_empty())
        .collect()
}

pub fn detect_format(path: &Path, content: &str) -> TranscriptFormat {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()) {
        Some(ext) if ext == "srt" => return TranscriptFormat::Srt,
        Some(ext) if ext == "vtt" => return TranscriptFormat::Vtt,
        _ => {}
    }
    let trimmed = content.trim_start();
    if trimmed.starts_with("WEBVTT") {
        TranscriptFormat::Vtt
    } else if trimmed.lines().take(5).any(|l| l.contains("-->") && l.contains(',')) {
        TranscriptFormat::Srt
    } else {
        TranscriptFormat::Plain
    }
}

/// Shifts every entry's start/end by a constant `offset_seconds` (positive = later, negative
/// = earlier) — the manual correction for a transcript that's out of sync with the movie
/// file it's paired with (see commands::project::get_transcript_sync_status /
/// set_transcript_offset). Clamped at 0 rather than going negative.
pub fn apply_offset(entries: &mut [TranscriptEntry], offset_seconds: f64) {
    for entry in entries.iter_mut() {
        entry.start = (entry.start + offset_seconds).max(0.0);
        entry.end = (entry.end + offset_seconds).max(0.0);
    }
}

/// Transcript entries overlapping `[clip_start, clip_end)`, shifted to clip-relative
/// seconds — shared by the final-render subtitle burn-in (ffmpeg drawtext `enable` windows)
/// and the in-app live preview (time-gated by the `<video>`'s currentTime), so both agree on
/// exactly which line is on screen at a given instant.
pub fn compute_cues(entries: &[TranscriptEntry], clip_start: f64, clip_end: f64) -> Vec<(f64, f64, String)> {
    let mut entries = entries.to_vec();
    entries.sort_by(|a, b| a.start.total_cmp(&b.start));
    let n = entries.len();
    (0..n)
        .filter_map(|i| {
            let entry = &entries[i];
            // Plain-text transcripts have no real end timestamp — every entry comes out
            // with `end == start`. Display it until the next line starts (capped at 6s so
            // a long silent gap doesn't leave a stale line on screen) instead.
            let effective_end = if entry.end > entry.start {
                entry.end
            } else {
                let next_start = entries.get(i + 1).map(|next| next.start);
                next_start.map(|s| s.min(entry.start + 6.0)).unwrap_or(entry.start + 6.0)
            };
            if effective_end <= clip_start || entry.start >= clip_end {
                return None;
            }
            let shifted_start = (entry.start - clip_start).max(0.0);
            let shifted_end = (effective_end - clip_start).min(clip_end - clip_start);
            Some((shifted_start, shifted_end.max(shifted_start + 0.05), entry.text.clone()))
        })
        .collect()
}

/// Formats seconds as "HH:MM:SS" — the timestamp shape SPEC.md's AI prompts use.
pub fn format_timestamp(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as i64;
    format!("{:02}:{:02}:{:02}", total / 3600, (total % 3600) / 60, total % 60)
}

pub fn parse_transcript(path: &Path) -> Result<(TranscriptFormat, Vec<TranscriptEntry>), String> {
    let content = std::fs::read_to_string(path).map_err(|e| format!("failed to read transcript: {e}"))?;
    let format = detect_format(path, &content);
    let entries = match format {
        TranscriptFormat::Srt => parse_srt(&content),
        TranscriptFormat::Vtt => parse_vtt(&content),
        TranscriptFormat::Plain => parse_plain(&content),
    };
    Ok((format, entries))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_srt() {
        let content = "1\n00:00:00,000 --> 00:00:02,500\nHello there.\n\n2\n00:00:02,500 --> 00:00:05,000\nGeneral Kenobi.\n";
        let entries = parse_srt(content);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].start, 0.0);
        assert_eq!(entries[0].end, 2.5);
        assert_eq!(entries[0].text, "Hello there.");
        assert_eq!(entries[1].text, "General Kenobi.");
    }

    #[test]
    fn parses_vtt() {
        let content = "WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nHello there.\n\n00:00:02.500 --> 00:00:05.000 align:start\nGeneral Kenobi.\n";
        let entries = parse_vtt(content);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].end, 2.5);
        assert_eq!(entries[1].text, "General Kenobi.");
    }

    #[test]
    fn parses_plain_bracket_format() {
        let content = "[00:00:00] Studio logo.\n[00:02:15] The movie begins...\n";
        let entries = parse_plain(content);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].start, 0.0);
        assert_eq!(entries[0].text, "Studio logo.");
        assert_eq!(entries[1].start, 135.0);
        assert_eq!(entries[1].text, "The movie begins...");
    }

    #[test]
    fn parses_plain_dash_format() {
        let content = "00:00:00 - Studio logo.\n00:02:15 - The movie begins...\n";
        let entries = parse_plain(content);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].text, "Studio logo.");
        assert_eq!(entries[1].start, 135.0);
    }

    #[test]
    fn detects_format_by_extension() {
        assert_eq!(detect_format(Path::new("a.srt"), ""), TranscriptFormat::Srt);
        assert_eq!(detect_format(Path::new("a.vtt"), ""), TranscriptFormat::Vtt);
        assert_eq!(detect_format(Path::new("a.txt"), "[00:00:00] hi"), TranscriptFormat::Plain);
    }

    #[test]
    fn detects_format_by_content_when_extension_unknown() {
        assert_eq!(detect_format(Path::new("a.txt"), "WEBVTT\n\n..."), TranscriptFormat::Vtt);
        assert_eq!(
            detect_format(Path::new("a.txt"), "1\n00:00:00,000 --> 00:00:02,000\nHi\n"),
            TranscriptFormat::Srt
        );
    }
}
