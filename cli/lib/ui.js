// Minimal ANSI color helpers (no extra dependency beyond commander/ws/uuid per README).
const codes = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function paint(code, text) {
  if (!process.stdout.isTTY) return text;
  return `${codes[code]}${text}${codes.reset}`;
}

const ui = {
  info: (msg) => console.log(paint('cyan', '[info]'), msg),
  trim: (msg) => console.log(paint('blue', '[trim]'), msg),
  clips: (msg) => console.log(paint('blue', '[clips]'), msg),
  caption: (msg) => console.log(paint('blue', '[caption]'), msg),
  success: (msg) => console.log(paint('green', '[done]'), msg),
  error: (msg) => console.error(paint('red', '[error]'), msg),
  warn: (msg) => console.warn(paint('yellow', '[warn]'), msg),
  debug: (msg) => console.log(paint('gray', '[debug]'), msg),
};

module.exports = ui;
