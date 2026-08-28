#!/usr/bin/env node
// End-to-end integration test for the CLI <-> native-host <-> "extension" <-> mock-backend
// pipeline, using ClipFlow's new AI_MESSAGE_TYPES protocol. Stands in for the real Chrome
// extension by driving the fake-backend's HTTP API directly (instead of DOM automation)
// and speaking the exact native-messaging protocol the real extension uses. Requires the
// fake-backend server to already be running on http://localhost:8080.
//
// Usage: node test/e2e-mock.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const { NativeMessaging } = require('../native-host/lib/native-messaging');
const { HOST_MESSAGE_TYPES, AI_MESSAGE_TYPES } = require('../shared/protocol');

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function fetchTurn(context, taskId) {
  const res = await fetch('http://localhost:8080/api/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '(driven by test harness)', context, taskId, scenario: 'default' }),
  });
  const data = await res.json();
  return data.reply;
}

async function main() {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipflow-e2e-'));
  console.log(`[harness] scratch dir: ${scratchDir}`);

  // The CLI and native host discover each other via a port file under the user's real
  // home dir (~/.myclaudecode/current_port) — which the actual Chrome extension's
  // always-on host process also polls. Give this harness's child processes an isolated
  // fake home dir so it never races the real extension for that shared file.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clipflow-e2e-home-'));
  const childEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  console.log(`[harness] isolated home dir: ${fakeHome}`);

  await fetch('http://localhost:8080/api/reset', { method: 'POST' });

  const transcriptPath = path.join(scratchDir, 'transcript.txt');
  fs.writeFileSync(transcriptPath, '[00:00:00] Studio logo.\n[00:02:15] The movie begins...\n');

  const host = spawn('node', [path.join(REPO_ROOT, 'native-host', 'host.js')], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const nm = new NativeMessaging(host.stdout, host.stdin);

  const cli = spawn(
    'node',
    [path.join(REPO_ROOT, 'cli', 'index.js'), 'trim', '--transcript', transcriptPath, '--duration', '01:52:30', '--verbose'],
    { cwd: scratchDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  cli.stdout.on('data', (d) => process.stdout.write(`[cli] ${d}`));
  cli.stderr.on('data', (d) => process.stderr.write(`[cli:err] ${d}`));
  const cliExit = new Promise((resolve) => cli.on('close', resolve));

  let sawTrimResult = false;

  function sendToCli(payload) {
    nm.send({ type: HOST_MESSAGE_TYPES.EXT_TO_CLI, payload });
  }

  nm.on('message', (msg) => {
    if (msg.type !== HOST_MESSAGE_TYPES.CLI_TO_EXT) {
      console.log('[harness] unhandled message from host:', msg);
      return;
    }
    const payload = msg.payload;
    if (payload.type !== AI_MESSAGE_TYPES.TRIM_ANALYSIS) {
      console.log('[harness] unexpected request type:', payload.type);
      return;
    }
    console.log(`[harness] received trim_analysis, requestId=${payload.requestId}, duration=${payload.duration}`);

    // A single request/response round trip is all Smart Trimmer needs for the happy path —
    // no multi-turn orchestration required, so drive the mock backend directly.
    fetchTurn('trim', payload.requestId)
      .then((reply) => {
        console.log(`[harness] mock backend reply: ${reply}`);
        const segments = JSON.parse(reply);
        sendToCli({ type: AI_MESSAGE_TYPES.TRIM_RESULT, requestId: payload.requestId, segments });
        sawTrimResult = true;
      })
      .catch((err) => {
        console.error('[harness] scenario failed:', err);
        sendToCli({ type: AI_MESSAGE_TYPES.AI_ERROR, requestId: payload.requestId, error: err.message });
        process.exitCode = 1;
      });
  });

  const exitCode = await cliExit;
  host.kill();

  assert(sawTrimResult, 'harness should have sent back a trim_result');
  assert(exitCode === 0, `CLI should exit 0, got ${exitCode}`);

  console.log('\n[harness] PASS — full CLI <-> native-host <-> extension-protocol <-> mock-backend loop verified.');
  fs.rmSync(scratchDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error('[harness] FAILED:', err);
  process.exit(1);
});
