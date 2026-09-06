/**
 * scripts/doctor.js
 *
 * Pre-flight diagnostic tool for WhatsApp Kid-Photo Auto-Forwarder.
 * Inspects Node version, configuration, model files, reference embedding,
 * media dependencies, and session state.
 *
 * Usage: npm run doctor
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load .env if present
const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const CHECK_OK = '  [✓]';
const CHECK_WARN = '  [!]';
const CHECK_FAIL = '  [✗]';

function runDoctor() {
  console.log('\n================================================================');
  console.log('  WhatsApp Kid-Photo Forwarder — System Doctor');
  console.log('================================================================\n');

  let issues = 0;
  let warnings = 0;

  // 1. Node.js Version
  const nodeVer = process.versions.node;
  const majorVer = parseInt(nodeVer.split('.')[0], 10);
  if (majorVer >= 18) {
    console.log(`${CHECK_OK} Node.js: v${nodeVer} (>= 18.0.0 required)`);
  } else {
    console.log(`${CHECK_FAIL} Node.js: v${nodeVer} is outdated! Node 18 or higher is required.`);
    issues++;
  }

  // 2. Models Check
  const modelsDir = path.resolve(process.env.MODELS_PATH || path.join(rootDir, 'models'));
  const modelFiles = [
    'ssd_mobilenetv1_model-weights_manifest.json',
    'ssd_mobilenetv1_model.bin',
    'face_landmark_68_model-weights_manifest.json',
    'face_landmark_68_model.bin',
    'face_recognition_model-weights_manifest.json',
    'face_recognition_model.bin'
  ];

  if (!fs.existsSync(modelsDir)) {
    console.log(`${CHECK_FAIL} Face-API models folder missing: ${modelsDir}`);
    console.log('      Run `npm run download-models` to copy weights.');
    issues++;
  } else {
    const missing = modelFiles.filter(f => !fs.existsSync(path.join(modelsDir, f)));
    if (missing.length === 0) {
      console.log(`${CHECK_OK} Face-API Models: All 6 weights verified in ${path.relative(rootDir, modelsDir)}/`);
    } else {
      console.log(`${CHECK_FAIL} Face-API Models: ${missing.length} weight file(s) missing.`);
      console.log('      Run `npm run download-models` to restore.');
      issues++;
    }
  }

  // 3. Child Reference Embedding
  const refPath = path.resolve(process.env.REFERENCE_EMBEDDING_PATH || path.join(rootDir, 'data', 'child-reference.json'));
  if (fs.existsSync(refPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(refPath, 'utf-8'));
      const count = data.photosUsed || data.totalPhotos || '?';
      const date = data.createdAt ? new Date(data.createdAt).toLocaleDateString() : 'unknown date';
      console.log(`${CHECK_OK} Child Reference Embedding: Found (${count} reference faces, created ${date})`);
    } catch {
      console.log(`${CHECK_FAIL} Child Reference Embedding: Corrupted JSON at ${refPath}`);
      console.log('      Re-run `npm run enroll` to generate a fresh embedding.');
      issues++;
    }
  } else {
    console.log(`${CHECK_FAIL} Child Reference Embedding: Not enrolled yet! (${refPath} not found)`);
    console.log('      Place 5–15 photos in train_photos/ and run `npm run enroll`.');
    issues++;
  }

  // 4. Photos in train_photos
  const trainDir = path.resolve(process.env.TRAIN_PHOTOS_PATH || path.join(rootDir, 'train_photos'));
  if (fs.existsSync(trainDir)) {
    const images = fs.readdirSync(trainDir).filter(f => /\.(jpg|jpeg|png|webp|bmp)$/i.test(f));
    if (images.length >= 3) {
      console.log(`${CHECK_OK} Reference Photos: ${images.length} photo(s) in ${path.relative(rootDir, trainDir)}/`);
    } else if (images.length > 0) {
      console.log(`${CHECK_WARN} Reference Photos: Only ${images.length} photo(s) in ${path.relative(rootDir, trainDir)}/ (5–15 recommended)`);
      warnings++;
    } else {
      console.log(`${CHECK_WARN} Reference Photos: Directory ${path.relative(rootDir, trainDir)}/ is empty`);
      warnings++;
    }
  } else {
    console.log(`${CHECK_WARN} Reference Photos: Directory ${path.relative(rootDir, trainDir)}/ not created yet`);
    warnings++;
  }

  // 5. Configuration (.env)
  if (!fs.existsSync(envPath)) {
    console.log(`${CHECK_FAIL} Configuration: .env file missing`);
    console.log('      Run `npm run setup` or `copy .env.example .env`');
    issues++;
  } else {
    const sourceId = process.env.SOURCE_CHAT_ID;
    const targetId = process.env.TARGET_CHAT_ID;
    const forwarding = process.env.ENABLE_FORWARDING === 'true';
    const groupForwarding = process.env.ALLOW_GROUP_FORWARDING === 'true';
    const threshold = parseFloat(process.env.MATCH_THRESHOLD || '0.5');

    const isPlaceholder = (v) => !v || v.includes('xxxx') || v.includes('yyyy');

    if (isPlaceholder(sourceId)) {
      console.log(`${CHECK_FAIL} SOURCE_CHAT_ID: Not configured in .env`);
      console.log('      Run `npm run search-chats` to select your kindergarten group.');
      issues++;
    } else if (!sourceId.endsWith('@g.us')) {
      console.log(`${CHECK_FAIL} SOURCE_CHAT_ID: "${sourceId}" must be a group ending in @g.us`);
      issues++;
    } else {
      console.log(`${CHECK_OK} SOURCE_CHAT_ID: ${sourceId}`);
    }

    if (isPlaceholder(targetId)) {
      console.log(`${CHECK_FAIL} TARGET_CHAT_ID: Not configured in .env`);
      console.log('      Run `npm run search-chats` to select your target chat.');
      issues++;
    } else if (sourceId && targetId === sourceId) {
      console.log(`${CHECK_FAIL} TARGET_CHAT_ID: Identical to SOURCE_CHAT_ID! Forwarding to source is blocked.`);
      issues++;
    } else {
      console.log(`${CHECK_OK} TARGET_CHAT_ID: ${targetId}`);
    }

    // Safety checks
    if (!forwarding) {
      console.log(`${CHECK_OK} Safety Mode: DRY-RUN (ENABLE_FORWARDING=false) — Zero messages will be sent to WhatsApp`);
    } else {
      console.log(`${CHECK_WARN} Safety Mode: LIVE ARMED (ENABLE_FORWARDING=true) — Matches WILL be forwarded`);
      if (targetId && targetId.endsWith('@g.us') && !groupForwarding) {
        console.log(`${CHECK_FAIL} Group Safety Lock: TARGET is a group, but ALLOW_GROUP_FORWARDING=false`);
        issues++;
      }
    }

    if (isNaN(threshold) || threshold <= 0 || threshold >= 2) {
      console.log(`${CHECK_FAIL} MATCH_THRESHOLD: Invalid value "${process.env.MATCH_THRESHOLD}" (recommended 0.45 - 0.6)`);
      issues++;
    } else {
      console.log(`${CHECK_OK} MATCH_THRESHOLD: ${threshold} (standard range: 0.45 - 0.6)`);
    }
  }

  // 6. FFmpeg / FFprobe
  try {
    const ffmpeg = require('@ffmpeg-installer/ffmpeg');
    const ffprobe = require('@ffprobe-installer/ffprobe');
    if (ffmpeg.path && fs.existsSync(ffmpeg.path) && ffprobe.path && fs.existsSync(ffprobe.path)) {
      console.log(`${CHECK_OK} Video Processing: FFmpeg and FFprobe binaries verified`);
    } else {
      console.log(`${CHECK_WARN} Video Processing: FFmpeg package found but binaries not found at expected path`);
      warnings++;
    }
  } catch {
    console.log(`${CHECK_WARN} Video Processing: FFmpeg packages not loaded (video frame checking may fail)`);
    warnings++;
  }

  // 7. WhatsApp Session
  const sessionDir = path.resolve(process.env.SESSION_DATA_PATH || path.join(rootDir, '.wwebjs_auth'));
  if (fs.existsSync(sessionDir)) {
    console.log(`${CHECK_OK} WhatsApp Session: Saved session found in ${path.relative(rootDir, sessionDir)}/`);
  } else {
    console.log(`${CHECK_WARN} WhatsApp Session: No session saved yet. QR code scan will be required on first start.`);
    warnings++;
  }

  // Summary
  console.log('\n----------------------------------------------------------------');
  if (issues === 0 && warnings === 0) {
    console.log('  ALL CHECKS PASSED! The auto-forwarder is ready to run.');
    console.log('  Start with: npm start  (or double-click start.bat)\n');
  } else if (issues === 0) {
    console.log(`  SYSTEM READY with ${warnings} non-critical warning(s).`);
    console.log('  Start with: npm start  (or double-click start.bat)\n');
  } else {
    console.log(`  ATTENTION: ${issues} issue(s) and ${warnings} warning(s) found.`);
    console.log('  Tip: Run `npm run setup` for an interactive guided setup!\n');
  }
}

runDoctor();
