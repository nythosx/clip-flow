#!/usr/bin/env node
// Driver/test harness for ClipFlow's AI Engine. Stands in for the future Rust backend
// (SPEC.md section 6.2's RustToSidecar/SidecarToRust WebSocket protocol) by sending the
// same 3 request types over the same local-WebSocket <-> native-host <-> extension bridge,
// and printing whatever comes back.
const fs = require('fs');
const path = require('path');
const { Command } = require('commander');
const { v4: uuidv4 } = require('uuid');

const { ensureProjectConfig } = require('./lib/config');
const { startServer, cleanupPortFile } = require('./lib/server');
const ui = require('./lib/ui');
const { AI_MESSAGE_TYPES } = require('../shared/protocol');

const program = new Command();
program.name('clipflow-ai').description("Driver for ClipFlow's AI Engine (Smart Trimmer / Clip Finder / Caption Generator).");

function commonOptions(cmd) {
  return cmd
    .option('--session-key <key>', 'reuse the same chat across multiple calls (default: one-off chat per call)')
    .option('--config <path>', 'override config directory (default .clipflow/ in cwd)')
    .option('--verbose', 'print detailed debug info', false);
}

commonOptions(
  program
    .command('trim')
    .description('Smart Trimmer: identify non-story segments (intro/credits) to remove')
    .requiredOption('--transcript <path>', 'path to a transcript file (plain text, with timestamps)')
    .requiredOption('--duration <hhmmss>', 'total movie duration, e.g. 01:52:30')
).action((opts) =>
  runRequest({
    type: AI_MESSAGE_TYPES.TRIM_ANALYSIS,
    resultType: AI_MESSAGE_TYPES.TRIM_RESULT,
    log: ui.trim,
    opts,
    buildPayload: () => ({
      transcript: readTranscript(opts.transcript),
      duration: opts.duration,
    }),
    formatResult: (msg) => JSON.stringify(msg.segments, null, 2),
  })
);

commonOptions(
  program
    .command('clips')
    .description('Clip Finder: find viral-worthy clip candidates in a (cleaned) transcript')
    .requiredOption('--transcript <path>', 'path to a transcript file')
    .option('--count <n>', 'number of clips to find', '8')
).action((opts) =>
  runRequest({
    type: AI_MESSAGE_TYPES.CLIP_FINDER,
    resultType: AI_MESSAGE_TYPES.CLIP_RESULT,
    log: ui.clips,
    opts,
    buildPayload: () => ({
      transcript: readTranscript(opts.transcript),
      count: parseInt(opts.count, 10),
    }),
    formatResult: (msg) => JSON.stringify(msg.clips, null, 2),
  })
);

commonOptions(
  program
    .command('caption')
    .description('Caption Generator: write a TikTok caption for one clip')
    .requiredOption('--excerpt <path>', 'path to the transcript excerpt file for this clip')
    .requiredOption('--hook <text>', 'short reason this clip is engaging (from Clip Finder)')
).action((opts) =>
  runRequest({
    type: AI_MESSAGE_TYPES.CAPTION_GENERATE,
    resultType: AI_MESSAGE_TYPES.CAPTION_RESULT,
    log: ui.caption,
    opts,
    buildPayload: () => ({
      excerpt: readTranscript(opts.excerpt),
      hook: opts.hook,
    }),
    formatResult: (msg) => msg.caption,
  })
);

commonOptions(program.command('close-session').description("Close a session's chat tab (if any) and forget it")).action((opts) => {
  if (!opts.sessionKey) {
    ui.error('close-session requires --session-key <key>.');
    process.exit(1);
  }
  return runRequest({
    type: AI_MESSAGE_TYPES.CLOSE_SESSION,
    resultType: AI_MESSAGE_TYPES.SESSION_CLOSED,
    log: ui.info,
    opts,
    buildPayload: () => ({}),
    formatResult: (msg) => (msg.closed ? 'Session closed and forgotten.' : msg.reason || 'Nothing to close.'),
  });
});

function readTranscript(filePath) {
  return fs.readFileSync(path.resolve(filePath), 'utf8');
}

async function runRequest({ type, resultType, log, opts, buildPayload, formatResult }) {
  const projectRoot = process.cwd();
  const configDir = opts.config ? path.resolve(opts.config) : path.join(projectRoot, '.clipflow');
  const { config } = ensureProjectConfig(configDir);

  if (opts.verbose) {
    ui.debug(`Config dir: ${configDir}`);
    ui.debug(`Config: ${JSON.stringify(config)}`);
  }

  const { port, wss, waitForConnection } = await startServer();
  ui.info(`Local WebSocket server listening on 127.0.0.1:${port}`);
  ui.info('Waiting for extension to connect...');

  const ws = await waitForConnection();
  ui.info('Extension connected.');

  const requestId = uuidv4();

  function cleanupAndExit(code) {
    cleanupPortFile();
    wss.close();
    process.exit(code);
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      ui.error(`Received malformed message: ${err.message}`);
      return;
    }
    if (opts.verbose) ui.debug(`<- ${JSON.stringify(msg)}`);
    if (msg.requestId !== requestId) return;

    if (msg.type === resultType) {
      log(formatResult(msg));
      ui.success('Request completed.');
      cleanupAndExit(0);
      return;
    }
    if (msg.type === AI_MESSAGE_TYPES.AI_ERROR) {
      ui.error(msg.error || 'Unrecoverable error.');
      cleanupAndExit(1);
    }
  });

  ws.on('close', () => {
    ui.warn('Extension/native-host connection closed.');
    cleanupAndExit(1);
  });

  const payload = { type, requestId, sessionKey: opts.sessionKey, ...buildPayload() };
  ws.send(JSON.stringify(payload));
  ui.info(`Request sent (requestId=${requestId}, type=${type})`);
}

program.parseAsync(process.argv).catch((err) => {
  ui.error(err.stack || err.message);
  cleanupPortFile();
  process.exit(1);
});
