const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 30;
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class NearMissBuffer {
  constructor(filePath, previewDir) {
    this.filePath = filePath || path.resolve(__dirname, '../data/near-misses.json');
    this.previewDir = previewDir || path.resolve(__dirname, '../matches_preview');
    this.entries = [];
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.entries = Array.isArray(parsed) ? parsed : [];
      }
    } catch (err) {
      console.warn('Could not load near-miss buffer from disk, starting empty:', err.message);
      this.entries = [];
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save near-miss buffer to disk:', err.message);
    }
  }

  /**
   * Save media file to preview directory and register near-miss.
   */
  add(media, msgId, descriptor, bestDistance) {
    if (!descriptor) return null;

    this.prune();

    const timestamp = Date.now();
    const safeId = (msgId || String(timestamp)).replace(/[^a-zA-Z0-9_-]/g, '_');
    let filename = null;

    if (media && media.data) {
      try {
        if (!fs.existsSync(this.previewDir)) {
          fs.mkdirSync(this.previewDir, { recursive: true });
        }
        const ext = media.mimetype?.split('/')[1]?.split(';')[0] || 'jpg';
        filename = `near_miss_${timestamp}_${safeId}.${ext}`;
        const mediaPath = path.join(this.previewDir, filename);
        fs.writeFileSync(mediaPath, Buffer.from(media.data, 'base64'));
      } catch (err) {
        console.warn('Could not save near-miss preview file:', err.message);
      }
    }

    const id = `miss_${timestamp}_${safeId}`;
    const entry = {
      id,
      msgId: msgId || null,
      filename,
      previewUrl: filename ? `/previews/${encodeURIComponent(filename)}` : null,
      descriptor: Array.from(descriptor),
      bestDistance: bestDistance !== null && bestDistance !== undefined ? Number(bestDistance) : null,
      confidence: bestDistance !== null && bestDistance !== undefined
        ? Math.max(0, Math.round((1 - bestDistance / 1.0) * 100))
        : null,
      timestamp: new Date().toISOString()
    };

    // If buffer is at capacity, remove oldest entry and delete its file
    if (this.entries.length >= MAX_ENTRIES) {
      const removed = this.entries.shift();
      if (removed && removed.filename) {
        try {
          const p = path.join(this.previewDir, removed.filename);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {}
      }
    }

    this.entries.push(entry);
    this.save();
    return entry;
  }

  getAll() {
    this.prune();
    return this.entries.slice().reverse();
  }

  getById(id) {
    return this.entries.find(e => e.id === id) || null;
  }

  remove(id) {
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx === -1) return false;

    const removed = this.entries.splice(idx, 1)[0];
    if (removed && removed.filename) {
      try {
        const p = path.join(this.previewDir, removed.filename);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {}
    }
    this.save();
    return true;
  }

  prune() {
    const now = Date.now();
    const remaining = [];

    for (const entry of this.entries) {
      const age = now - new Date(entry.timestamp).getTime();
      if (age > TTL_MS) {
        if (entry.filename) {
          try {
            const p = path.join(this.previewDir, entry.filename);
            if (fs.existsSync(p)) fs.unlinkSync(p);
          } catch {}
        }
      } else {
        remaining.push(entry);
      }
    }

    if (remaining.length !== this.entries.length) {
      this.entries = remaining;
      this.save();
    }
  }

  reset() {
    for (const entry of this.entries) {
      if (entry.filename) {
        try {
          const p = path.join(this.previewDir, entry.filename);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch {}
      }
    }
    this.entries = [];
    this.save();
    return true;
  }
}

module.exports = NearMissBuffer;
