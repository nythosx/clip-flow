#!/usr/bin/env node
// Native messaging host: bridges the Chrome extension (stdin/stdout) to the CLI's local
// WebSocket server. Pure message relay — the extension owns all AI-call orchestration and
// the browser side never touches the filesystem or shell, so unlike the my-claude-code
// original this host has no tool-execution or approval responsibilities of its own.
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { NativeMessaging } = require('./lib/native-messaging');
const { HOST_MESSAGE_TYPES } = require('../shared/protocol');

// Own discovery directory, distinct from the my-claude-code project's ~/.myclaudecode/ —
// sharing it meant both projects' native hosts polled the same port file and raced to
// connect to whichever CLI wrote it last, silently misrouting requests to the wrong
// extension. Must match cli/lib/server.js's WELL_KNOWN_DIR.
const PORT_FILE = path.join(os.homedir(), '.clipflow', 'current_port');
const LOG_FILE = path.join(os.homedir(), '.clipflow', 'host.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {
    // logging is best-effort; native messaging stdout/stderr must stay clean
  }
}

const nm = new NativeMessaging(process.stdin, process.stdout);

let ws = null;
let wsQueue = [];

function sendToCli(payload) {
  const json = JSON.stringify(payload);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(json);
  } else {
    wsQueue.push(json);
  }
}

// The extension's native port (and this process) can live for the whole Chrome session,
// long before any CLI invocation exists. So this polls indefinitely rather than giving up
// after a few seconds, and re-polls after a disconnect in case a new CLI run starts up on
// a different port.
let currentPort = null;
const PORT_POLL_MS = 1000;

function pollForCli() {
  let port;
  try {
    port = fs.readFileSync(PORT_FILE, 'utf8').trim();
  } catch (_) {
    port = null;
  }

  const isConnected = ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
  if (port && (!isConnected || port !== currentPort)) {
    connectToCli(port);
  }

  setTimeout(pollForCli, PORT_POLL_MS);
}

function connectToCli(port) {
  currentPort = port;
  ws = new WebSocket(`ws://127.0.0.1:${port}`);

  ws.on('open', () => {
    log('Connected to CLI WebSocket server on port', port);
    wsQueue.forEach((json) => ws.send(json));
    wsQueue = [];
  });

  ws.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch (err) {
      log('Malformed CLI message:', err.message);
      return;
    }
    // Forward everything to the extension so it can drive the requested AI call.
    nm.send({ type: HOST_MESSAGE_TYPES.CLI_TO_EXT, payload });
  });

  ws.on('close', () => {
    log('CLI WebSocket connection closed.');
    ws = null;
  });

  ws.on('error', (err) => {
    log('CLI WebSocket error:', err.message);
  });
}

nm.on('message', (msg) => {
  if (msg.type === HOST_MESSAGE_TYPES.EXT_TO_CLI) {
    sendToCli(msg.payload);
    return;
  }
  log('Unhandled message from extension:', JSON.stringify(msg));
});

nm.on('close', () => {
  log('stdin closed (Chrome disconnected). Exiting.');
  process.exit(0);
});

nm.on('error', (err) => log('Native messaging error:', err.message));

log('Native host started, pid', process.pid);
pollForCli();
