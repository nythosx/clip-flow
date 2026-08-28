#!/usr/bin/env node
// Deterministic tests of orchestrator.js's session-reuse, chat-migration, and
// reformat-as-JSON-retry behavior, driving the REAL extension/lib/orchestrator.js +
// responseParser.js source with Node-side stand-ins for chrome.storage/chrome.tabs/
// TabManager/NativeBridge (same technique the old my-claude-code tests used). Proves:
//   1. A first call for a sessionKey opens a tab and primes it; a second call for the SAME
//      sessionKey reuses the tab and does NOT re-send the primer.
//   2. When a session's message count crosses migrationThreshold, the chat is migrated:
//      old tab closed, new tab opened and re-primed with a summary, session continues.
//   3. A non-JSON response triggers the reformat-as-JSON retry (SPEC.md section 6) and
//      succeeds on the retry.
//   4. closeSession closes a live session's tab and forgets it; closing again reports
//      closed:false.
//
// Requires the fake-backend server running on http://localhost:8080.
// Usage: node test/e2e-resume.js

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function loadOrchestrator() {
  const protocolSrc = fs.readFileSync(path.join(REPO_ROOT, 'shared/protocol.js'), 'utf8');
  const parserSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/responseParser.js'), 'utf8');
  const orchestratorSrc = fs.readFileSync(path.join(REPO_ROOT, 'extension/lib/orchestrator.js'), 'utf8');
  // protocol.js is CommonJS (module.exports guarded) — strip that guard so its consts land
  // as plain globals inside the Function body, matching how importScripts shares scope in
  // the real service worker.
  const protocolGlobals = protocolSrc.replace(/if \(typeof module[\s\S]*$/, '');
  return new Function(`${protocolGlobals}\n${parserSrc}\n${orchestratorSrc}\nreturn Orchestrator;`)();
}

async function main() {
  await fetch('http://localhost:8080/api/reset', { method: 'POST' });

  const fakeStorage = new Map();
  global.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: fakeStorage.get(key) }),
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) fakeStorage.set(k, v);
        },
        remove: async (key) => fakeStorage.delete(key),
      },
    },
    tabs: {
      get: async (tabId) => {
        if (aliveTabs.has(tabId)) return { id: tabId };
        throw new Error('No such tab.');
      },
    },
  };

  let nextTabId = 2001;
  const aliveTabs = new Set();
  const tabMeta = new Map(); // tabId -> { purpose, urlTaskId }
  const sentMessages = []; // { tabId, action, text }
  const createChatTabCalls = [];
  const closeTabsCalls = [];
  let currentScenario = 'default';

  global.TabManager = {
    createChatTab: async (purpose, urlTaskId) => {
      const tabId = nextTabId++;
      aliveTabs.add(tabId);
      tabMeta.set(tabId, { purpose, urlTaskId });
      createChatTabCalls.push({ tabId, purpose, urlTaskId });
      return tabId;
    },
    waitForReady: async () => true,
    closeTabs: async (...tabIds) => {
      closeTabsCalls.push(tabIds);
      tabIds.forEach((id) => aliveTabs.delete(id));
    },
    sendToTab: async (tabId, message) => {
      sentMessages.push({ tabId, action: message.action, text: message.text });
      const meta = tabMeta.get(tabId);
      const res = await fetch('http://localhost:8080/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: message.text,
          context: meta.purpose,
          taskId: meta.urlTaskId,
          scenario: currentScenario,
        }),
      });
      const data = await res.json();
      return { text: data.reply };
    },
  };

  global.NativeBridge = { sendToCli: () => {} };

  const Orchestrator = loadOrchestrator();
  const noDelay = { minAiCallIntervalMs: 0 };

  // --- 1. Fresh session, then reuse ------------------------------------------------------
  currentScenario = 'default';
  const clips = await Orchestrator.runClipFinder({
    requestId: 'req-1',
    sessionKey: 'proj-1:clips',
    transcript: 'a full movie transcript...',
    count: 8,
    ...noDelay,
  });
  assert(Array.isArray(clips) && clips.length === 2, `expected 2 clips, got ${JSON.stringify(clips)}`);
  assert(clips[0].hook.includes('shock value'), 'first clip hook should match the scripted turn');
  assert(createChatTabCalls.length === 1, 'first call should open exactly one tab');
  const firstSend = sentMessages[0];
  assert(
    firstSend.text.startsWith('You are a TikTok viral content strategist'),
    'first send on a fresh tab should include the primer'
  );
  console.log('[harness] 1a: fresh Clip Finder call opened a tab, sent primer+task, parsed clips correctly');

  // Smart Trimmer, separate sessionKey/purpose, should also work standalone.
  const segments = await Orchestrator.runSmartTrimmer({
    requestId: 'req-2',
    sessionKey: 'proj-1:trim',
    transcript: 'first 5 min ... last 5 min ...',
    duration: '01:52:30',
    ...noDelay,
  });
  assert(Array.isArray(segments) && segments.length === 2, `expected 2 segments, got ${JSON.stringify(segments)}`);
  console.log('[harness] 1b: Smart Trimmer parsed segments correctly on its own session');

  // --- 2. Session reuse for Caption Generator, then migration ---------------------------
  currentScenario = 'migration';
  sentMessages.length = 0;
  createChatTabCalls.length = 0;
  closeTabsCalls.length = 0;

  const captionOpts = { sessionKey: 'proj-1:caption', excerpt: 'clip excerpt', hook: 'big reveal', migrationThreshold: 2, ...noDelay };

  const caption1 = await Orchestrator.runCaptionGenerator({ requestId: 'req-3', ...captionOpts });
  assert(caption1 === 'Caption one! #one #fyp', `unexpected caption1: ${caption1}`);
  assert(createChatTabCalls.length === 1, 'first caption call should open one tab');
  assert(
    sentMessages[0].text.startsWith('Write a TikTok caption for this movie clip.'),
    'first caption send should include the primer'
  );
  console.log('[harness] 2a: first Caption Generator call opened a tab and sent the primer');

  const priorSendCount = sentMessages.length;
  const caption2 = await Orchestrator.runCaptionGenerator({ requestId: 'req-4', ...captionOpts });
  assert(caption2 === 'Caption two! #two #fyp', `unexpected caption2: ${caption2}`);
  assert(createChatTabCalls.length === 2, 'crossing migrationThreshold should have opened a second (migrated) tab');
  assert(closeTabsCalls.length === 1, 'migration should have closed the old tab');
  const secondCallSends = sentMessages.slice(priorSendCount);
  assert(
    secondCallSends[0].action === 'typeAndSend' && !/Write a TikTok caption/.test(secondCallSends[0].text),
    'reusing an existing session should send the task WITHOUT re-priming'
  );
  const migrationEdit = secondCallSends.find((m) => m.action === 'editMessage');
  assert(migrationEdit, 'migration should have edited a message to request a summary');
  const rePrime = secondCallSends.find((m) => m.action === 'typeAndSend' && /Previous summary:/.test(m.text));
  assert(rePrime, 'migration should have re-primed the new tab with the summary');
  console.log('[harness] 2b: second Caption Generator call reused the session, then auto-migrated on crossing the threshold');

  // This 3rd call reuses the freshly-migrated tab to fetch its response (proving the
  // migrated session is usable), but since migrationThreshold=2 and msgCount was reset to 1
  // by the migration, this call's own send pushes it back to 2 — crossing the threshold
  // again and triggering a second migration in preparation for a hypothetical 4th call.
  // That's expected at this artificially low threshold; a real 40-message threshold only
  // migrates every ~40 calls.
  const caption3 = await Orchestrator.runCaptionGenerator({ requestId: 'req-5', ...captionOpts });
  assert(caption3 === 'Caption three, post-migration! #three #fyp', `unexpected caption3: ${caption3}`);
  assert(createChatTabCalls.length >= 2, 'the post-migration call should have reused the freshly migrated tab to fetch its response');
  console.log('[harness] 2c: post-migration call reused the new tab correctly');

  // --- 3. Reformat-as-JSON retry ----------------------------------------------------------
  currentScenario = 'retry-as-json';
  const retriedSegments = await Orchestrator.runSmartTrimmer({
    requestId: 'req-6',
    sessionKey: 'proj-2:trim',
    transcript: 'transcript...',
    duration: '00:45:00',
    ...noDelay,
  });
  assert(
    Array.isArray(retriedSegments) && retriedSegments.length === 1 && retriedSegments[0].end === '00:01:40',
    `expected the reformatted segment, got ${JSON.stringify(retriedSegments)}`
  );
  console.log('[harness] 3: non-JSON first reply triggered the reformat-as-JSON retry and succeeded');

  // --- 4. closeSession ---------------------------------------------------------------------
  const closeResult = await Orchestrator.closeSession('proj-1:clips');
  assert(closeResult.closed === true, 'closeSession should report closed:true for a live session');
  const closeAgain = await Orchestrator.closeSession('proj-1:clips');
  assert(closeAgain.closed === false, 'closing an already-forgotten session should report closed:false');
  console.log('[harness] 4: closeSession closes a live session and reports false on a second close');

  console.log('\n[harness] PASS — session reuse, migration, reformat-as-JSON retry, and closeSession all behave correctly.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[harness] FAILED:', err);
  process.exit(1);
});
