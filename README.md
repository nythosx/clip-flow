# ClipFlow

ClipFlow is a Windows desktop app (Tauri 2 — Rust backend, React/TypeScript frontend) that
turns a long-form video — a movie, a downloaded YouTube video, or any local file with a
transcript — into short, TikTok-ready vertical clips: cut, captioned, templated, and
uploaded, with an AI doing the creative judgment calls instead of a human manually
scrubbing a timeline.

## What problem it solves

Turning a 2-hour movie or a long YouTube video into a batch of short-form clips for TikTok
is normally a manual, repetitive job: find the good moments, cut them, write a caption for
each, brand them consistently, and upload them one by one. ClipFlow automates the entire
chain end-to-end on a single machine, for a single creator/small team managing their own
accounts — not a multi-tenant SaaS.

**Who it's for:** a solo creator or small team running one or more "movie clips" /
"TV recap" / "edit"-style TikTok (and secondarily YouTube/Facebook) accounts, who wants to
feed in raw source video and get a queue of ready-to-post short clips out.

## The core idea that shapes the whole product

**ClipFlow does not call a paid LLM API.** Instead, it drives the user's own logged-in
`chat.deepseek.com` browser session via a Chrome extension + native-messaging bridge, and
types prompts into it programmatically, the same way a human would.

- **Cost:** no per-token API billing — the "AI cost" is whatever DeepSeek's own web app
  allows for a logged-in user.
- **Trade-off:** requires Chrome running with the ClipFlow extension installed and a real
  DeepSeek chat session open; rate-limited to one AI call per 30 seconds minimum
  (deliberately, to look human); inherently coupled to DeepSeek's own web UI not changing
  underneath it.
- **No server, no accounts, no cloud.** ClipFlow is a fully local, single-user desktop app.
  Everything — video files, transcripts, templates, credentials, the SQLite database —
  lives on the user's own machine.

## The AI does exactly 4 jobs, nothing more

There is no open-ended agent/tool-use loop, no filesystem access from the AI side, no
arbitrary automation — every "AI Engine" call is one of these fixed functions:

1. **Smart Trimmer** — given a movie's transcript, identifies non-story content to remove
   (studio logos, opening/ending credits, credit songs).
2. **Clip Finder** — finds up to N highlight segments (30–90s each) most likely to hook a
   TikTok viewer, using DeepThink + web search for judgment quality.
3. **Caption Generator** — writes one on-screen hook caption per clip plus separate
   hashtags for the post.
4. **Movie Segmenter** — the "Full Movie" mode: splits the entire trimmed runtime into
   sequential Part 1 / Part 2 / … chunks at natural scene breaks.

Plus two on-demand review/growth passes: a **Caption Refiner** that reviews every caption
in a project together to catch cross-clip repetition and off-tone captions, and a
**Trending Hashtags** fetch (live web search, evergreen filler tags excluded).

Every AI call goes through the same reliability layer: JSON-shape validation with retry,
content-correction retries, a shared 30-second minimum delay between calls, chat-tab reuse
per project, and automatic chat migration once a conversation risks hitting DeepSeek's
context limits.

## End-to-end workflow

1. **Bring in a source video** — a local file + transcript, or search/import/transcribe
   directly from YouTube.
2. **Analyze** — Clips mode (Smart Trimmer → Clip Finder → auto-captions) or Full Movie
   mode (Smart Trimmer → Movie Segmenter → auto-captions), cancellable with live progress.
3. **Review and edit clips** — a CapCut-style editor: project switcher, video preview,
   clip/part timeline, editable AI caption plus a separate manual-caption field.
4. **Design a template** — a Konva-based visual canvas (crop/fill/zoom/stretch with a
   focus-point anchor, mirror/flip/rotate, watermark, up to two caption overlays) whose
   layout is mirrored pixel-for-pixel by the actual FFmpeg render.
