const fs = require('fs');
const path = require('path');

class StatsTracker {
  constructor(filePath) {
    this.filePath = filePath || path.resolve(__dirname, '../data/stats.json');
    this.stats = {
      totalChecked: 0,
      totalMatches: 0,
      totalForwarded: 0,
      lastActivity: null,
      recentMatches: []
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.stats = {
          totalChecked: Number(parsed.totalChecked) || 0,
          totalMatches: Number(parsed.totalMatches) || 0,
          totalForwarded: Number(parsed.totalForwarded) || 0,
          lastActivity: parsed.lastActivity || null,
          recentMatches: Array.isArray(parsed.recentMatches) ? parsed.recentMatches : []
        };
      }
    } catch (err) {
      console.warn('Could not load stats from disk, using defaults:', err.message);
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.stats, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save stats to disk:', err.message);
    }
  }

  recordCheck(mediaType = 'image') {
    this.stats.totalChecked += 1;
    this.stats.lastActivity = new Date().toISOString();
    this.save();
    return this.getStats();
  }

  recordMatch(meta = {}) {
    this.stats.totalMatches += 1;
    this.stats.lastActivity = new Date().toISOString();

    const matchEntry = {
      id: meta.msgId || String(Date.now()),
      mediaType: meta.mediaType || 'image',
      distance: meta.distance || null,
      confidence: meta.distance ? Math.max(0, Math.round((1 - parseFloat(meta.distance) / 1.0) * 100)) : null,
      filename: meta.filename || null,
      previewUrl: meta.filename ? `/previews/${encodeURIComponent(meta.filename)}` : null,
      caption: meta.caption || '',
      forwarded: Boolean(meta.forwarded),
      reason: meta.reason || (meta.forwarded ? 'FORWARDED' : 'DRY_RUN'),
      timestamp: new Date().toISOString()
    };

    // Keep the last 50 matches
    this.stats.recentMatches.unshift(matchEntry);
    if (this.stats.recentMatches.length > 50) {
      this.stats.recentMatches = this.stats.recentMatches.slice(0, 50);
    }

    this.save();
    return matchEntry;
  }

  recordForward() {
    this.stats.totalForwarded += 1;
    this.save();
    return this.getStats();
  }

  getStats() {
    return {
      totalChecked: this.stats.totalChecked,
      totalMatches: this.stats.totalMatches,
      totalForwarded: this.stats.totalForwarded,
      lastActivity: this.stats.lastActivity,
      recentMatches: this.stats.recentMatches.slice(0, 20)
    };
  }

  reset() {
    this.stats = {
      totalChecked: 0,
      totalMatches: 0,
      totalForwarded: 0,
      lastActivity: null,
      recentMatches: []
    };
    this.save();
    return this.getStats();
  }
}

module.exports = StatsTracker;
