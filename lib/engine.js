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

    // 3. Initialize WhatsApp Client
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

    const result = this.matchAgainstProfiles(descriptors, this.config.matchThreshold);

    if (result.matched) {
      const filename = this.savePreview(media, msgId, {
        mediaType: 'image',
        childName: result.childName,
        distance: result.distance.toFixed(4),
        caption: msg.body || ''
      });

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
        distance: result.distance.toFixed(4),
        filename,
        caption: msg.body || '',
        forwarded,
        reason
      });

      const childTag = result.childName ? ` (${result.childName})` : '';
      this.log('info', `Child face matched in photo!${childTag} (${((1 - result.distance) * 100).toFixed(0)}% match) — ${forwarded ? 'Forwarded' : 'Saved to Review'}.`);
      this.emit('stats', this.statsTracker.getStats());
      this.emit('match', matchEntry);
    } else {
      this.log('info', `Checked photo: faces found, but no child match (best distance: ${result.bestDistance !== null ? result.bestDistance.toFixed(3) : 'none'}, threshold: ${this.config.matchThreshold}).`);
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
          for (let i = 0; i < framePaths.length; i++) {
            await new Promise(resolve => setImmediate(resolve));
            const frameBuffer = fs.readFileSync(framePaths[i]);
            const descriptors = await extractAllDescriptors(frameBuffer);
            if (descriptors.length > 0) {
              const res = this.matchAgainstProfiles(descriptors, this.config.matchThreshold);
              if (res.bestDistance !== null && res.bestDistance < globalMinDistance) {
                globalMinDistance = res.bestDistance;
              }
              if (res.matched) {
                return { matched: true, childName: res.childName, distance: res.distance, frame: i + 1 };
              }
            }
          }
          return { matched: false, bestDistance: globalMinDistance === Infinity ? null : globalMinDistance };
        }
      );

      if (matched.matched) {
        const filename = this.savePreview(media, msgId, {
          mediaType: 'video',
          childName: matched.childName,
          distance: matched.distance.toFixed(4),
          caption: msg.body || ''
        });

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
          distance: matched.distance.toFixed(4),
          filename,
          caption: msg.body || '',
          forwarded,
          reason
        });

        const childTag = matched.childName ? ` (${matched.childName})` : '';
        this.log('info', `Child face matched in video!${childTag} (${((1 - matched.distance) * 100).toFixed(0)}% match) — ${forwarded ? 'Forwarded' : 'Saved to Review'}.`);
        this.emit('stats', this.statsTracker.getStats());
        this.emit('match', matchEntry);
      } else {
        this.log('info', `Checked video: no child match across ${this.config.videoFrames} frames.`);
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

    const result = this.matchAgainstProfiles(descriptors, this.config.matchThreshold);
    const childStr = result.childName ? ` (${result.childName})` : '';

    let verdict = '';
    if (result.matched) {
      verdict = `Match confirmed${childStr}! In Live mode, this photo WOULD be forwarded.`;
    } else {
      verdict = `Child not recognized. In Live mode, this photo would NOT be forwarded.`;
    }

    return {
      facesCount: descriptors.length,
      matched: result.matched,
      confidence: result.confidence || 0,
      distance: result.distance ? result.distance.toFixed(4) : null,
      bestDistance: result.bestDistance ? result.bestDistance.toFixed(4) : null,
      childName: result.childName,
      threshold: this.config.matchThreshold,
      verdict
    };
  }
}

module.exports = ForwarderEngine;
