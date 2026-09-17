const fs = require('fs');
const path = require('path');

class FeedbackStore {
  constructor(filePath, descriptorCachePath) {
    this.filePath = filePath || path.resolve(__dirname, '../data/feedback.json');
    this.descriptorCachePath = descriptorCachePath || path.resolve(__dirname, '../data/descriptor-cache.json');

    this.data = {
      version: 1,
      positives: [],
      negatives: [],
      feedbackLog: [],
      stats: {
        totalConfirmed: 0,
        totalRejected: 0,
        totalRescued: 0,
        totalAutoNegatives: 0
      }
    };

    this.descriptorCache = {}; // Keyed by matchId/msgId, max 200 items

    this.load();
    this.loadDescriptorCache();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.data = {
          version: parsed.version || 1,
          positives: Array.isArray(parsed.positives) ? parsed.positives : [],
          negatives: Array.isArray(parsed.negatives) ? parsed.negatives : [],
          feedbackLog: Array.isArray(parsed.feedbackLog) ? parsed.feedbackLog : [],
          stats: {
            totalConfirmed: Number(parsed.stats?.totalConfirmed) || 0,
            totalRejected: Number(parsed.stats?.totalRejected) || 0,
            totalRescued: Number(parsed.stats?.totalRescued) || 0,
            totalAutoNegatives: Number(parsed.stats?.totalAutoNegatives) || 0
          }
        };
      }
    } catch (err) {
      console.warn('Could not load feedback store from disk, using defaults:', err.message);
    }
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save feedback store to disk:', err.message);
    }
  }

  loadDescriptorCache() {
    try {
      if (fs.existsSync(this.descriptorCachePath)) {
        const raw = fs.readFileSync(this.descriptorCachePath, 'utf-8');
        this.descriptorCache = JSON.parse(raw) || {};
      }
    } catch (err) {
      this.descriptorCache = {};
    }
  }

  saveDescriptorCache() {
    try {
      const dir = path.dirname(this.descriptorCachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.descriptorCachePath, JSON.stringify(this.descriptorCache, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save descriptor cache to disk:', err.message);
    }
  }

  /**
   * Cache a descriptor for a match or near-miss to allow feedback later.
   */
  cacheDescriptor(matchId, descriptor, distance) {
    if (!matchId || !descriptor) return;

    const keys = Object.keys(this.descriptorCache);
    if (keys.length >= 200) {
      // Remove the oldest 20 entries
      const sortedKeys = keys.sort((a, b) => {
        const timeA = new Date(this.descriptorCache[a].timestamp).getTime() || 0;
        const timeB = new Date(this.descriptorCache[b].timestamp).getTime() || 0;
        return timeA - timeB;
      });
      for (let i = 0; i < 20; i++) {
        delete this.descriptorCache[sortedKeys[i]];
      }
    }

    this.descriptorCache[matchId] = {
      bestDescriptor: Array.from(descriptor),
      distance: distance !== null && distance !== undefined ? Number(distance) : null,
      timestamp: new Date().toISOString()
    };
    this.saveDescriptorCache();
  }

  getCachedDescriptor(matchId) {
    return this.descriptorCache[matchId] || null;
  }

  /**
   * User confirms a match is correct (true positive) or rescues a near-miss.
   */
  addPositive(descriptor, distance, matchId, source = 'confirmed_match') {
    if (!descriptor) throw new Error('Descriptor is required');

    const feedbackId = `fb_pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
      id: feedbackId,
      descriptor: Array.from(descriptor),
      distance: distance !== null && distance !== undefined ? Number(distance) : null,
      matchId: matchId || null,
      source,
      timestamp: new Date().toISOString()
    };

    this.data.positives.push(entry);

    if (source === 'confirmed_match') {
      this.data.stats.totalConfirmed += 1;
    } else if (source === 'rescued_miss') {
      this.data.stats.totalRescued += 1;
    }

    this.data.feedbackLog.unshift({
      id: feedbackId,
      matchId: matchId || null,
      action: source === 'rescued_miss' ? 'rescue' : 'confirm',
      distance: entry.distance,
      timestamp: entry.timestamp,
      undone: false
    });

    if (this.data.feedbackLog.length > 200) {
      this.data.feedbackLog = this.data.feedbackLog.slice(0, 200);
    }

    this.save();
    return feedbackId;
  }

  /**
   * User rejects a match (false positive) -> hard negative.
   */
  addNegative(descriptor, distance, matchId, source = 'rejected_match') {
    if (!descriptor) throw new Error('Descriptor is required');

    const feedbackId = `fb_neg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
      id: feedbackId,
      descriptor: Array.from(descriptor),
      distance: distance !== null && distance !== undefined ? Number(distance) : null,
      matchId: matchId || null,
      source,
      timestamp: new Date().toISOString()
    };

    this.data.negatives.push(entry);
    this.data.stats.totalRejected += 1;

    this.data.feedbackLog.unshift({
      id: feedbackId,
      matchId: matchId || null,
      action: 'reject',
      distance: entry.distance,
      timestamp: entry.timestamp,
      undone: false
    });

    if (this.data.feedbackLog.length > 200) {
      this.data.feedbackLog = this.data.feedbackLog.slice(0, 200);
    }

    this.save();
    return feedbackId;
  }

  /**
   * Automatically mined negative face (distance >= 0.8 from child profile).
   * Capped at 50 auto-negatives to keep storage bounded and diverse.
   */
  addAutoNegative(descriptor, distance) {
    if (!descriptor) return null;

    const autoNegatives = this.data.negatives.filter(n => n.source === 'auto_background');
    if (autoNegatives.length >= 50) {
      // Find oldest auto negative and remove it
      const oldestIdx = this.data.negatives.findIndex(n => n.source === 'auto_background');
      if (oldestIdx !== -1) {
        this.data.negatives.splice(oldestIdx, 1);
      }
    }

    const id = `fb_auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
      id,
      descriptor: Array.from(descriptor),
      distance: distance !== null && distance !== undefined ? Number(distance) : null,
      matchId: null,
      source: 'auto_background',
      timestamp: new Date().toISOString()
    };

    this.data.negatives.push(entry);
    this.data.stats.totalAutoNegatives += 1;
    this.save();
    return id;
  }

  /**
   * Undo a previous feedback action.
   */
  undoFeedback(feedbackId) {
    const logIndex = this.data.feedbackLog.findIndex(item => item.id === feedbackId);
    if (logIndex === -1) return false;

    const logEntry = this.data.feedbackLog[logIndex];
    if (logEntry.undone) return false;

    // Remove from positives or negatives
    const posIndex = this.data.positives.findIndex(p => p.id === feedbackId);
    if (posIndex !== -1) {
      const removed = this.data.positives.splice(posIndex, 1)[0];
      if (removed.source === 'confirmed_match' && this.data.stats.totalConfirmed > 0) {
        this.data.stats.totalConfirmed -= 1;
      } else if (removed.source === 'rescued_miss' && this.data.stats.totalRescued > 0) {
        this.data.stats.totalRescued -= 1;
      }
    }

    const negIndex = this.data.negatives.findIndex(n => n.id === feedbackId);
    if (negIndex !== -1) {
      this.data.negatives.splice(negIndex, 1);
      if (this.data.stats.totalRejected > 0) {
        this.data.stats.totalRejected -= 1;
      }
    }

    logEntry.undone = true;
    this.save();
    return true;
  }

  getPositives() {
    return this.data.positives.map(p => new Float32Array(p.descriptor));
  }

  getNegatives() {
    return this.data.negatives.map(n => new Float32Array(n.descriptor));
  }

  getHardNegatives() {
    return this.data.negatives.filter(n => n.source === 'rejected_match').map(n => new Float32Array(n.descriptor));
  }

  getStats() {
    const hardNegatives = this.data.negatives.filter(n => n.source === 'rejected_match');
    const autoNegatives = this.data.negatives.filter(n => n.source === 'auto_background');

    return {
      positiveCount: this.data.positives.length,
      negativeCount: this.data.negatives.length,
      hardNegativeCount: hardNegatives.length,
      autoNegativeCount: autoNegatives.length,
      totalConfirmed: this.data.stats.totalConfirmed,
      totalRejected: this.data.stats.totalRejected,
      totalRescued: this.data.stats.totalRescued,
      totalAutoNegatives: this.data.stats.totalAutoNegatives,
      cachedDescriptorCount: Object.keys(this.descriptorCache).length
    };
  }

  getFeedbackLog(limit = 50) {
    return this.data.feedbackLog.slice(0, limit);
  }

  reset() {
    this.data = {
      version: 1,
      positives: [],
      negatives: [],
      feedbackLog: [],
      stats: {
        totalConfirmed: 0,
        totalRejected: 0,
        totalRescued: 0,
        totalAutoNegatives: 0
      }
    };
    this.descriptorCache = {};
    this.save();
    this.saveDescriptorCache();
    return true;
  }
}

module.exports = FeedbackStore;
