// Drives ClipFlow's 3 fixed AI functions (Smart Trimmer, Clip Finder, Caption Generator —
// SPEC.md section 6) against a single DeepSeek chat tab per call, reusing a live session's
// tab across repeated calls (e.g. many Caption Generator calls for one project) when a
// `sessionKey` is supplied. Each call is a single prompt -> single response round trip, not
// a multi-turn planner/executor loop — there is no tool-calling, no quality gates, no
// filesystem access from the browser side (Rust owns that).

const Orchestrator = (() => {
  const DEFAULT_MIGRATION_THRESHOLD = 40;
  const DEFAULT_MIN_AI_CALL_INTERVAL_MS = 30000;
  const SESSION_STORAGE_PREFIX = 'ai-session:';

  // sessionKey -> { tabId, purpose, msgCount }
  const sessions = new Map();

  // Non-terminal progress narration for one AI call — see protocol.js's AI_STATUS doc
  // comment. Best-effort: NativeBridge always exists in this shared service-worker scope by
  // the time Orchestrator runs, but never let a status ping itself break the actual call.
  function reportStatus(requestId, message) {
    try {
      NativeBridge.sendToCli({ type: AI_MESSAGE_TYPES.AI_STATUS, requestId, message });
    } catch (err) {
      console.warn('[Orchestrator] reportStatus failed', err);
    }
  }

  // Enforced across ALL sessions/purposes, per SPEC.md section 6 ("Minimum 30-second delay
  // between AI calls") — a single shared gate, not per-session, since it's meant to bound
  // total request rate against chat.deepseek.com.
  let lastAiCallAt = 0;
  async function enforceMinDelay(minIntervalMs) {
    const wait = lastAiCallAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastAiCallAt = Date.now();
  }

  function sessionStorageKey(sessionKey) {
    return `${SESSION_STORAGE_PREFIX}${sessionKey}`;
  }

  async function saveSession(sessionKey, session) {
    await chrome.storage.local.set({
      [sessionStorageKey(sessionKey)]: {
        tabId: session.tabId,
        purpose: session.purpose,
        msgCount: session.msgCount,
        urlTaskId: session.urlTaskId,
        savedAt: Date.now(),
      },
    });
  }

  async function loadSavedSession(sessionKey) {
    const key = sessionStorageKey(sessionKey);
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  }

  async function clearSavedSession(sessionKey) {
    await chrome.storage.local.remove(sessionStorageKey(sessionKey));
  }

  async function tabStillAlive(tabId) {
    if (typeof tabId !== 'number') return false;
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Used by the CLI's --close-session mode (or a future "abandon this project's AI chats"
  // action) — does not touch any currently in-flight call.
  async function closeSession(sessionKey) {
    let session = sessions.get(sessionKey);
    if (!session) {
      const saved = await loadSavedSession(sessionKey);
      if (!saved) return { closed: false, reason: 'no saved session for this key' };
      session = saved;
    }
    await TabManager.closeTabs(session.tabId);
    sessions.delete(sessionKey);
    await clearSavedSession(sessionKey);
    return { closed: true };
  }

  // --- Prompt templates (SPEC.md section 6.A/B/C) -------------------------------------
  // Each is split into a `primer` (the static role/rules text, sent once when a chat tab
  // is first opened or re-primed after migration) and a per-call `task` (the variable
  // transcript/excerpt content). A freshly opened tab gets `${primer}\n\n${task}` as one
  // instant-pasted message; a reused live session just gets `task`.

  const TRIM_PRIMER =
    'You are analyzing a movie transcript with timestamps. Your job is to identify ' +
    "non-story content that should be removed.\n\nRules:\n- Remove opening studio " +
    'logos/credits (e.g., "20th Century Fox", "Universal Pictures")\n- Remove opening ' +
    "song sequences or title sequences that don't contain story\n- Remove ending credits " +
    'and end-credit songs\n- Keep the actual movie content intact';

  function trimTask({ duration, transcript }) {
    return (
      `Movie duration: ${duration}\n` +
      `Transcript (excerpt showing first 5 minutes and last 5 minutes):\n${transcript}\n\n` +
      'Return ONLY a JSON array of segments to REMOVE. Each segment has "start" (HH:MM:SS) ' +
      'and "end" (HH:MM:SS).\n' +
      'Example: [{"start": "00:00:00", "end": "00:02:15"}, {"start": "01:45:30", "end": "01:48:00"}]\n' +
      'If no removal needed, return [].'
    );
  }

  function clipFinderPrimer(count) {
    return (
      'You are a TikTok viral content strategist. Analyze this movie transcript and find ' +
      `up to ${count} segments that would keep viewers watching to the end.\n\n` +
      'Rules for each clip:\n' +
      '- Duration: 30-90 seconds (respect scene boundaries)\n' +
      '- Must have a strong hook in the first 3 seconds\n' +
      '- Should end with a cliffhanger, question, or emotional peak\n' +
      '- Prioritize: plot twists, intense confrontations, emotional reveals, funny moments, iconic lines\n' +
      '- Avoid: slow exposition, transitional scenes, dialogue without context\n' +
      '- Return fewer than the requested count if there are not enough genuinely strong ' +
      'moments — never pad the results with weak filler just to hit the count\n' +
      '- Clips must not overlap each other, and should be spread across the movie rather ' +
      'than clustered in one section\n' +
      '- Every "start" and "end" must exactly match a timestamp shown in the transcript ' +
      'below — never invent a time between two given timestamps'
    );
  }

  function clipFinderTask({ transcript }) {
    return (
      `Transcript:\n${transcript}\n\n` +
      'Return ONLY a JSON array. Each object: "start" (HH:MM:SS), "end" (HH:MM:SS), "hook" ' +
      '(short reason why this clip works). Both "start" and "end" must be timestamps that ' +
      'appear verbatim in the transcript above.\n' +
      'Example: [{"start": "00:15:30", "end": "00:16:45", "hook": "Character reveals hidden identity - high shock value"}]'
    );
  }

  const CAPTION_PRIMER =
    'Write an on-screen hook caption (NOT a subtitle, one short line) for this TikTok movie ' +
    'clip. Optimize for the algorithm: the goal is to stop the scroll and maximize ' +
    'watch-through/completion rate.\n\nRequirements:\n' +
    '- Under 150 characters\n' +
    '- Informal, chaotic, "brain rot" internet tone — lowercase/slang/abbreviations are ' +
    'encouraged, this should read like a real Gen-Z TikTok caption, not a polished tagline\n' +
    '- Include a hook that creates curiosity or tension about what happens in the clip\n' +
    '- Do NOT use clickbait phrases like "wait till the end" (overused)\n' +
    '- Do NOT put any hashtags in the caption text itself — hashtags go in a separate field\n\n' +
    'Also suggest 3-5 relevant hashtags for the post (trending/algorithm-friendly ones where ' +
    'sensible) — these are saved separately for later use, not shown as on-screen text.';

  function captionTask({ excerpt, hook }) {
    return (
      `Clip context: ${hook}\nTranscript excerpt: ${excerpt}\n\n` +
      'Return ONLY a JSON object: {"caption": "...", "hashtags": ["...", "..."]}. The ' +
      '"caption" value must not contain any "#" characters.'
    );
  }

  // Fallback normalization regardless of how well the model followed the "no hashtags in
  // caption" instruction — strips any #tokens out of the caption text and folds them into
  // the hashtags list, so Rust always gets cleanly separated data.
  function normalizeCaptionResult(parsed) {
    const rawCaption = typeof parsed.caption === 'string' ? parsed.caption : '';
    const hashtagsInCaption = [...rawCaption.matchAll(/#\w+/g)].map((m) => m[0]);
    const caption = rawCaption
      .replace(/#\w+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const provided = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter((h) => typeof h === 'string') : [];
    const hashtags = [...new Set([...provided, ...hashtagsInCaption].map((h) => (h.startsWith('#') ? h : `#${h}`)))];
    return { caption, hashtags };
  }

  const CAPTION_REFINE_PRIMER =
    'You are quality-reviewing a BATCH of on-screen hook captions already generated for ' +
    'different clips cut from the same movie/project. Each one was written in isolation, ' +
    'so common problems only show up once you see them together: captions that repeat or ' +
    'closely resemble each other, ones that read like polished/formal writing instead of ' +
    'real TikTok slang, ones that are too long, and ones that are not actually optimized to ' +
    'stop the scroll and beat the algorithm.\n\n' +
    'For EVERY item in the batch, decide if it needs rewriting against these rules:\n' +
    '- Under 150 characters\n' +
    '- Informal, chaotic, "brain rot" internet tone — real Gen-Z TikTok slang, not a ' +
    'polished tagline or grammatically correct sentence\n' +
    '- A genuine hook: creates curiosity/tension about what happens in that specific clip\n' +
    '- Not clickbait filler like "wait till the end"\n' +
    '- Distinct from every other caption in this batch — if two are too similar, rewrite ' +
    'at least one so each clip has its own angle\n\n' +
    'Rewrite whichever captions fail any of these; leave the rest as-is. Return the FULL ' +
    'batch back either way — one output item per input item, same ids, same order is not ' +
    'required but every id must be present exactly once.';

  function captionRefineTask({ items }) {
    const list = items
      .map((it, i) => `${i + 1}. id="${it.id}"\n   transcript: ${it.excerpt || '(no transcript)'}\n   current caption: ${it.caption}`)
      .join('\n\n');
    return (
      `Batch of ${items.length} captions to review:\n\n${list}\n\n` +
      'Return ONLY a JSON array, one object per item: {"id": "...", "caption": "..."}. Every ' +
      'id listed above must appear exactly once. "caption" must not contain any "#" characters.'
    );
  }

  function validateCaptionRefineResult(parsed, task) {
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return 'you returned zero items — every id from the batch must come back with a caption.';
    }
    const idMatches = [...String(task).matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const expectedIds = new Set(idMatches);
    const seenIds = new Set();
    const seenCaptions = new Set();
    for (const item of parsed) {
      if (!item || typeof item.id !== 'string' || typeof item.caption !== 'string' || !item.caption.trim()) {
        return 'one or more items is missing a string "id" or non-empty "caption".';
      }
      if (item.caption.trim().length > 170) {
        return `the caption for id "${item.id}" is ${item.caption.trim().length} characters — keep it under 150.`;
      }
      if (/#\w/.test(item.caption)) {
        return `the caption for id "${item.id}" still contains a "#" hashtag — captions must not contain hashtags.`;
      }
      seenIds.add(item.id);
      const norm = item.caption.trim().toLowerCase();
      if (seenCaptions.has(norm)) {
        return `two or more items ended up with the exact same caption ("${item.caption.trim()}") — each clip needs a distinct hook.`;
      }
      seenCaptions.add(norm);
    }
    for (const id of expectedIds) {
      if (!seenIds.has(id)) {
        return `id "${id}" from the input batch is missing from your response — every id must come back.`;
      }
    }
    return null;
  }

  function runCaptionRefiner({ requestId, sessionKey, items, migrationThreshold, minAiCallIntervalMs }) {
    return runAiCall({
      requestId,
      sessionKey,
      purpose: 'caption-refine',
      primer: CAPTION_REFINE_PRIMER,
      task: captionRefineTask({ items }),
      responseShape: 'array',
      validate: validateCaptionRefineResult,
      deepThink: true,
      webSearch: true,
      timeoutMs: DEEP_REASONING_TIMEOUT_MS,
      migrationThreshold,
      minAiCallIntervalMs,
    });
  }

  const TRENDING_HASHTAGS_PRIMER =
    'You are a TikTok algorithm/growth strategist. List hashtags that are genuinely ' +
    'trending RIGHT NOW (use live/current knowledge, not generic evergreen tags) and would ' +
    'realistically help a short movie-clip/edit video get picked up by the For You Page ' +
    'algorithm.\n\n' +
    'Rules:\n' +
    '- Do NOT include always-on generic tags that carry no real trending signal: #fyp, ' +
    '#foryou, #foryoupage, #viral, #trending, #tiktok, #xyzbca, and similar — these are so ' +
    'overused they do nothing for reach\n' +
    '- Only include tags that are ACTUALLY trending at the moment (current challenges, ' +
    'sounds, formats, or topics), plus any that are specifically relevant to movie clips / ' +
    'edits / cinema content on TikTok right now\n' +
    '- 8-15 hashtags';

  function trendingHashtagsTask({ niche }) {
    return (
      `Content niche: ${niche || 'short movie/TV clips and edits posted to TikTok'}\n\n` +
      'Return ONLY a JSON array of hashtag strings (each starting with "#"), no other text.\n' +
      'Example: ["#movieedits", "#cinephile", "#plottwist"]'
    );
  }

  function validateTrendingHashtags(parsed) {
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return 'you returned zero hashtags.';
    }
    const banned = new Set(['#fyp', '#foryou', '#foryoupage', '#viral', '#trending', '#tiktok', '#xyzbca']);
    for (const tag of parsed) {
      if (typeof tag !== 'string' || !tag.trim()) {
        return 'one or more entries is not a non-empty string.';
      }
      if (banned.has(tag.trim().toLowerCase())) {
        return `"${tag}" is a generic evergreen tag with no real trending signal — exclude tags like #fyp/#foryou/#viral/#trending and only return ones actually trending right now.`;
      }
    }
    return null;
  }

  function runTrendingHashtags({ requestId, sessionKey, niche, migrationThreshold, minAiCallIntervalMs }) {
    return runAiCall({
      requestId,
      sessionKey,
      purpose: 'trending-hashtags',
      primer: TRENDING_HASHTAGS_PRIMER,
      task: trendingHashtagsTask({ niche }),
      responseShape: 'array',
      validate: validateTrendingHashtags,
      deepThink: true,
      webSearch: true, // trending-right-now data needs live search, not the model's training cutoff
      timeoutMs: DEEP_REASONING_TIMEOUT_MS,
      migrationThreshold,
      minAiCallIntervalMs,
    }).then((tags) =>
      tags.map((t) => (t.startsWith('#') ? t.trim() : `#${t.trim()}`))
    );
  }

  // "Full Movie" mode: split the whole (already-trimmed) runtime into sequential Part 1,
  // Part 2, ... chunks at natural scene/topic breaks, instead of picking best moments.
  const MOVIE_SEGMENTER_PRIMER =
    'You are splitting a movie transcript into sequential parts for a multi-part video ' +
    "series (Part 1, Part 2, etc). The transcript has already had its intro/credits " +
    'removed — do not skip any more content.\n\nRules:\n' +
    '- The parts must be contiguous and cover the ENTIRE transcript with no gaps: the ' +
    '"start" of part N+1 must equal the "end" of part N, the first part\'s "start" must ' +
    "be the transcript's first timestamp, and the last part's \"end\" must be the " +
    "transcript's last timestamp\n" +
    '- Split at natural scene or topic changes, not at an arbitrary fixed interval\n' +
    '- Aim for roughly 3-8 minutes per part, but prioritize a natural break over hitting ' +
    'an exact length\n' +
    '- Every "start" and "end" must exactly match a timestamp shown in the transcript ' +
    'below — never invent a time between two given timestamps';

  function movieSegmenterTask({ duration, transcript }) {
    return (
      `Movie duration: ${duration}\n` +
      `Transcript:\n${transcript}\n\n` +
      'Return ONLY a JSON array of sequential parts. Each object: "start" (HH:MM:SS), "end" ' +
      '(HH:MM:SS).\n' +
      'Example: [{"start": "00:00:00", "end": "00:05:20"}, {"start": "00:05:20", "end": "00:11:47"}]'
    );
  }

  function hmsToSeconds(hms) {
    const parts = String(hms).split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  // Pulls the first/last "[HH:MM:SS]" markers out of the same "[timestamp] text" transcript
  // string the task prompt embeds, giving a ground-truth runtime to validate against
  // without needing the caller to pass duration separately in a parseable form.
  function transcriptTimestampBounds(transcript) {
    const matches = [...String(transcript).matchAll(/\[(\d{1,2}:\d{2}:\d{2})\]/g)];
    if (matches.length === 0) return null;
    return { firstHms: matches[0][1], lastHms: matches[matches.length - 1][1] };
  }

  // Catches the two failure modes actually observed against the real site: (1) DeepSeek
  // treating this like Smart Trimmer and returning a single segment instead of a cut-by-cut
  // breakdown of the whole runtime, and (2) gaps/overlaps between parts. ~8 min/part (the
  // primer's own upper bound) sets the minimum expected part count for a movie of this
  // length; a real answer should usually beat that minimum since it's meant to pick natural
  // (often shorter) scene breaks, not the longest allowed chunk every time.
  function validateMovieSegments(parts, task) {
    if (!Array.isArray(parts) || parts.length === 0) {
      return 'you returned zero parts. Split the ENTIRE transcript into sequential parts, not a single block.';
    }
    const bounds = transcriptTimestampBounds(task);
    if (!bounds) return null; // nothing to check coverage against; accept on shape alone

    const firstSeconds = hmsToSeconds(bounds.firstHms);
    const lastSeconds = hmsToSeconds(bounds.lastHms);
    if (firstSeconds == null || lastSeconds == null) return null;
    const totalSeconds = lastSeconds - firstSeconds;

    const minParts = Math.max(2, Math.floor(totalSeconds / 60 / 8));
    if (parts.length < minParts) {
      return (
        `you only returned ${parts.length} part(s) for a ~${Math.round(totalSeconds / 60)}-minute transcript. ` +
        `That is one block, not a cut-by-cut breakdown. Split it into many more sequential parts ` +
        `(roughly 3-8 minutes each, at natural scene breaks) covering the entire transcript.`
      );
    }

    const withSeconds = parts
      .map((p) => ({ start: hmsToSeconds(p && p.start), end: hmsToSeconds(p && p.end) }))
      .filter((p) => p.start != null && p.end != null)
      .sort((a, b) => a.start - b.start);
    if (withSeconds.length !== parts.length) {
      return 'one or more parts had a missing or unparseable "start"/"end" timestamp.';
    }

    const TOLERANCE_SECONDS = 15;
    if (Math.abs(withSeconds[0].start - firstSeconds) > TOLERANCE_SECONDS) {
      return `your first part must start at ${bounds.firstHms} (the transcript's first timestamp).`;
    }
    const last = withSeconds[withSeconds.length - 1];
    if (Math.abs(last.end - lastSeconds) > TOLERANCE_SECONDS) {
      return `your last part must end at ${bounds.lastHms} (the transcript's last timestamp).`;
    }
    for (let i = 1; i < withSeconds.length; i++) {
      const gap = withSeconds[i].start - withSeconds[i - 1].end;
      if (Math.abs(gap) > TOLERANCE_SECONDS) {
        return (
          `there is a gap or overlap between part ${i} (ending ${parts[i - 1].end}) and part ${i + 1} ` +
          `(starting ${parts[i].start}). Parts must be contiguous with no gaps or overlaps.`
        );
      }
    }
    return null;
  }

  // Only accepts a caption on the first attempt if it actually meets the primer's own
  // rules — otherwise the corrective retry (built into runAiCall) fires with the specific
  // reason, instead of just saving whatever came back.
  function validateCaptionResult(parsed) {
    if (!parsed || typeof parsed.caption !== 'string' || !parsed.caption.trim()) {
      return 'no non-empty "caption" string field was returned.';
    }
    const caption = parsed.caption.trim();
    if (caption.length > 170) {
      return `the caption is ${caption.length} characters — keep it under 150.`;
    }
    if (/#\w/.test(caption)) {
      return 'the caption text still contains a "#" hashtag — hashtags must go in the separate "hashtags" field, not in the caption text.';
    }
    if (!Array.isArray(parsed.hashtags) || parsed.hashtags.length === 0) {
      return 'no "hashtags" array was returned — include 3-5 relevant hashtags in that field.';
    }
    return null;
  }

  // DeepThink (extended reasoning) responses take much longer than a normal reply —
  // content.js's default 60s stabilization timeout is tuned for ordinary calls and would
  // false-positive "timed out" mid-thought on these.
  const DEEP_REASONING_TIMEOUT_MS = 6 * 60 * 1000;

  // --- Session-scoped send + auto-migrate ----------------------------------------------

  // Gets a live session for `sessionKey`, creating (or reattaching to) a chat tab if
  // needed, then sends `task` (priming the tab with `primer` first if it's new). Returns
  // the raw response text. `deepThink`/`webSearch` are only applied once, right after a
  // brand-new tab is created — a reused/reattached session already has whatever toggle
  // state its tab was left in, so there's nothing to re-apply.
  // Opens a brand-new chat tab, waits for its content script, primes it with
  // `${primer}\n\n${task}`, and saves it as the session for `sessionKey`. Used both for a
  // genuinely first call AND as the fallback when a reused tab turns out to be dead (see
  // sendToSession below) — a tab existing (tabStillAlive) is not the same as its content
  // script actually being reachable (waitForReady can still time out on a live-but-orphaned
  // tab, e.g. right after the extension itself was reloaded, which severs every previously
  // injected content script's connection to the new background worker instance until that
  // page is reloaded — no amount of retrying sendMessage recovers it, only a fresh tab does).
  async function startFreshSession(sessionKey, purpose, primer, task, requestId, opts) {
    const { deepThink, webSearch, timeoutMs } = opts;
    reportStatus(requestId, 'Opening a new AI chat tab…');
    const tabId = await TabManager.createChatTab(purpose, requestId);
    await TabManager.waitForReady(tabId);
    if (deepThink || webSearch) await TabManager.setToggles(tabId, { deepThink, webSearch });
    const session = { tabId, purpose, msgCount: 0, urlTaskId: requestId };
    sessions.set(sessionKey, session);
    reportStatus(requestId, 'Tab ready — sending prompt…');
    const res = await TabManager.sendToTab(tabId, {
      action: 'typeAndSend',
      text: `${primer}\n\n${task}`,
      instant: true,
      timeoutMs,
    });
    // content.js catches its own errors (e.g. couldn't find the send button, a
    // stabilization timeout) and resolves with `{error}` instead of rejecting the
    // sendMessage promise — without this check `res.text` silently becomes `undefined`
    // and the crash surfaces much later as a confusing "Cannot read properties of
    // undefined (reading 'trim')" instead of the real cause.
    if (res.error) throw new Error(res.error);
    reportStatus(requestId, 'Response received — parsing…');
    session.msgCount = 1;
    await saveSession(sessionKey, session);
    return res.text;
  }

  async function sendToSession(sessionKey, purpose, primer, task, requestId, opts = {}) {
    const { deepThink = false, webSearch = false, timeoutMs } = opts;
    const sessionOpts = { deepThink, webSearch, timeoutMs };
    let session = sessions.get(sessionKey);
    if (!session) {
      // Not in this service worker's memory (e.g. it just restarted) — check whether a
      // previous run left a still-open tab for this sessionKey and reattach to it instead
      // of starting a whole new conversation. This is SPEC.md section 6's "new tab or
      // reuse session" for the AI Engine.
      const saved = await loadSavedSession(sessionKey);
      if (saved && (await tabStillAlive(saved.tabId))) {
        session = saved;
        sessions.set(sessionKey, session);
      }
    }
    if (session && !(await tabStillAlive(session.tabId))) {
      session = null; // tab was closed out from under us — start fresh
    }

    if (!session) {
      return startFreshSession(sessionKey, purpose, primer, task, requestId, sessionOpts);
    }

    // A reused tab passing tabStillAlive only means chrome.tabs.get succeeded — the tab
    // still exists — not that its content script is actually reachable right now. Try to
    // wait it out (handles an ordinary reload/re-injection race); if that times out, the
    // tab is a lost cause (most commonly: the extension itself was reloaded, orphaning
    // every previously-injected content script) — discard it and fall back to a fresh tab
    // instead of failing the whole call.
    try {
      await TabManager.waitForReady(session.tabId);
    } catch (err) {
      console.warn(`[Orchestrator] session "${sessionKey}"'s tab ${session.tabId} never became ready (${err.message}); starting a fresh tab instead.`);
      await TabManager.closeTabs(session.tabId);
      sessions.delete(sessionKey);
      await clearSavedSession(sessionKey);
      return startFreshSession(sessionKey, purpose, primer, task, requestId, sessionOpts);
    }
    reportStatus(requestId, 'Sending prompt to existing chat…');
    const res = await TabManager.sendToTab(session.tabId, { action: 'typeAndSend', text: task, timeoutMs });
    if (res.error) throw new Error(res.error);
    reportStatus(requestId, 'Response received — parsing…');
    session.msgCount++;
    await saveSession(sessionKey, session);
    return res.text;
  }

  // Edits the session's last message with `newText` and waits for the corrected reply —
  // shared by the JSON-reformat retry (SPEC.md section 6) and the response-validation
  // retry below, which differ only in what correction text they send.
  async function editLastMessage(sessionKey, newText, timeoutMs) {
    const session = sessions.get(sessionKey);
    const lastIndex = Math.max(0, session.msgCount - 1);
    // Same race as sendToSession's reused-tab path — see that call's comment.
    await TabManager.waitForReady(session.tabId);
    const res = await TabManager.sendToTab(session.tabId, {
      action: 'editMessage',
      index: lastIndex,
      newText,
      timeoutMs,
    });
    if (res.error) throw new Error(res.error);
    return res.text;
  }

  // Chat migration: when a session's message count nears the chat length limit, summarize
  // the conversation (by editing the 3rd-last message so the edit's reply IS the summary),
  // close the old tab, open a fresh one, and re-prime it with that summary so the next call
  // on this sessionKey continues seamlessly.
  async function migrate(sessionKey, primer, opts = {}, requestId) {
    const { deepThink = false, webSearch = false, timeoutMs } = opts;
    reportStatus(requestId, 'Conversation getting long — migrating to a fresh tab…');
    const session = sessions.get(sessionKey);
    const oldTabId = session.tabId;
    const editIndex = Math.max(0, session.msgCount - 3);

    const migrationPrompt =
      'IGNORE ALL PREVIOUS CONVERSATION UP TO THIS POINT. Summarize all decisions, ' +
      'current state, what has been achieved so far, what remains, and any critical ' +
      'notes. Then provide a concise set of instructions for a new AI to continue from ' +
      'exactly this point. Do not include any other text.';

    // Same content-script-readiness race as sendToSession/editLastMessage — this old tab
    // has been sitting alive across possibly many prior calls, so it's no less exposed.
    await TabManager.waitForReady(oldTabId);
    const editRes = await TabManager.sendToTab(oldTabId, {
      action: 'editMessage',
      index: editIndex,
      newText: migrationPrompt,
      timeoutMs,
    });
    if (editRes.error) throw new Error(editRes.error);
    const summary = editRes.text;

    await TabManager.closeTabs(oldTabId);
    // Reuse the same urlTaskId the session started with (rather than minting a new one) so
    // a scripted/mock backend that tracks conversation turns by that id sees one continuous
    // conversation across the migration, matching how a real re-primed chat continues the
    // same underlying task even though it's a new page.
    const newTabId = await TabManager.createChatTab(session.purpose, session.urlTaskId);
    await TabManager.waitForReady(newTabId);
    if (deepThink || webSearch) await TabManager.setToggles(newTabId, { deepThink, webSearch });

    const primeRes = await TabManager.sendToTab(newTabId, {
      action: 'typeAndSend',
      text: `${primer}\n\nPrevious summary:\n${summary}\n\nContinue from here.`,
      instant: true,
      timeoutMs,
    });
    if (primeRes.error) throw new Error(primeRes.error);

    session.tabId = newTabId;
    session.msgCount = 1;
    await saveSession(sessionKey, session);
  }

  async function maybeMigrate(sessionKey, primer, migrationThreshold, opts, requestId) {
    const session = sessions.get(sessionKey);
    if (session.msgCount >= migrationThreshold) {
      await migrate(sessionKey, primer, opts, requestId);
    }
  }

  // Runs one AI call end-to-end: rate-limit, send/create session, parse (with one
  // reformat-as-JSON retry), validate the parsed content if a `validate` check was given
  // (with one corrective-prompt retry), auto-migrate if the session is now over threshold.
  //
  // `validate(parsed, task)` returns `null` when the response is acceptable, or a string
  // describing what's wrong — which becomes the corrective message sent back to the model.
  // This exists because a response can be valid JSON and still be a bad answer (e.g. Movie
  // Segmenter returning one giant part instead of a cut-by-cut breakdown) — JSON-validity
  // and content-correctness are different failure modes with different fixes.
  async function runAiCall({
    requestId,
    sessionKey,
    purpose,
    primer,
    task,
    responseShape = 'text', // 'array' | 'object' | 'text'
    validate,
    deepThink = false,
    webSearch = false,
    timeoutMs,
    migrationThreshold = DEFAULT_MIGRATION_THRESHOLD,
    minAiCallIntervalMs = DEFAULT_MIN_AI_CALL_INTERVAL_MS,
  }) {
    const key = sessionKey || requestId;
    const sessionOpts = { deepThink, webSearch, timeoutMs };
    reportStatus(requestId, 'Preparing AI request…');
    await enforceMinDelay(minAiCallIntervalMs);

    let text = await sendToSession(key, purpose, primer, task, requestId, sessionOpts);

    if (responseShape !== 'text') {
      const parseFn = responseShape === 'object' ? ResponseParser.parseJsonObject : ResponseParser.parseJsonArray;
      const shapeLabel = responseShape === 'object' ? 'JSON object' : 'JSON array';
      let parsed;
      let firstAttemptText;
      try {
        parsed = parseFn(text);
      } catch (firstErr) {
        firstAttemptText = text;
        reportStatus(requestId, `Response wasn't valid ${shapeLabel} — asking for a reformat…`);
        text = await editLastMessage(key, `Please reformat your response as valid ${shapeLabel} only.`, timeoutMs);
        try {
          parsed = parseFn(text);
        } catch (secondErr) {
          // Surface both raw responses, not just the parser's generic message — this is
          // the only signal available for diagnosing WHY parsing failed (truncated
          // stream capture vs. a genuinely malformed reply vs. an extraction bug) without
          // manually inspecting the live tab.
          throw new Error(
            `AI response was not valid ${shapeLabel} after a reformat retry.\n` +
              `First attempt error: ${firstErr.message}\nFirst attempt text (${firstAttemptText.length} chars): ${firstAttemptText.slice(0, 500)}\n` +
              `Retry error: ${secondErr.message}\nRetry text (${text.length} chars): ${text.slice(0, 500)}`
          );
        }
      }

      if (validate) {
        let problem = validate(parsed, task);
        if (problem) {
          reportStatus(requestId, `Response needs a correction — ${problem}`.slice(0, 180));
          const correctionText = await editLastMessage(
            key,
            `Your previous answer is wrong: ${problem} Please send a corrected ${shapeLabel} only.`,
            timeoutMs
          );
          let corrected;
          try {
            corrected = parseFn(correctionText);
          } catch (e) {
            throw new Error(
              `AI response failed validation ("${problem}") and the correction retry was not valid ${shapeLabel}: ${e.message}`
            );
          }
          problem = validate(corrected, task);
          if (problem) {
            throw new Error(`AI response still failed validation after a corrective retry: ${problem}`);
          }
          parsed = corrected;
        }
      }

      await maybeMigrate(key, primer, migrationThreshold, sessionOpts, requestId);
      return parsed;
    }

    await maybeMigrate(key, primer, migrationThreshold, sessionOpts, requestId);
    return text.trim();
  }

  // --- Public entry points ---------------------------------------------------------------

  function runSmartTrimmer({ requestId, sessionKey, transcript, duration, migrationThreshold, minAiCallIntervalMs }) {
    return runAiCall({
      requestId,
      sessionKey,
      purpose: 'trim',
      primer: TRIM_PRIMER,
      task: trimTask({ duration, transcript }),
      responseShape: 'array',
      // No deepThink here (a trim call doesn't need extended reasoning), but the default
      // 60s stabilization timeout is still too tight for a real first+last-5-minutes
      // excerpt on the live site — give it the same budget as the reasoning calls purely
      // for latency headroom, not because it reasons any harder.
      timeoutMs: DEEP_REASONING_TIMEOUT_MS,
      migrationThreshold,
      minAiCallIntervalMs,
    });
  }

  function runClipFinder({ requestId, sessionKey, transcript, count = 8, migrationThreshold, minAiCallIntervalMs }) {
    return runAiCall({
      requestId,
      sessionKey,
      purpose: 'clips',
      primer: clipFinderPrimer(count),
      task: clipFinderTask({ transcript }),
      responseShape: 'array',
      // "where to cut" call — DeepThink's extended reasoning + Search noticeably improves
      // judgment on what actually hooks a viewer, worth the added latency here.
      deepThink: true,
      webSearch: true,
      timeoutMs: DEEP_REASONING_TIMEOUT_MS,
      migrationThreshold,
      minAiCallIntervalMs,
    });
  }

  async function runCaptionGenerator({ requestId, sessionKey, excerpt, hook, migrationThreshold, minAiCallIntervalMs }) {
    const parsed = await runAiCall({
      requestId,
      sessionKey,
      purpose: 'caption',
      primer: CAPTION_PRIMER,
      task: captionTask({ excerpt, hook }),
      responseShape: 'object',
      validate: validateCaptionResult,
      // Caption quality (tone + what actually hooks viewers/performs well) benefits from
      // the same extended reasoning as the "where to cut" calls.
      deepThink: true,
      webSearch: true,
      timeoutMs: DEEP_REASONING_TIMEOUT_MS,
      migrationThreshold,
      minAiCallIntervalMs,
    });
    return normalizeCaptionResult(parsed);
  }

  function runMovieSegmenter({ requestId, sessionKey, transcript, duration, migrationThreshold, minAiCallIntervalMs }) {
    return runAiCall({
      requestId,
      sessionKey,
      purpose: 'movie-segments',
      primer: MOVIE_SEGMENTER_PRIMER,
      task: movieSegmenterTask({ duration, transcript }),
      responseShape: 'array',
      validate: validateMovieSegments,
      deepThink: true,
      webSearch: true,
      timeoutMs: DEEP_REASONING_TIMEOUT_MS,
      migrationThreshold,
      minAiCallIntervalMs,
    });
  }

  return {
    runSmartTrimmer,
    runClipFinder,
    runCaptionGenerator,
    runCaptionRefiner,
    runTrendingHashtags,
    runMovieSegmenter,
    closeSession,
    sessions,
  };
})();
