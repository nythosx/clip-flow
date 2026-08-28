const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { WebSocketServer } = require('ws');

const PREFERRED_PORT = 9876;
// Own discovery directory, distinct from the my-claude-code project's ~/.myclaudecode/ —
// they can be installed side by side, and sharing this file would let either project's
// native host race to connect to the other's CLI (see native-host/host.js's PORT_FILE).
const WELL_KNOWN_DIR = path.join(os.homedir(), '.clipflow');
const PORT_FILE = path.join(WELL_KNOWN_DIR, 'current_port');

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  if (await isPortFree(PREFERRED_PORT)) return PREFERRED_PORT;
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once('error', reject);
    tester.listen(0, '127.0.0.1', () => {
      const { port } = tester.address();
      tester.close(() => resolve(port));
    });
  });
}

function writePortFile(port) {
  fs.mkdirSync(WELL_KNOWN_DIR, { recursive: true });
  fs.writeFileSync(PORT_FILE, String(port));
}

function cleanupPortFile() {
  try {
    if (fs.existsSync(PORT_FILE)) fs.unlinkSync(PORT_FILE);
  } catch (_) {
    // best-effort cleanup
  }
}

/**
 * Starts the local WS server the native host connects to.
 * Resolves with { port, wss, waitForConnection } once listening.
 */
async function startServer() {
  const port = await pickPort();
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  writePortFile(port);

  const waitForConnection = () =>
    new Promise((resolve) => {
      wss.once('connection', (ws) => resolve(ws));
    });

  return { port, wss, waitForConnection };
}

module.exports = { startServer, cleanupPortFile, PORT_FILE };
