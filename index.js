/**
 * index.js — WhatsApp Kid-Photo Auto-Forwarder
 *
 * Main entry point. Connects to WhatsApp Web, monitors a source group for
 * incoming photos/videos, runs local face recognition against an enrolled
 * reference embedding, and forwards matching media to a target chat.
 *
 * All processing is local — no cloud services, no external API calls.
 *
 * Usage: npm start
 *
 * Prerequisites:
 *   1. npm install
 *   2. npm run download-models
 *   3. npm run enroll -- <photos-folder>
 *   4. npm run list-chats  (to get chat IDs)
 *   5. Configure .env with SOURCE_CHAT_ID and TARGET_CHAT_ID
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createClient, createSafeSender, destroyClient } = require('./lib/whatsapp');
const { loadModels, extractAllDescriptors, anyFaceMatches, loadReference } = require('./lib/faceMatch');
const { withExtractedFrames } = require('./lib/videoFrames');
const DedupeTracker = require('./lib/dedupe');
const Logger = require('./lib/logger');
const NightlyScheduler = require('./lib/scheduler');
const { interactiveSelectChats } = require('./lib/chatSelector');
const sharp = require('sharp');

// =============================================================================
// Configuration
// =============================================================================

const config = {
  sourceChatId:          process.env.SOURCE_CHAT_ID,
  targetChatId:          process.env.TARGET_CHAT_ID,
  matchThreshold:        parseFloat(process.env.MATCH_THRESHOLD || '0.5'),
  videoFrames:           parseInt(process.env.VIDEO_FRAMES_TO_CHECK || '5', 10),
  referencePath:         path.resolve(process.env.REFERENCE_EMBEDDING_PATH || './data/child-reference.json'),
  sessionPath:           path.resolve(process.env.SESSION_DATA_PATH || './.wwebjs_auth'),
  logPath:               process.env.LOG_PATH || './logs/activity.log',
  modelsPath:            path.resolve(process.env.MODELS_PATH || './models'),
  previewDir:            path.resolve(process.env.MATCH_PREVIEW_PATH || './matches_preview'),
  // 100% Safety Controls:
  enableForwarding:      process.env.ENABLE_FORWARDING === 'true',
  allowGroupForwarding:  process.env.ALLOW_GROUP_FORWARDING === 'true',
  // Nightly Auto-Restart (cleans Chromium RAM and refreshes session)
  autoRestartEnabled:    process.env.AUTO_RESTART_ENABLED === 'true',
  autoRestartTimeUtc:    process.env.AUTO_RESTART_TIME_UTC || '00:00',
  autoRestartMode:       (process.env.AUTO_RESTART_MODE || 'in-process').toLowerCase()
};

// =============================================================================
// Startup Validation & Safety Guardrails
// =============================================================================

function validateBaseConfig() {
  const errors = [];

  if (!fs.existsSync(config.referencePath)) {
    errors.push(`Reference embedding not found: ${config.referencePath}\n  → Run \`npm run enroll -- <photos-folder>\` first.`);
  }
  if (!fs.existsSync(config.modelsPath)) {
    errors.push(`Models directory not found: ${config.modelsPath}\n  → Run \`npm run download-models\` first.`);
  }
  if (isNaN(config.matchThreshold) || config.matchThreshold <= 0 || config.matchThreshold >= 2) {
    errors.push(`Invalid MATCH_THRESHOLD: ${process.env.MATCH_THRESHOLD}. Must be between 0 and 2.`);
  }

  if (errors.length > 0) {
    console.error('\n⚠  Configuration errors:\n');
    for (const err of errors) {
      console.error(`  • ${err}`);
    }
    process.exit(1);
  }
}

function validateChatConfig() {
  const errors = [];
  const isMissing = (id) => !id || id.includes('xxxx') || id.includes('yyyy');

  if (isMissing(config.sourceChatId)) {
    errors.push('SOURCE_CHAT_ID is not set in .env');
  }
  if (isMissing(config.targetChatId)) {
    errors.push('TARGET_CHAT_ID is not set in .env');
  }

  // CRITICAL ANTI-ECHO CHECK: Never forward to the source group!
  if (config.sourceChatId && config.targetChatId && config.sourceChatId === config.targetChatId) {
    errors.push(
      'CRITICAL SAFETY ERROR: SOURCE_CHAT_ID and TARGET_CHAT_ID are identical!\n' +
      '  The bot must NEVER send media back to the source group. Please fix TARGET_CHAT_ID in .env.'
    );
  }

  // GROUP TARGET PROTECTION: Require explicit flag if targeting a group
  if (
    config.targetChatId &&
    config.targetChatId.endsWith('@g.us') &&
    config.enableForwarding &&
    !config.allowGroupForwarding
  ) {
    errors.push(
      'SAFETY LOCK: TARGET_CHAT_ID is a group (@g.us) and ENABLE_FORWARDING=true,\n' +
      '  but ALLOW_GROUP_FORWARDING is not set to "true" in .env.\n' +
      '  To prevent accidental group blasts, set ALLOW_GROUP_FORWARDING=true only if this group is intentional.'
    );
  }

  return errors;
}

// =============================================================================
// =============================================================================
// Message Handlers & Safety Wrapper
// =============================================================================

const logger = new Logger(config.logPath);
const dedupe = new DedupeTracker();
let referenceDescriptor;
let whatsappClient;
let safeSendMessage;
let nightlyScheduler;

/**
 * Sequential processing queue to prevent CPU starvation and ensure
 * Node's event loop stays responsive for WhatsApp Web & network events.
 */
class MediaQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  push(task) {
    this.queue.push(task);
    this._next();
  }

  async _next() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const task = this.queue.shift();
    try {
      await task();
    } catch (err) {
      logger.error('MediaQueue task error.', { error: err?.message || String(err) });
    } finally {
      this.processing = false;
      // Yield to the event loop so network/CDP can process
      setImmediate(() => this._next());
    }
  }
}

const mediaQueue = new MediaQueue();

/**
 * Saves a local copy of matching media and metadata to ./matches_preview/
 * so the user can review exactly what was matched without needing live forwarding.
 */
function saveMatchPreview(media, msgId, meta = {}) {
  try {
    if (!fs.existsSync(config.previewDir)) {
      fs.mkdirSync(config.previewDir, { recursive: true });
    }
    const safeId = msgId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    const ext = media.mimetype?.split('/')[1]?.split(';')[0] || (meta.mediaType === 'video' ? 'mp4' : 'jpg');
    const mediaFilename = `match_${timestamp}_${safeId}.${ext}`;
    const metaFilename = `match_${timestamp}_${safeId}.json`;

    const mediaPath = path.join(config.previewDir, mediaFilename);
    const metaPath = path.join(config.previewDir, metaFilename);

    fs.writeFileSync(mediaPath, Buffer.from(media.data, 'base64'));
    fs.writeFileSync(metaPath, JSON.stringify({
      savedAt: new Date().toISOString(),
      msgId,
      mediaFile: mediaFilename,
      forwardingEnabled: config.enableForwarding,
      ...meta
    }, null, 2));

    logger.info(`Match preview saved locally: ${mediaFilename}`, {
      previewPath: mediaPath,
      metaPath
    });

    return mediaPath;
  } catch (err) {
    logger.error('Failed to save match preview.', { error: err.message });
    return null;
  }
}

/**
 * Resolves the unique serialized message identifier across all WhatsApp Web versions.
 * In 2026 builds, WhatsApp Web renamed `_serialized` to `$1` or minified the Key model.
 * This helper guarantees a valid serialized string format `${fromMe}_${remote}_${id}`.
 */
