// Process-wide log capture: in-memory ring buffer + rotating file + token
// scrubber. Installs console hooks and uncaughtException / unhandledRejection
// handlers on require, so this module MUST be required early in main.js
// before anything else that might log.

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// E1: Log ring buffer
const LOG_MAX = 500;
const logBuffer = [];
const origConsoleLog = console.log;
const origConsoleError = console.error;
const origConsoleWarn = console.warn;

// Scrub obviously-sensitive tokens out of log messages so the View Logs
// viewer + the persisted log file don't expose them.
// gh error output occasionally echoes URLs of the form
// `https://oauth2:ghp_xxx@github.com/...` before the app's own scrub runs.
const LOG_TOKEN_SCRUB_RE = /(oauth2:[^@\s]+@)|(\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{20,})|(\bBearer\s+[A-Za-z0-9._\-]+)/g;
function scrubLogMsg(s) {
  try { return String(s).replace(LOG_TOKEN_SCRUB_RE, (m, a) => a ? 'oauth2:***@' : '***'); }
  catch { return '[unserializable]'; }
}

// Persistent log file — ring buffer is in-memory only, which loses context
// across a crash. Keep a small rotating file in userData so users can attach
// it to a bug report even after the app restarts.
const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024;   // rotate at 2MB
const LOG_FILE_KEEP = 3;                       // keep klaussy.log + .1 + .2
let _logFilePath = null;
let _logRotating = false;
function getLogFilePath() {
  if (_logFilePath) return _logFilePath;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    _logFilePath = path.join(dir, 'klaussy.log');
  } catch {}
  return _logFilePath;
}
function rotateLogFile(file) {
  if (_logRotating) return;
  _logRotating = true;
  try {
    for (let i = LOG_FILE_KEEP - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch {}
    }
  } finally {
    _logRotating = false;
  }
}
function appendLogLine(line) {
  const file = getLogFilePath();
  if (!file) return;
  try {
    fs.appendFileSync(file, line + '\n');
    const st = fs.statSync(file);
    if (st.size >= LOG_FILE_MAX_BYTES) rotateLogFile(file);
  } catch {}
}

function captureLog(level, args) {
  let msg;
  try {
    msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  } catch {
    msg = '[log arg not serializable]';
  }
  msg = scrubLogMsg(msg);
  const ts = new Date().toISOString();
  logBuffer.push({ time: ts, level, msg });
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  appendLogLine(`${ts} ${level.toUpperCase()} ${msg}`);
}

console.log = function (...args) { captureLog('log', args); origConsoleLog.apply(console, args); };
console.error = function (...args) { captureLog('error', args); origConsoleError.apply(console, args); };
console.warn = function (...args) { captureLog('warn', args); origConsoleWarn.apply(console, args); };

// Also capture uncaught errors
process.on('uncaughtException', (err) => {
  captureLog('error', ['Uncaught:', err.stack || err.message]);
  origConsoleError.call(console, 'Uncaught:', err);
});

process.on('unhandledRejection', (reason) => {
  captureLog('error', ['Unhandled rejection:', String(reason)]);
  origConsoleError.call(console, 'Unhandled rejection:', reason);
});

function getLogBuffer() { return logBuffer.slice(); }

module.exports = { captureLog, scrubLogMsg, getLogBuffer };
