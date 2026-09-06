const fs = require('fs');
const path = require('path');

const DEDUPE_FILE = path.join(__dirname, '..', 'data', 'processed-messages.json');

/**
 * Tracks processed message IDs in a JSON file to survive restarts.
 * Prevents re-forwarding old messages after a process restart.
 * Caps storage at 10,000 entries (most recent) to prevent unbounded growth.
 */
class DedupeTracker {
  constructor() {
    this.processedIds = new Set();
    this._load();
  }

  /** Load previously processed IDs from disk. */
  _load() {
    try {
      if (fs.existsSync(DEDUPE_FILE)) {
        const data = JSON.parse(fs.readFileSync(DEDUPE_FILE, 'utf-8'));
        this.processedIds = new Set(data);
      }
    } catch {
      // If file is corrupted, start fresh
      this.processedIds = new Set();
    }
  }

  /** Persist current IDs to disk. Keeps only the most recent 10,000 entries. */
  _save() {
    const dir = path.dirname(DEDUPE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const ids = [...this.processedIds];
    const trimmed = ids.slice(-10000);
    fs.writeFileSync(DEDUPE_FILE, JSON.stringify(trimmed, null, 2));
  }

  /**
   * Check if a message ID has already been processed.
   * @param {string} messageId - The serialized message ID (msg.id._serialized)
   * @returns {boolean}
   */
  isProcessed(messageId) {
    return this.processedIds.has(messageId);
  }

  /**
   * Mark a message ID as processed and persist to disk.
   * @param {string} messageId
   */
  markProcessed(messageId) {
    this.processedIds.add(messageId);
    this._save();
  }
}

module.exports = DedupeTracker;
