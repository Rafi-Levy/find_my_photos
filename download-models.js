/**
 * download-models.js
 *
 * Copies the required face-api.js model weight files from the installed
 * @vladmandic/face-api npm package into the local ./models directory.
 *
 * Required models (3 neural networks, ~12 MB total):
 *   - SSD MobileNet v1:    Face detection
 *   - FaceLandmark68Net:   68-point facial landmark extraction
 *   - FaceRecognitionNet:  128-d face embedding extraction
 *
 * Usage: npm run download-models
 */
const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, 'models');

// Locate the model files shipped inside the npm package
const PKG_MODEL_DIR = path.join(
  path.dirname(require.resolve('@vladmandic/face-api/package.json')),
  'model'
);

// The 6 files needed for the detection + landmarks + recognition pipeline
const FILES = [
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model.bin',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin'
];

function main() {
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }

  console.log('Face-API Model Setup');
  console.log('====================\n');
  console.log(`Source:  ${PKG_MODEL_DIR}`);
  console.log(`Target:  ${MODELS_DIR}\n`);

  let copied = 0;
  let skipped = 0;

  for (const file of FILES) {
    const src = path.join(PKG_MODEL_DIR, file);
    const dest = path.join(MODELS_DIR, file);

    if (fs.existsSync(dest)) {
      console.log(`  ✓ ${file} (already exists, skipping)`);
      skipped++;
      continue;
    }

    if (!fs.existsSync(src)) {
      console.error(`  ✗ ${file} — NOT FOUND in npm package!`);
      console.error(`    Expected at: ${src}`);
      process.exit(1);
    }

    fs.copyFileSync(src, dest);
    console.log(`  ✓ ${file} (copied)`);
    copied++;
  }

  console.log(`\nDone! Copied: ${copied}, Skipped: ${skipped}`);
  console.log('Models are ready for use.');
}

main();
