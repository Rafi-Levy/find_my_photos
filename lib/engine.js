const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const QRCode = require('qrcode');
const { createClient, createSafeSender, destroyClient } = require('./whatsapp');
const { loadModels, extractAllDescriptors, extractSingleDescriptor, anyFaceMatches, averageDescriptors, loadReference } = require('./faceMatch');
const { loadCache, saveCache, getCachedEntry, setCachedEntry } = require('./faceCache');
const { withExtractedFrames } = require('./videoFrames');
const DedupeTracker = require('./dedupe');
const StatsTracker = require('./stats');
const { searchIndexedDBChats, updateEnvFile } = require('./chatSelector');
const FeedbackStore = require('./feedbackStore');
const ClassifierHead = require('./classifierHead');
const NearMissBuffer = require('./nearMissBuffer');

class ForwarderEngine extends EventEmitter {
  constructor() {
    super();
    this.rootDir = path.resolve(__dirname, '..');
    this.envPath = path.join(this.rootDir, '.env');
    this.envExamplePath = path.join(this.rootDir, '.env.example');

    this.ensureBaseFiles();
    this.config = this.loadConfig();

    this.statsTracker = new StatsTracker(path.join(this.rootDir, 'data', 'stats.json'));
    this.dedupe = new DedupeTracker(path.join(this.rootDir, 'data', 'processed-ids.json'));
    this.feedbackStore = new FeedbackStore(
      path.join(this.rootDir, 'data', 'feedback.json'),
      path.join(this.rootDir, 'data', 'descriptor-cache.json')
    );
    this.classifierHead = new ClassifierHead(
      path.join(this.rootDir, 'data', 'classifier-head')
    );
    this.nearMisses = new NearMissBuffer(
      path.join(this.rootDir, 'data', 'near-misses.json'),
      this.config.previewDir
    );

    this.state = 'INITIALIZING'; // INITIALIZING, WAITING_FOR_QR, CONNECTING, READY, DISCONNECTED
    this.monitoringActive = true;
    this.whatsappClient = null;
    this.safeSendMessage = null;
    this.referenceDescriptor = null;
    this.modelsLoaded = false;
    this.latestQr = null;
    this.userInfo = null;
    this.logs = [];

    // Processing queue
    this.queue = [];
    this.isProcessing = false;
  }

