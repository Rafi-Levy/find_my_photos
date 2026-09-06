const fs = require('fs');
const path = require('path');

/**
 * Simple JSON-lines file + console logger.
 * Writes structured metadata only — never media content or face images.
 */
class Logger {
  constructor(logPath) {
    this.logPath = logPath;
    // Ensure log directory exists
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Write a structured log entry to both console and file.
   * @param {string} level - INFO | WARN | ERROR
   * @param {string} message - Human-readable message
   * @param {object} meta - Structured metadata (message IDs, types, distances — never media)
   */
  _write(level, message, meta = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta
    };
    const line = JSON.stringify(entry);

    // Console output: colored level prefix + message + optional metadata
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    console.log(`[${level}] ${message}${metaStr}`);

    // Append to log file (JSON-lines format for easy grep/parsing)
    fs.appendFileSync(this.logPath, line + '\n');
  }

  info(msg, meta)  { this._write('INFO', msg, meta); }
  warn(msg, meta)  { this._write('WARN', msg, meta); }
  error(msg, meta) { this._write('ERROR', msg, meta); }
}

module.exports = Logger;