5. **Render** — a fast raw trim for in-app preview, and a full templated render (crop,
   watermark, caption burn-in via FFmpeg `drawtext`, encode) applied automatically when a
   clip is queued for upload.
6. **Queue and upload** — per-account concurrency, automatic retry, pause/resume, and a
   one-click **Auto Upload** pipeline (slice → caption → render → queue) behind an explicit
   confirmation dialog.

## Platform integrations

- **TikTok** — real OAuth connect + Content Posting API, correct chunked upload (5–64MB
  chunks), status polling, and a `title` built from project name + deduped hashtags.
  Currently posts as sandbox-only (`SELF_ONLY`) pending TikTok's App Review for public
  posting.
- **YouTube** — search, import, download (via `yt-dlp`) as a source; OAuth connect; upload
  automation in the queue processor.
- **Facebook** — OAuth connects a personal profile and every managed Page in one flow;
  posting automation exists (personal-profile posting needs Meta App Review outside the
  app's own testers).
- Every network-dependent action disables itself with an explanatory tooltip when offline.
  Queueing an upload is the deliberate exception (a local DB write, always allowed offline);
  uploads that fail purely from a dropped connection are tagged and auto-retried once back
  online.

## Other product surfaces

- **Accounts** — connect/reconnect/remove per platform, inline stats where the platform's
  API scope allows it.
- **Templates** — a template library independent of any one project, reusable across
  projects.
- **Settings** — per-platform developer app credentials, default template, default encoding
  profile, storage path.
- **Downloads tray** — a persistent panel tracking YouTube import progress with
  pause/resume/cancel.
- **Delete project** — gated behind an explicit confirmation modal; permanently deletes the
  project, its clips/parts, and rendered files (does not touch anything already posted).

## Known, deliberate current limitations

- TikTok public posting is capped by TikTok's own App Review approval, not by ClipFlow.
- Facebook personal-profile posting is capped the same way by Meta App Review.
- Downloading from YouTube requires `yt-dlp` present on the system `PATH` — not bundled.
- The AI Engine is coupled to `chat.deepseek.com`'s current web UI; no fallback provider
  today.
- A broken account (bad token, real API rejection) needs a manual "Retry" click, by design
  — it isn't silently retried forever.
- Single-user, single-machine only — no multi-user accounts, no cloud sync, no mobile
  companion.

## Tech stack

Tauri 2 (Rust) desktop shell · SQLite (`rusqlite`) for all local state · React 19 +
Zustand + React Router + Tailwind 4 frontend · Konva / `react-konva` for the visual
template canvas · FFmpeg (external binary) for trimming/cropping/watermarking/caption
burning/encoding · `reqwest` for TikTok/YouTube/Facebook API calls · a Chrome MV3 extension
+ native-messaging host bridging Rust to a live DeepSeek browser tab for every AI call.

## Project structure

```
app/            Tauri desktop app — Rust backend (src-tauri) + React/TS frontend (src)
extension/      Chrome MV3 extension that drives the DeepSeek chat session
native-host/    Native-messaging bridge between the extension and the Rust backend
cli/            AI Engine orchestration CLI used by the native host
fake-backend/   Mock chat.deepseek.com UI + scripted responses, for local dev without
                needing a live DeepSeek session
shared/         Code shared across the extension/native-host/CLI
test/           End-to-end scripts
```

## Getting started

Requirements: Node.js, `pnpm`, Rust + the Tauri CLI prerequisites for your platform,
FFmpeg on `PATH`, and `yt-dlp` on `PATH` if you want YouTube import.

```bash
cd app
pnpm install
pnpm tauri dev
```

The Chrome extension (`extension/`) and native-messaging host (`native-host/`) need to be
loaded/installed separately — see `native-host/install.js` for registering the native
messaging manifest, and Chrome's "Load unpacked" for the extension.

## License

All rights reserved. This repository is shared for portfolio/demonstration purposes.