function getMessageId(msg) {
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

/**
 * Process an incoming image message:
 *   1. Download media
 *   2. Run face detection on all faces
 *   3. Compare each face against the reference embedding
 *   4. Save preview locally
 *   5. Forward through safety interceptor if any face matches
 */
async function handleImageMessage(msg, forcedMsgId) {
  const msgId = forcedMsgId || getMessageId(msg);
  if (msg.id && typeof msg.id === 'object' && !msg.id._serialized) {
    msg.id._serialized = msgId;
  }

  try {
    let media = await msg.downloadMedia();
    if (!media) {
      // Short retry to account for media decryption latency
      await new Promise(resolve => setTimeout(resolve, 1000));
      media = await msg.downloadMedia();
    }
    if (!media) {
      logger.warn('Could not download image media (may have expired or still syncing).', { msgId });
      return;
    }

    const buffer = Buffer.from(media.data, 'base64');
    const descriptors = await extractAllDescriptors(buffer);

    if (descriptors.length === 0) {
      logger.info('No faces detected in image.', { msgId, mediaType: 'image' });
      return;
    }

    const result = anyFaceMatches(descriptors, referenceDescriptor, config.matchThreshold);

    if (result.matched) {
      const caption = msg.body || '';

      // Save local match preview regardless of dry-run vs live
      saveMatchPreview(media, msgId, {
        mediaType: 'image',
        distance: result.distance.toFixed(4),
        caption,
        facesChecked: descriptors.length
      });

      // Forward through the safe sender (guarantees dry-run / anti-echo / group locks)
      const sendResult = await safeSendMessage(config.targetChatId, media, { caption });

      if (sendResult && sendResult.sent === false) {
        if (sendResult.reason === 'DRY_RUN') {
          logger.info('MATCH (DRY RUN) — Saved to ./matches_preview/. ZERO messages sent to WhatsApp.', {
            msgId,
            mediaType: 'image',
            distance: result.distance.toFixed(4)
          });
        } else {
          logger.warn(`MATCH (BLOCKED) — Message was not forwarded: ${sendResult.reason}`, {
            msgId,
            reason: sendResult.reason
          });
        }
      } else {
        logger.info('MATCH — Image successfully forwarded to WhatsApp target.', {
          msgId,
          mediaType: 'image',
          distance: result.distance.toFixed(4),
          target: config.targetChatId
        });
      }
    } else {
      logger.info('No match in image.', {
        msgId,
        mediaType: 'image',
        facesChecked: descriptors.length,
        bestDistance: result.bestDistance !== null ? result.bestDistance.toFixed(4) : 'none',
        threshold: config.matchThreshold
      });
    }
  } catch (err) {
    logger.error('Error processing image.', {
      msgId,
      error: err?.message || String(err)
    });
  }
}

/**
 * Process an incoming video message:
 *   1. Download media and save to temp file (ffmpeg needs a file path)
 *   2. Extract N evenly-spaced frames
 *   3. Run face detection on each frame — short-circuit on first match
 *   4. Save preview locally
 *   5. Forward original video through safety interceptor if any frame matches
 *   6. Clean up all temp files
 */
async function handleVideoMessage(msg, forcedMsgId) {
  const msgId = forcedMsgId || getMessageId(msg);
  if (msg.id && typeof msg.id === 'object' && !msg.id._serialized) {
    msg.id._serialized = msgId;
  }
  let tempVideoPath = null;

  try {
    let media = await msg.downloadMedia();
    if (!media) {
      // Short retry to account for media decryption latency
      await new Promise(resolve => setTimeout(resolve, 1000));
      media = await msg.downloadMedia();
    }
    if (!media) {
      logger.warn('Could not download video media (may have expired or still syncing).', { msgId });
      return;
    }

    // Save video to a temp file — ffmpeg requires a file path, not a buffer
    const ext = media.mimetype?.split('/')[1]?.split(';')[0] || 'mp4';
    tempVideoPath = path.join(os.tmpdir(), `kid-fwd-${Date.now()}.${ext}`);
    fs.writeFileSync(tempVideoPath, Buffer.from(media.data, 'base64'));

    const matched = await withExtractedFrames(
      tempVideoPath,
      config.videoFrames,
      async (framePaths) => {
        let globalMinDistance = Infinity;
        // Check each frame for a face match — stop on first hit
        for (let i = 0; i < framePaths.length; i++) {
          // Yield to Node event loop between frames to keep WhatsApp Web connection responsive
          await new Promise(resolve => setImmediate(resolve));

          const frameBuffer = fs.readFileSync(framePaths[i]);
          const descriptors = await extractAllDescriptors(frameBuffer);
          if (descriptors.length > 0) {
            const result = anyFaceMatches(descriptors, referenceDescriptor, config.matchThreshold);
            if (result.bestDistance !== null && result.bestDistance < globalMinDistance) {
              globalMinDistance = result.bestDistance;
            }
            if (result.matched) {
              return { matched: true, distance: result.distance, frame: i + 1, bestDistance: globalMinDistance };
            }
          }
        }
        return { matched: false, bestDistance: globalMinDistance === Infinity ? null : globalMinDistance };
      }
    );

    if (matched.matched) {
      const caption = msg.body || '';

      // Save local match preview
      saveMatchPreview(media, msgId, {
        mediaType: 'video',
        distance: matched.distance.toFixed(4),
        caption,
        matchedFrame: matched.frame,
        framesChecked: config.videoFrames
      });

      // Forward through the safe sender
      const sendResult = await safeSendMessage(config.targetChatId, media, { caption });

      if (sendResult && sendResult.sent === false) {
        if (sendResult.reason === 'DRY_RUN') {
          logger.info('MATCH (DRY RUN) — Video saved to ./matches_preview/. ZERO messages sent to WhatsApp.', {
            msgId,
            mediaType: 'video',
            distance: matched.distance.toFixed(4),
            matchedFrame: matched.frame
          });
        } else {
          logger.warn(`MATCH (BLOCKED) — Video was not forwarded: ${sendResult.reason}`, {
            msgId,
            reason: sendResult.reason
          });
        }
      } else {
        logger.info('MATCH — Video successfully forwarded to WhatsApp target.', {
          msgId,
          mediaType: 'video',
          distance: matched.distance.toFixed(4),
          matchedFrame: matched.frame,
          target: config.targetChatId
        });
      }
    } else {
      logger.info('No match in video.', {
        msgId,
        mediaType: 'video',
        framesChecked: config.videoFrames,
        bestDistance: matched.bestDistance !== null ? matched.bestDistance.toFixed(4) : 'none',
        threshold: config.matchThreshold
      });
    }
  } catch (err) {
    logger.error('Error processing video.', {
      msgId,
      error: err?.message || String(err)
    });
  } finally {
    // Clean up the temp video file
    if (tempVideoPath) {
      try { fs.unlinkSync(tempVideoPath); } catch {}
    }
  }
}

/**
 * Main message handler — filters for source chat, media type, and deduplication
 * before dispatching to the sequential media queue.
 */
async function onMessage(msg) {
  // Check if message belongs to the watched source chat across all possible identifiers:
  const remoteChatId = typeof msg.id?.remote === 'object'
    ? (msg.id.remote?._serialized || msg.id.remote?.$1 || msg.id.remote?.user)
    : msg.id?.remote;
  const isFromSource = (
    remoteChatId === config.sourceChatId ||
    msg.from === config.sourceChatId ||
    msg.to === config.sourceChatId
  );

  // If not from the watched group, silently ignore
  if (!isFromSource) return;

  // Log all activity occurring in the watched group so you have full visibility
  logger.info(`Activity in watched group: [${msg.type}] fromMe=${msg.fromMe}, hasMedia=${msg.hasMedia}`);

  // Only handle image and video media messages
  const isImage = msg.type === 'image' || (msg.hasMedia && msg.mimetype?.startsWith('image/'));
  const isVideo = msg.type === 'video' || (msg.hasMedia && msg.mimetype?.startsWith('video/'));

  if (!isImage && !isVideo) {
    logger.info(`Ignored non-image/video message in watched chat (type: ${msg.type}).`);
    return;
  }

  const msgId = getMessageId(msg);
  if (msg.id && typeof msg.id === 'object' && !msg.id._serialized) {
    msg.id._serialized = msgId;
  }

  // Deduplication: skip if we already processed this message in a previous run
  if (dedupe.isProcessed(msgId)) {
    logger.info('Skipping already-processed message.', { msgId });
    return;
  }

  // Mark as processed BEFORE starting work — prevents double-processing if
  // the process crashes during a long video analysis and restarts
  dedupe.markProcessed(msgId);

  // Queue media tasks sequentially to prevent CPU starvation and keep event loop alive
  mediaQueue.push(async () => {
    logger.info(`Starting face detection on ${isImage ? 'image' : 'video'}...`, {
      msgId,
      mediaType: isImage ? 'image' : 'video'
    });

    if (isImage) {
      await handleImageMessage(msg, msgId);
    } else if (isVideo) {
      await handleVideoMessage(msg, msgId);
    }
  });
}

/**
 * Executes the scheduled nightly self-restart at 00:00 UTC.
 * Drains any in-flight media queue work, cleanly shuts down Chromium/Puppeteer,
 * and either restarts in-process (default) or exits with code 42 for a runner/supervisor.
 */
async function performNightlyRestart() {
  logger.info(`[Nightly Restart] Scheduled self-restart triggered for ${config.autoRestartTimeUtc} UTC.`);

  // 1. Wait for active media processing to finish
  if (mediaQueue.processing || mediaQueue.queue.length > 0) {
    logger.info('[Nightly Restart] Waiting for active media queue to drain before restarting...');
    while (mediaQueue.processing || mediaQueue.queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    logger.info('[Nightly Restart] Media queue is idle.');
  }

  // 2. Mode 'exit': Exit with code 42 so start.bat, PM2, or Docker can relaunch fresh process
  if (config.autoRestartMode === 'exit') {
    logger.info('[Nightly Restart] Mode: exit. Shutting down WhatsApp client and Chromium before exit...');
    try {
      await destroyClient(whatsappClient);
      whatsappClient = null;
    } catch (err) {
      logger.warn('[Nightly Restart] Warning during client destroy:', { error: err?.message || String(err) });
    }
    logger.info('[Nightly Restart] Exiting process with code 42 for supervisor relaunch.');
    process.exit(42);
    return;
  }

  // 3. Mode 'in-process': Destroy old client, clear memory caches, and reinitialize fresh client
  logger.info('[Nightly Restart] Mode: in-process. Terminating Chromium & releasing memory...');
  try {
    await destroyClient(whatsappClient);
    whatsappClient = null;
  } catch (err) {
    logger.warn('[Nightly Restart] Warning during client destroy:', { error: err?.message || String(err) });
  }

  // Allow OS & Chromium a moment to release file handles on the session folder
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Flush sharp image processing cache to release uncompressed buffers
  try {
    sharp.cache(false);
    sharp.cache(true);
  } catch {}

  // Reload child reference embedding from disk in case reference photos were updated
  try {
    referenceDescriptor = loadReference(config.referencePath);
    logger.info('[Nightly Restart] Child reference embedding reloaded.');
  } catch (err) {
    logger.warn('[Nightly Restart] Could not reload reference embedding:', { error: err?.message || String(err) });
  }

  // Run V8 garbage collection if Node was started with --expose-gc
  if (global.gc) {
    try { global.gc(); } catch {}
  }

  logger.info('[Nightly Restart] Launching fresh WhatsApp Web client...');

  const newClient = createClient({
    sessionPath: config.sessionPath,
    logger,
    onMessage,
    onReady: () => {
      logger.info('[Nightly Restart] WhatsApp client reconnected. Monitoring active.');
      console.log('');
      console.log('  ┌────────────────────────────────────────────────────────────┐');
      console.log('  │  [00:00 UTC] Nightly self-restart completed successfully!  │');
      console.log('  │  WhatsApp Web reconnected. Monitoring resumed.             │');
      console.log('  └────────────────────────────────────────────────────────────┘');
      console.log('');
    }
  });

  whatsappClient = newClient;

  safeSendMessage = createSafeSender(newClient, {
    sourceChatId: config.sourceChatId,
    enableForwarding: config.enableForwarding,
    allowGroupForwarding: config.allowGroupForwarding,
    logger
  });

  newClient.initialize();
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║  WhatsApp Kid-Photo Auto-Forwarder                       ║');
  console.log('  ║  Local face recognition • Zero cloud • 100% On-Device    ║');
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Validate base configuration before heavy initialization
  validateBaseConfig();

  const isMissing = (id) => !id || id.includes('xxxx') || id.includes('yyyy');
  const needSource = isMissing(config.sourceChatId);
  const needTarget = isMissing(config.targetChatId);

  if (needSource || needTarget) {
    if (!process.stdin.isTTY) {
      console.error('\n⚠  SOURCE_CHAT_ID or TARGET_CHAT_ID is not configured in .env.');
      console.error('Run `npm run search-chats` to find and configure your chat IDs interactively.\n');
      process.exit(1);
    }
    console.log('► SOURCE_CHAT_ID or TARGET_CHAT_ID is not configured in .env.');
    console.log('► Initializing WhatsApp Web session to search and configure chat IDs interactively...\n');
  }

  // Load face recognition models (~12 MB, takes a few seconds)
  await loadModels(config.modelsPath);

  // Load the enrolled child's reference embedding
  referenceDescriptor = loadReference(config.referencePath);
  logger.info('Reference embedding loaded.', { path: config.referencePath });

  let isMonitoringActive = false;

  // Create WhatsApp client
  const client = createClient({
    sessionPath: config.sessionPath,
    logger,
    onMessage: (msg) => {
      if (!isMonitoringActive) return;
      return onMessage(msg);
    },
    onReady: async (readyClient) => {
      if (needSource || needTarget) {
        try {
          const selected = await interactiveSelectChats(readyClient, {
            needSource,
            needTarget
          });
          if (selected.sourceChatId) config.sourceChatId = selected.sourceChatId;
          if (selected.targetChatId) config.targetChatId = selected.targetChatId;
          config.allowGroupForwarding = process.env.ALLOW_GROUP_FORWARDING === 'true';
        } catch (err) {
          console.error('\nError selecting chats interactively:', err.message);
          process.exit(1);
        }
      }

      const chatErrors = validateChatConfig();
      if (chatErrors.length > 0) {
        console.error('\n⚠  Configuration / Safety errors:\n');
        for (const err of chatErrors) {
          console.error(`  • ${err}`);
        }
        console.error('\nRun `npm run search-chats` to configure valid chat IDs.');
        process.exit(1);
      }

      // Initialize the safety interceptor wrapping WhatsApp sends
      safeSendMessage = createSafeSender(readyClient, {
        sourceChatId: config.sourceChatId,
        enableForwarding: config.enableForwarding,
        allowGroupForwarding: config.allowGroupForwarding,
        logger
      });

      isMonitoringActive = true;

      // Print prominent safety status banner
      if (!config.enableForwarding) {
        console.log('  ┌────────────────────────────────────────────────────────────┐');
        console.log('  │  STATUS: SAFE / DRY-RUN MODE (ACTIVE)                      │');
        console.log('  │  Zero messages will be sent to ANY WhatsApp chat!          │');
        console.log('  │  Matched media will be saved locally to:                   │');
        console.log(`  │    ${config.previewDir.padEnd(52)}│`);
        console.log('  │  To enable real forwarding, set in .env:                   │');
        console.log('  │    ENABLE_FORWARDING=true                                  │');
        console.log('  └────────────────────────────────────────────────────────────┘');
      } else {
        console.log('  ┌────────────────────────────────────────────────────────────┐');
        console.log('  │  STATUS: LIVE FORWARDING ARMED!                            │');
        console.log('  │  Matched media WILL be forwarded to WhatsApp target!       │');
        console.log(`  │  Target: ${config.targetChatId.padEnd(50)}│`);
        console.log('  └────────────────────────────────────────────────────────────┘');
      }
      console.log('');

      // Log active configuration (no sensitive data)
      logger.info('Configuration:', {
        sourceChatId: config.sourceChatId,
        targetChatId: config.targetChatId,
        enableForwarding: config.enableForwarding,
        allowGroupForwarding: config.allowGroupForwarding,
        matchThreshold: config.matchThreshold,
        videoFrames: config.videoFrames,
        previewDir: config.previewDir
      });

      logger.info('Monitoring started. Waiting for media messages...');
      console.log('');
      console.log(`  Watching:     ${config.sourceChatId}`);
      console.log(`  Target:       ${config.targetChatId}`);
      console.log(`  Forwarding:   ${config.enableForwarding ? 'LIVE (Armed)' : 'DISABLED (Safe Dry-Run)'}`);
      console.log(`  Threshold:    ${config.matchThreshold}`);
      console.log(`  Video frames: ${config.videoFrames}`);
      console.log(`  Previews at:  ${config.previewDir}`);
      if (config.autoRestartEnabled) {
        const { delayMs } = nightlyScheduler.getNextOccurrence();
        console.log(`  Auto-restart: Every night at ${config.autoRestartTimeUtc} UTC [mode: ${config.autoRestartMode}] (next in ${NightlyScheduler.formatDuration(delayMs)})`);
      } else {
        console.log('  Auto-restart: DISABLED');
      }
      console.log('');
      console.log('  Press Ctrl+C to stop.');
      console.log('');
    }
  });

  whatsappClient = client;
  client.initialize();

  // Initialize scheduled nightly self-restart
  if (config.autoRestartEnabled) {
    nightlyScheduler = new NightlyScheduler({
      targetTimeUtc: config.autoRestartTimeUtc,
      onTrigger: performNightlyRestart,
      logger
    });
    nightlyScheduler.start();
  }

  // Graceful shutdown on Ctrl+C
  process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    if (nightlyScheduler) {
      nightlyScheduler.stop();
    }
    try {
      await destroyClient(whatsappClient);
    } catch {}
    console.log('Goodbye!');
    process.exit(0);
  });

  // Handle uncaught errors to prevent silent crashes
  process.on('unhandledRejection', (err) => {
    const msg = err?.message || String(err);
    if (msg.includes('Target closed') || msg.includes('Session closed')) {
      logger.warn('Browser navigation sync event (retrying connection)...');
      return;
    }
    logger.error('Unhandled promise rejection.', { error: msg });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception.', { error: err?.message || String(err) });
    // Don't exit — try to keep monitoring
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