  ensureBaseFiles() {
    const dirs = [
      path.join(this.rootDir, 'train_photos'),
      path.join(this.rootDir, 'data'),
      path.join(this.rootDir, 'logs'),
      path.join(this.rootDir, 'matches_preview'),
      path.join(this.rootDir, 'models')
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.envPath) && fs.existsSync(this.envExamplePath)) {
      try {
        fs.copyFileSync(this.envExamplePath, this.envPath);
      } catch {}
    }
  }

  loadConfig() {
    require('dotenv').config({ path: this.envPath, override: true });
    return {
      sourceChatId: process.env.SOURCE_CHAT_ID || '',
      targetChatId: process.env.TARGET_CHAT_ID || '',
      matchThreshold: parseFloat(process.env.MATCH_THRESHOLD || '0.5'),
      videoFrames: parseInt(process.env.VIDEO_FRAMES_TO_CHECK || '5', 10),
      referencePath: path.resolve(this.rootDir, process.env.REFERENCE_EMBEDDING_PATH || './data/child-reference.json'),
      sessionPath: path.resolve(this.rootDir, process.env.SESSION_DATA_PATH || './.wwebjs_auth'),
      logPath: path.resolve(this.rootDir, process.env.LOG_PATH || './logs/activity.log'),
      modelsPath: path.resolve(this.rootDir, process.env.MODELS_PATH || './models'),
      previewDir: path.resolve(this.rootDir, process.env.MATCH_PREVIEW_PATH || './matches_preview'),
      trainPhotosDir: path.resolve(this.rootDir, process.env.TRAIN_PHOTOS_PATH || './train_photos'),
      trainCachePath: path.resolve(this.rootDir, process.env.TRAIN_CACHE_PATH || './data/train-cache.json'),
      enableForwarding: process.env.ENABLE_FORWARDING === 'true',
      allowGroupForwarding: process.env.ALLOW_GROUP_FORWARDING === 'true'
    };
  }

  log(level, message, meta = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      meta
    };
    this.logs.unshift(entry);
    if (this.logs.length > 200) this.logs = this.logs.slice(0, 200);

    // Also append to activity.log
    try {
      fs.appendFileSync(
        this.config.logPath,
        `[${entry.timestamp}] [${level.toUpperCase()}] ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}\n`
      );
    } catch {}

    this.emit('log', entry);
    console.log(`[${level.toUpperCase()}] ${message}`);
  }

  async init() {
    this.log('info', 'Initializing Forwarder Engine...');

    // 1. Load models
    try {
      await loadModels(this.config.modelsPath);
      this.modelsLoaded = true;
      this.log('info', 'Face recognition models loaded.');
    } catch (err) {
      this.log('warn', `Models not yet downloaded or failed to load: ${err.message}`);
    }

    // 2. Load reference embeddings (supports multi-child profiles)
    this.reloadReference();

    // 3. Load trained classifier head model if available
    try {
      const loaded = await this.classifierHead.load();
      if (loaded) {
        const refHash = this.computeReferenceHash();
        if (this.classifierHead.isModelStale(refHash)) {
          this.log('warn', 'Reference embeddings changed since classifier was trained — resetting classifier model.');
          this.classifierHead.reset();
        } else {
          this.log('info', `Classifier head loaded (F1: ${(this.classifierHead.loocvF1 * 100).toFixed(1)}%, trained on ${this.classifierHead.trainingDataSize} samples).`);
        }
      }
    } catch (err) {
      this.log('warn', `Could not initialize classifier head: ${err.message}`);
    }
    this.nearMisses.prune();

    // 4. Initialize WhatsApp Client
    this.initWhatsApp();
  }

  reloadReference() {
    this.profiles = [];
    try {
      if (fs.existsSync(this.config.referencePath)) {
        const raw = fs.readFileSync(this.config.referencePath, 'utf-8');
        const data = JSON.parse(raw);

        if (Array.isArray(data.children) && data.children.length > 0) {
          this.profiles = data.children.map(c => ({
            name: c.name || 'Child',
            descriptor: new Float32Array(c.descriptor),
            photosUsed: c.photosUsed || 0,
            createdAt: c.createdAt || new Date().toISOString()
          }));
        } else if (data.descriptor) {
          // Legacy single child profile
          this.profiles = [{
            name: data.childName || 'My Child',
            descriptor: new Float32Array(data.descriptor),
            photosUsed: data.photosUsed || 0,
            createdAt: data.createdAt || new Date().toISOString()
          }];
        }

        if (this.profiles.length > 0) {
          this.referenceDescriptor = this.profiles[0].descriptor;
          const names = this.profiles.map(p => p.name).join(', ');
          this.log('info', `Face profile(s) loaded for: ${names}`);
          this.emit('reference_updated', this.getReferenceInfo());

          const refHash = this.computeReferenceHash();
          if (this.classifierHead && this.classifierHead.isModelStale(refHash)) {
            this.log('warn', 'Reference profile updated — resetting classifier head model.');
            this.classifierHead.reset();
          }

          return true;
        }
      }
    } catch (err) {
      this.log('warn', `Could not load reference embeddings: ${err.message}`);
    }
    this.referenceDescriptor = null;
    this.profiles = [];
    return false;
  }

  getReferenceInfo() {
    if (this.profiles.length === 0) {
      return { enrolled: false, children: [] };
    }
    return {
      enrolled: true,
      count: this.profiles.length,
      children: this.profiles.map(p => ({
        name: p.name,
        photosUsed: p.photosUsed,
        createdAt: p.createdAt
      }))
    };
  }

  matchAgainstProfiles(descriptors, threshold = this.config.matchThreshold) {
    if (this.profiles.length === 0 || descriptors.length === 0) {
      return { matched: false, childName: null, distance: null, bestDistance: null };
    }

    let globalMinDistance = Infinity;
    let bestChild = null;

    for (const desc of descriptors) {
      for (const profile of this.profiles) {
        // Euclidean distance
        let sum = 0;
        for (let i = 0; i < 128; i++) {
          const diff = desc[i] - profile.descriptor[i];
          sum += diff * diff;
        }
        const dist = Math.sqrt(sum);

        if (dist < globalMinDistance) {
          globalMinDistance = dist;
          bestChild = profile.name;
        }

        if (dist < threshold) {
          return {
            matched: true,
            childName: profile.name,
            distance: dist,
            bestDistance: dist,
            confidence: Math.max(0, Math.round((1 - dist / 1.0) * 100))
          };
        }
      }
    }

    return {
      matched: false,
      childName: bestChild,
      distance: null,
      bestDistance: globalMinDistance === Infinity ? null : globalMinDistance,
      confidence: globalMinDistance === Infinity ? 0 : Math.max(0, Math.round((1 - globalMinDistance / 1.0) * 100))
    };
  }

  euclideanDistance128(a, b) {
    let sum = 0;
    for (let i = 0; i < 128; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  computeReferenceHash() {
    if (!this.profiles || this.profiles.length === 0) return '';
    const crypto = require('crypto');
    const data = this.profiles
      .map(p => Array.from(p.descriptor).map(n => n.toFixed(5)).join(','))
      .join('|');
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
  }

  getClassifierWeight() {
    if (!this.classifierHead || !this.classifierHead.isReady()) return 0;
    const n = this.classifierHead.trainingDataSize || 0;
    const f1 = this.classifierHead.loocvF1 || 0;
    const sizeConfidence = 1 / (1 + Math.exp(-0.15 * (n - 30)));
    const f1Confidence = Math.min(1, Math.max(0, (f1 - 0.80) / 0.15));
    return 0.7 * sizeConfidence * f1Confidence;
  }

  /**
   * Score face descriptors using Layer 1 (Multi-Exemplar + Hard Negative Rejection)
   * and Layer 2 (Fine-Tuned Classifier Head) with adaptive ensemble weighting.
   */
  scoreWithFeedback(descriptors, threshold = this.config.matchThreshold) {
    if (!descriptors || descriptors.length === 0 || this.profiles.length === 0) {
      return {
        matched: false,
        childName: null,
        distance: null,
        bestDistance: null,
        confidence: 0,
        score: 0,
        method: 'none',
        rejectedByNegative: false,
        classifierProbability: null,
        classifierWeight: 0,
        bestDescriptor: null,
        bestDescriptorIdx: -1
      };
    }

    // --- Layer 1: Multi-Exemplar Distance Matching ---
    let bestPositiveDist = Infinity;
    let bestChild = null;
    let bestDescriptor = null;
    let bestDescriptorIdx = -1;

    // 1a. Check against enrolled profiles
    for (let di = 0; di < descriptors.length; di++) {
      const desc = descriptors[di];
      for (const profile of this.profiles) {
        const dist = this.euclideanDistance128(desc, profile.descriptor);
        if (dist < bestPositiveDist) {
          bestPositiveDist = dist;
          bestChild = profile.name;
          bestDescriptor = desc;
          bestDescriptorIdx = di;
        }
      }
    }

    // 1b. Check against confirmed positive exemplars from user feedback
    const positiveExemplars = this.feedbackStore ? this.feedbackStore.getPositives() : [];
    for (let di = 0; di < descriptors.length; di++) {
      const desc = descriptors[di];
      for (const exemplar of positiveExemplars) {
        const dist = this.euclideanDistance128(desc, exemplar);
        if (dist < bestPositiveDist) {
          bestPositiveDist = dist;
          bestDescriptor = desc;
          bestDescriptorIdx = di;
          if (!bestChild) bestChild = this.profiles[0]?.name || 'My Child';
        }
      }
    }

    const distanceMatch = bestPositiveDist < threshold;
    const distanceScore = bestPositiveDist < Infinity
      ? Math.max(0, 1 - bestPositiveDist / 1.0)
      : 0;

    // 1c. Hard Negative Rejection Check
    let rejectedByNegative = false;
    const hardNegatives = this.feedbackStore ? this.feedbackStore.getHardNegatives() : [];
    if (hardNegatives.length > 0 && bestDescriptor) {
      let nearestNegDist = Infinity;
      for (const neg of hardNegatives) {
        const dist = this.euclideanDistance128(bestDescriptor, neg);
        if (dist < nearestNegDist) nearestNegDist = dist;
      }
      if (nearestNegDist < bestPositiveDist) {
        rejectedByNegative = true;
      }
    }

    // --- Layer 2: Classifier Head Inference ---
    const classifierWeight = this.getClassifierWeight();
    let classifierProb = null;
    if (classifierWeight > 0) {
      const pred = this.classifierHead.predictBest(descriptors);
      if (pred) {
        classifierProb = pred.probability;
      }
    }

    // --- Ensemble Blending ---
    let finalScore;
    let method;
    if (classifierProb !== null && classifierWeight > 0) {
      finalScore = classifierWeight * classifierProb + (1 - classifierWeight) * distanceScore;
      method = `ensemble_${Math.round(classifierWeight * 100)}pct_classifier`;
    } else {
      finalScore = distanceScore;
      method = 'exemplar_distance';
    }

    if (rejectedByNegative) {
      finalScore *= 0.3;
      method += '+negative_penalty';
    }

    const matchCutoff = 1 - threshold;
    const matched = finalScore > matchCutoff;

    return {
      matched,
      childName: bestChild || (this.profiles[0]?.name || 'My Child'),
      distance: matched ? (bestPositiveDist < Infinity ? bestPositiveDist : null) : null,
      bestDistance: bestPositiveDist < Infinity ? bestPositiveDist : null,
      confidence: Math.max(0, Math.min(100, Math.round(finalScore * 100))),
      score: Number(finalScore.toFixed(4)),
      method,
      rejectedByNegative,
      classifierProbability: classifierProb !== null ? Number(classifierProb.toFixed(4)) : null,
      classifierWeight: Number(classifierWeight.toFixed(4)),
      bestDescriptor,
      bestDescriptorIdx
    };
  }

  saveNearMiss(media, msgId, descriptor, distance) {
    if (!this.nearMisses || !descriptor) return null;
    try {
      const entry = this.nearMisses.add(media, msgId, descriptor, distance);
      this.emit('near_miss', entry);
      return entry;
    } catch (err) {
      this.log('warn', `Failed to record near-miss: ${err.message}`);
      return null;
    }
  }

  async confirmMatch(matchId) {
    const cached = this.feedbackStore.getCachedDescriptor(matchId);
    if (!cached || !cached.bestDescriptor) {
      throw new Error(`Descriptor not found for match ${matchId}. It may have expired or not yet been recorded.`);
    }

    const feedbackId = this.feedbackStore.addPositive(
      cached.bestDescriptor,
      cached.distance,
      matchId,
      'confirmed_match'
    );

    this.log('info', `Feedback: Match ${matchId} confirmed as correct. Background retrain triggered...`);
    this.retrainInBackground();

    return {
      success: true,
      action: 'confirmed',
      feedbackId,
      stats: this.feedbackStore.getStats()
    };
  }

  async rejectMatch(matchId) {
    const cached = this.feedbackStore.getCachedDescriptor(matchId);
    if (!cached || !cached.bestDescriptor) {
      throw new Error(`Descriptor not found for match ${matchId}. It may have expired or not yet been recorded.`);
    }

    const feedbackId = this.feedbackStore.addNegative(
      cached.bestDescriptor,
      cached.distance,
      matchId,
      'rejected_match'
    );

    this.log('info', `Feedback: Match ${matchId} rejected as false positive. Added to hard negatives. Background retrain triggered...`);
    this.retrainInBackground();

    return {
      success: true,
      action: 'rejected',
      feedbackId,
      stats: this.feedbackStore.getStats()
    };
  }

  async rescueMiss(nearMissId) {
    const nearMiss = this.nearMisses.getById(nearMissId);
    if (!nearMiss || !nearMiss.descriptor) {
      throw new Error(`Near-miss ${nearMissId} not found or expired.`);
    }

    const feedbackId = this.feedbackStore.addPositive(
      nearMiss.descriptor,
      nearMiss.bestDistance,
      nearMissId,
      'rescued_miss'
    );

    this.nearMisses.remove(nearMissId);
    this.log('info', `Feedback: Near-miss ${nearMissId} rescued as true match! Background retrain triggered...`);
    this.retrainInBackground();

    return {
      success: true,
      action: 'rescued',
      feedbackId,
      stats: this.feedbackStore.getStats()
    };
  }

  async undoFeedback(feedbackId) {
    const undone = this.feedbackStore.undoFeedback(feedbackId);
    if (!undone) {
      throw new Error(`Feedback entry ${feedbackId} not found or already undone.`);
    }

    this.log('info', `Feedback ${feedbackId} undone. Triggering retrain...`);
    this.retrainInBackground();

    return {
      success: true,
      action: 'undone',
      feedbackId,
      stats: this.feedbackStore.getStats()
    };
  }

  retrainInBackground() {
    setImmediate(async () => {
      try {
        const positives = this.feedbackStore.getPositives();
        const negatives = this.feedbackStore.getNegatives();
        const referenceDescs = this.profiles.map(p => p.descriptor);

        const result = await this.classifierHead.train(
          positives,
          negatives,
          referenceDescs
        );

        if (result) {
          if (result.success) {
            this.classifierHead.currentReferenceHash = this.computeReferenceHash();
            this.classifierHead.saveMetadata();

            this.log('info', `Classifier head retrained! F1: ${(result.f1 * 100).toFixed(1)}% | Precision: ${(result.precision * 100).toFixed(0)}% Recall: ${(result.recall * 100).toFixed(0)}% (${result.positiveCount}+ / ${result.negativeCount}- samples).`);
          } else {
            this.log('info', `Classifier training status: ${result.reason}`);
          }

          this.emit('feedback_update', {
            classifier: this.classifierHead.getDiagnostics(),
            feedback: this.feedbackStore.getStats()
          });
        }
      } catch (err) {
        this.log('warn', `Error during classifier retrain: ${err.message}`);
      }
    });
  }

  initWhatsApp() {
    this.state = 'CONNECTING';
    this.emit('status', this.getStatus());

    const clientLogger = {
      info: (msg, meta) => this.log('info', msg, meta),
      warn: (msg, meta) => this.log('warn', msg, meta),
      error: (msg, meta) => this.log('error', msg, meta)
    };

    const client = createClient({
      sessionPath: this.config.sessionPath,
      logger: clientLogger,
      onReady: async (readyClient) => {
        this.state = 'READY';
        this.latestQr = null;

        try {
          const info = readyClient.info;
          this.userInfo = {
            pushname: info?.pushname || 'User',
            wid: info?.wid?._serialized || info?.wid?.user || 'Connected',
            platform: info?.platform || ''
          };
        } catch {
          this.userInfo = { pushname: 'WhatsApp User', wid: 'Connected' };
        }

        this.updateSafeSender();
        this.log('info', `WhatsApp connected successfully as ${this.userInfo.pushname} (${this.userInfo.wid})`);
        this.emit('status', this.getStatus());
      },
      onMessage: (msg) => {
        if (!this.monitoringActive) return;
        this.handleIncomingMessage(msg);
      }
    });

    client.on('qr', async (qr) => {
      this.state = 'WAITING_FOR_QR';
      try {
        this.latestQr = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
      } catch {
        this.latestQr = null;
      }
      this.emit('status', this.getStatus());
      this.emit('qr', { qrDataUrl: this.latestQr, raw: qr });
      this.log('info', 'New WhatsApp QR code generated. Scan with phone to connect.');
    });

    client.on('authenticated', () => {
      this.state = 'CONNECTING';
      this.latestQr = null;
      this.log('info', 'WhatsApp session authenticated.');
      this.emit('status', this.getStatus());
    });

    client.on('auth_failure', (msg) => {
      this.state = 'DISCONNECTED';
      this.latestQr = null;
      this.log('error', `WhatsApp authentication failed: ${msg}`);
      this.emit('status', this.getStatus());
    });

    client.on('disconnected', (reason) => {
      this.state = 'DISCONNECTED';
      this.userInfo = null;
      this.log('warn', `WhatsApp disconnected (${reason}).`);
      this.emit('status', this.getStatus());
    });

    this.whatsappClient = client;
    client.initialize().catch((err) => {
      this.log('error', `WhatsApp initialization error: ${err.message}`);
    });
  }

  updateSafeSender() {
    if (!this.whatsappClient) return;
    this.safeSendMessage = createSafeSender(this.whatsappClient, {
      sourceChatId: this.config.sourceChatId,
      enableForwarding: this.config.enableForwarding,
      allowGroupForwarding: this.config.allowGroupForwarding,
      logger: {
        info: (msg, m) => this.log('info', msg, m),
        warn: (msg, m) => this.log('warn', msg, m),
        error: (msg, m) => this.log('error', msg, m)
      }
    });
  }

  getStatus() {
    return {
      state: this.state,
      monitoringActive: this.monitoringActive,
      hasQr: Boolean(this.latestQr),
      qrDataUrl: this.latestQr,
      userInfo: this.userInfo,
      enrolled: Boolean(this.referenceDescriptor),
      referenceInfo: this.getReferenceInfo(),
      feedback: this.feedbackStore ? this.feedbackStore.getStats() : null,
      classifier: this.classifierHead ? this.classifierHead.getDiagnostics() : null,
      nearMissCount: this.nearMisses ? this.nearMisses.getAll().length : 0,
      config: {
        sourceChatId: this.config.sourceChatId,
        targetChatId: this.config.targetChatId,
        enableForwarding: this.config.enableForwarding,
        matchThreshold: this.config.matchThreshold,
        videoFrames: this.config.videoFrames
      }
    };
  }

  setMonitoring(active) {
    this.monitoringActive = Boolean(active);
    this.log('info', `Monitoring is now ${this.monitoringActive ? 'ACTIVE' : 'PAUSED'}.`);
    this.emit('status', this.getStatus());
    return this.getStatus();
  }

  async logout() {
    this.log('info', 'Logging out of WhatsApp session...');
    this.state = 'DISCONNECTED';
    this.userInfo = null;
    this.latestQr = null;
    try {
      if (this.whatsappClient) {
        await destroyClient(this.whatsappClient);
        this.whatsappClient = null;
      }
      // Delete session data directory
      if (fs.existsSync(this.config.sessionPath)) {
        fs.rmSync(this.config.sessionPath, { recursive: true, force: true });
      }
    } catch (err) {
      this.log('error', `Error during logout: ${err.message}`);
    }
    this.initWhatsApp();
  }

  async getChats(search = '') {
    if (!this.whatsappClient || this.state !== 'READY' || !this.whatsappClient.pupPage) {
      return [];
    }
    try {
      const results = await searchIndexedDBChats(this.whatsappClient.pupPage, search);
      return results;
    } catch (err) {
      this.log('warn', `Could not search WhatsApp chats: ${err.message}`);
      return [];
    }
  }

  saveConfig(updates) {
    updateEnvFile(updates, this.envPath);
    this.config = this.loadConfig();
    this.updateSafeSender();
    this.log('info', 'Settings updated successfully.');
    this.emit('status', this.getStatus());
    return this.getStatus();
  }

  getMessageId(msg) {
    if (!msg) return `${Date.now()}`;
    if (typeof msg.id === 'string') return msg.id;
    if (msg.id && typeof msg.id === 'object') {
      if (msg.id._serialized) return msg.id._serialized;
      if (msg.id.$1) return msg.id.$1;
      const remote = typeof msg.id.remote === 'object'
        ? (msg.id.remote?._serialized || msg.id.remote?.$1 || msg.id.remote?.user || '')
        : (msg.id.remote || '');
      if (remote && msg.id.id) {
        const fromMe = msg.id.fromMe !== undefined ? msg.id.fromMe : (msg.fromMe ?? false);
        return `${fromMe}_${remote}_${msg.id.id}`;
      }
      if (msg.id.id) return msg.id.id;
    }
    return `${Date.now()}`;
  }

  handleIncomingMessage(msg) {
    if (!this.config.sourceChatId) return;

    const remoteChatId = typeof msg.id?.remote === 'object'
      ? (msg.id.remote?._serialized || msg.id.remote?.$1 || msg.id.remote?.user)
      : msg.id?.remote;
    const isFromSource = (
      remoteChatId === this.config.sourceChatId ||
      msg.from === this.config.sourceChatId ||
      msg.to === this.config.sourceChatId
    );

    if (!isFromSource) return;

    const isImage = msg.type === 'image' || (msg.hasMedia && msg.mimetype?.startsWith('image/'));
    const isVideo = msg.type === 'video' || (msg.hasMedia && msg.mimetype?.startsWith('video/'));

    if (!isImage && !isVideo) return;

    const msgId = this.getMessageId(msg);
    if (this.dedupe.isProcessed(msgId)) return;
    this.dedupe.markProcessed(msgId);

    this.queue.push({ msg, msgId, isImage, isVideo });
    this.processQueue();
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const item = this.queue.shift();
    try {
      if (item.isImage) {
        await this.processImage(item.msg, item.msgId);
      } else if (item.isVideo) {
        await this.processVideo(item.msg, item.msgId);
      }
    } catch (err) {
      this.log('error', `Error processing media: ${err.message}`);
    } finally {
      this.isProcessing = false;
      setImmediate(() => this.processQueue());
    }
  }

  savePreview(media, msgId, meta = {}) {
    try {
      if (!fs.existsSync(this.config.previewDir)) {
        fs.mkdirSync(this.config.previewDir, { recursive: true });
      }
      const safeId = msgId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const timestamp = Date.now();
      const ext = media.mimetype?.split('/')[1]?.split(';')[0] || (meta.mediaType === 'video' ? 'mp4' : 'jpg');
      const mediaFilename = `match_${timestamp}_${safeId}.${ext}`;
      const mediaPath = path.join(this.config.previewDir, mediaFilename);

      fs.writeFileSync(mediaPath, Buffer.from(media.data, 'base64'));
      return mediaFilename;
    } catch (err) {
      this.log('error', `Failed to save preview: ${err.message}`);
      return null;
    }
  }

  async processImage(msg, msgId) {
    if (!this.referenceDescriptor) {
      this.log('warn', 'Ignored image because child face is not yet enrolled.');
      return;
    }

    this.statsTracker.recordCheck('image');
    this.emit('stats', this.statsTracker.getStats());

    this.log('info', `Checking photo from watched group...`);

    let media = await msg.downloadMedia();
    if (!media) {
      await new Promise(res => setTimeout(res, 1000));
      media = await msg.downloadMedia();
    }
    if (!media) {
      this.log('warn', 'Could not download photo (expired or not ready).');
      return;
    }

    const buffer = Buffer.from(media.data, 'base64');
    const descriptors = await extractAllDescriptors(buffer);

    if (descriptors.length === 0) {
      this.log('info', 'No faces found in photo.');
      return;
    }

    const result = this.scoreWithFeedback(descriptors, this.config.matchThreshold);

    if (result.matched) {
      const filename = this.savePreview(media, msgId, {
        mediaType: 'image',
        childName: result.childName,
        distance: result.distance ? result.distance.toFixed(4) : null,
        caption: msg.body || ''
      });

      // Cache the descriptor for future feedback
      if (result.bestDescriptor) {
        this.feedbackStore.cacheDescriptor(msgId, result.bestDescriptor, result.distance);
      }

      let forwarded = false;
      let reason = 'DRY_RUN';

      if (this.safeSendMessage && this.config.targetChatId) {
        const sendResult = await this.safeSendMessage(this.config.targetChatId, media, {
          caption: msg.body || ''
        });

        if (sendResult && sendResult.sent === false) {
          reason = sendResult.reason;
        } else {
          forwarded = true;
          reason = 'FORWARDED';
          this.statsTracker.recordForward();
        }
      }

      const matchEntry = this.statsTracker.recordMatch({
        msgId,
        mediaType: 'image',
        childName: result.childName,
        distance: result.distance ? result.distance.toFixed(4) : null,
        filename,
        caption: msg.body || '',
        forwarded,
        reason,
        method: result.method,
        score: result.score,
        classifierProbability: result.classifierProbability
      });

      const childTag = result.childName ? ` (${result.childName})` : '';
      this.log('info', `Child face matched in photo!${childTag} (${result.confidence}% match, method: ${result.method}) — ${forwarded ? 'Forwarded' : 'Saved to Review'}.`);
      this.emit('stats', this.statsTracker.getStats());
      this.emit('match', matchEntry);
    } else {
      this.log('info', `Checked photo: faces found, but no child match (best distance: ${result.bestDistance !== null ? result.bestDistance.toFixed(3) : 'none'}, threshold: ${this.config.matchThreshold}, method: ${result.method}).`);

      // 1. Near-miss tracking (borderline faces just outside threshold)
      if (result.bestDistance !== null && result.bestDescriptor &&
          result.bestDistance < this.config.matchThreshold + 0.12 &&
          result.bestDistance >= this.config.matchThreshold) {
        this.saveNearMiss(media, msgId, result.bestDescriptor, result.bestDistance);
      }

      // 2. Auto-negative mining (unambiguous non-match faces: distance >= 0.8)
      if (this.profiles.length > 0) {
        for (const desc of descriptors) {
          let minDist = Infinity;
          for (const p of this.profiles) {
            const d = this.euclideanDistance128(desc, p.descriptor);
            if (d < minDist) minDist = d;
          }
          if (minDist >= 0.8) {
            this.feedbackStore.addAutoNegative(desc, minDist);
            break;
          }
        }
      }
    }
  }

  async processVideo(msg, msgId) {
    if (!this.referenceDescriptor) {
      this.log('warn', 'Ignored video because child face is not yet enrolled.');
      return;
    }

    this.statsTracker.recordCheck('video');
    this.emit('stats', this.statsTracker.getStats());

    this.log('info', `Checking video from watched group...`);

    let media = await msg.downloadMedia();
    if (!media) {
      await new Promise(res => setTimeout(res, 1000));
      media = await msg.downloadMedia();
    }
    if (!media) {
      this.log('warn', 'Could not download video.');
      return;
    }

    const tempVideoPath = path.join(os.tmpdir(), `vid_${Date.now()}_${msgId.replace(/[^a-zA-Z0-9_-]/g, '_')}.mp4`);
    fs.writeFileSync(tempVideoPath, Buffer.from(media.data, 'base64'));

    try {
      const matched = await withExtractedFrames(
        tempVideoPath,
        this.config.videoFrames,
        async (framePaths) => {
          let globalMinDistance = Infinity;
          let bestDescriptor = null;
          let bestFrameIdx = -1;

          for (let i = 0; i < framePaths.length; i++) {
            await new Promise(resolve => setImmediate(resolve));
            const frameBuffer = fs.readFileSync(framePaths[i]);
            const descriptors = await extractAllDescriptors(frameBuffer);
            if (descriptors.length > 0) {
              const res = this.scoreWithFeedback(descriptors, this.config.matchThreshold);
              if (res.bestDistance !== null && res.bestDistance < globalMinDistance) {
                globalMinDistance = res.bestDistance;
                bestDescriptor = res.bestDescriptor;
                bestFrameIdx = i + 1;
              }
              if (res.matched) {
                return {
                  matched: true,
                  childName: res.childName,
                  distance: res.distance,
                  frame: i + 1,
                  method: res.method,
                  score: res.score,
                  classifierProbability: res.classifierProbability,
                  bestDescriptor: res.bestDescriptor,
                  confidence: res.confidence
                };
              }
            }
          }
          return {
            matched: false,
            bestDistance: globalMinDistance === Infinity ? null : globalMinDistance,
            bestDescriptor,
            bestFrameIdx
          };
        }
      );

      if (matched.matched) {
        const filename = this.savePreview(media, msgId, {
          mediaType: 'video',
          childName: matched.childName,
          distance: matched.distance ? matched.distance.toFixed(4) : null,
          caption: msg.body || ''
        });

        if (matched.bestDescriptor) {
          this.feedbackStore.cacheDescriptor(msgId, matched.bestDescriptor, matched.distance);
        }

        let forwarded = false;
        let reason = 'DRY_RUN';

        if (this.safeSendMessage && this.config.targetChatId) {
          const sendResult = await this.safeSendMessage(this.config.targetChatId, media, {
            caption: msg.body || ''
          });

          if (sendResult && sendResult.sent === false) {
            reason = sendResult.reason;
          } else {
            forwarded = true;
            reason = 'FORWARDED';
            this.statsTracker.recordForward();
          }
        }

        const matchEntry = this.statsTracker.recordMatch({
          msgId,
          mediaType: 'video',
          childName: matched.childName,
          distance: matched.distance ? matched.distance.toFixed(4) : null,
          filename,
          caption: msg.body || '',
          forwarded,
          reason,
          method: matched.method,
          score: matched.score,
          classifierProbability: matched.classifierProbability
        });

        const childTag = matched.childName ? ` (${matched.childName})` : '';
        this.log('info', `Child face matched in video!${childTag} (${matched.confidence || ((1 - matched.distance) * 100).toFixed(0)}% match, method: ${matched.method || 'exemplar_distance'}) — ${forwarded ? 'Forwarded' : 'Saved to Review'}.`);
        this.emit('stats', this.statsTracker.getStats());
        this.emit('match', matchEntry);
      } else {
        this.log('info', `Checked video: no child match across ${this.config.videoFrames} frames (best dist: ${matched.bestDistance !== null ? matched.bestDistance.toFixed(3) : 'none'}).`);

        // Near-miss tracking for video
        if (matched.bestDistance !== null && matched.bestDescriptor &&
            matched.bestDistance < this.config.matchThreshold + 0.12 &&
            matched.bestDistance >= this.config.matchThreshold) {
          this.saveNearMiss(media, msgId, matched.bestDescriptor, matched.bestDistance);
        }

        // Auto-negative mining for video
        if (matched.bestDistance !== null && matched.bestDistance >= 0.8 && matched.bestDescriptor) {
          this.feedbackStore.addAutoNegative(matched.bestDescriptor, matched.bestDistance);
        }
      }
    } finally {
      try { fs.unlinkSync(tempVideoPath); } catch {}
    }
  }

  // --- Training Workflow ---

  getTrainingPhotos() {
    const dir = this.config.trainPhotosDir;
    if (!fs.existsSync(dir)) return [];
    const exts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
    return fs.readdirSync(dir)
      .filter(f => exts.includes(path.extname(f).toLowerCase()))
      .map(name => ({
        name,
        url: `/train_photos/${encodeURIComponent(name)}`,
        size: fs.statSync(path.join(dir, name)).size
      }));
  }

  deleteTrainingPhoto(name) {
    const filePath = path.join(this.config.trainPhotosDir, path.basename(name));
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  async runTraining(onProgress, childName) {
    this.log('info', 'Starting face recognition training...');

    const dir = this.config.trainPhotosDir;
    const exts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
    const files = fs.readdirSync(dir).filter(f => exts.includes(path.extname(f).toLowerCase()));

    if (files.length === 0) {
      throw new Error('Please upload at least 3 photos of your child first.');
    }

    const cache = loadCache(this.config.trainCachePath);
    let cacheDirty = false;

    const descriptors = [];
    const results = [];

    for (let i = 0; i < files.length; i++) {
      const filename = files[i];
      const filePath = path.join(dir, filename);
      let detected = false;
      let cached = false;
      let error = null;

      try {
        const buffer = fs.readFileSync(filePath);
        const cacheEntry = getCachedEntry(cache, buffer);

        if (cacheEntry.hit) {
          cached = true;
          if (cacheEntry.detected && cacheEntry.descriptor) {
            descriptors.push(cacheEntry.descriptor);
            detected = true;
          } else {
            detected = false;
            error = cacheEntry.error || null;
          }
        } else {
          if (!this.modelsLoaded) {
            await loadModels(this.config.modelsPath);
            this.modelsLoaded = true;
          }

          const descriptor = await extractSingleDescriptor(buffer);
          if (descriptor) {
            descriptors.push(descriptor);
            detected = true;
          }

          setCachedEntry(cache, cacheEntry.hash, {
            filename,
            detected: Boolean(descriptor),
            descriptor,
            error: null
          });
          cacheDirty = true;
        }
      } catch (err) {
        error = err.message;
      }

      const itemResult = {
        filename,
        index: i + 1,
        total: files.length,
        detected,
        cached,
        error
      };
      results.push(itemResult);

      if (onProgress) {
        onProgress(itemResult);
      }
      this.emit('train_progress', itemResult);
    }

    if (cacheDirty) {
      saveCache(this.config.trainCachePath, cache);
    }

    if (descriptors.length < 3) {
      throw new Error(`Only ${descriptors.length} face(s) were clearly recognized out of ${files.length} photos. A minimum of 3 clear photos is required.`);
    }

    const averaged = averageDescriptors(descriptors);
    const outputPath = this.config.referencePath;
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    let referenceData = { children: [] };
    if (fs.existsSync(outputPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
        if (Array.isArray(existing.children)) {
          referenceData.children = existing.children;
        } else if (existing.descriptor) {
          referenceData.children = [{
            name: existing.childName || 'My Child',
            createdAt: existing.createdAt || new Date().toISOString(),
            photosUsed: existing.photosUsed || 0,
            descriptor: existing.descriptor
          }];
        }
      } catch {}
    }

    const cleanName = (childName || 'My Child').trim();
    const existingIndex = referenceData.children.findIndex(c => c.name.toLowerCase() === cleanName.toLowerCase());

    const newChildEntry = {
      name: cleanName,
      createdAt: new Date().toISOString(),
      photosUsed: descriptors.length,
      totalPhotos: files.length,
      descriptor: Array.from(averaged)
    };

    if (existingIndex >= 0) {
      referenceData.children[existingIndex] = newChildEntry;
    } else {
      referenceData.children.push(newChildEntry);
    }

    // Top-level backwards compatibility fields
    referenceData.descriptor = Array.from(averaged);
    referenceData.childName = cleanName;
    referenceData.photosUsed = descriptors.length;
    referenceData.totalPhotos = files.length;
    referenceData.createdAt = newChildEntry.createdAt;

    fs.writeFileSync(outputPath, JSON.stringify(referenceData, null, 2), 'utf-8');
    this.reloadReference();

    this.log('info', `Training complete! Face profile saved for "${cleanName}" based on ${descriptors.length} clear photos.`);
    this.emit('status', this.getStatus());

    return {
      success: true,
      childName: cleanName,
      photosUsed: descriptors.length,
      totalPhotos: files.length,
      results
    };
  }

  deleteProfile(childName) {
    const outputPath = this.config.referencePath;
    if (!fs.existsSync(outputPath)) return false;

    try {
      const data = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      if (Array.isArray(data.children)) {
        data.children = data.children.filter(c => c.name.toLowerCase() !== childName.toLowerCase().trim());
        if (data.children.length > 0) {
          data.descriptor = data.children[0].descriptor;
          data.childName = data.children[0].name;
          data.photosUsed = data.children[0].photosUsed;
        } else {
          delete data.descriptor;
          delete data.childName;
          delete data.photosUsed;
        }
        fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf-8');
        this.reloadReference();
        this.emit('status', this.getStatus());
        return true;
      }
    } catch {}
    return false;
  }

  async testPhoto(buffer) {
    if (!this.modelsLoaded) {
      await loadModels(this.config.modelsPath);
      this.modelsLoaded = true;
    }

    if (!this.referenceDescriptor && this.profiles.length === 0) {
      throw new Error('Please train face recognition with reference photos first.');
    }

    const descriptors = await extractAllDescriptors(buffer);
    if (descriptors.length === 0) {
      return {
        facesCount: 0,
        matched: false,
        confidence: 0,
        distance: null,
        bestDistance: null,
        childName: null,
        threshold: this.config.matchThreshold,
        verdict: 'No faces detected in this photo. Make sure the face is clear, well-lit, and not too far away.'
      };
    }

    const result = this.scoreWithFeedback(descriptors, this.config.matchThreshold);
    const childStr = result.childName ? ` (${result.childName})` : '';

    let verdict = '';
    if (result.matched) {
      verdict = `Match confirmed${childStr}! In Live mode, this photo WOULD be forwarded. (Evaluated via ${result.method})`;
    } else {
      verdict = `Child not recognized. In Live mode, this photo would NOT be forwarded. (Evaluated via ${result.method})`;
    }

    return {
      facesCount: descriptors.length,
      matched: result.matched,
      confidence: result.confidence || 0,
      score: result.score,
      method: result.method,
      classifierProbability: result.classifierProbability,
      distance: result.distance ? result.distance.toFixed(4) : null,
      bestDistance: result.bestDistance ? result.bestDistance.toFixed(4) : null,
      childName: result.childName,
      threshold: this.config.matchThreshold,
      verdict
    };
  }
}

module.exports = ForwarderEngine;
