/**
 * scripts/test-match.js
 *
 * Offline Face Matching Verifier.
 * Tests photos against the enrolled child reference embedding to evaluate
 * recognition accuracy and calibrate MATCH_THRESHOLD without sending any messages.
 *
 * Usage:
 *   npm run test-match -- <path-to-photo-or-folder>
 *   node scripts/test-match.js ./train_photos
 *   node scripts/test-match.js ./my-test-photo.jpg
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadModels, extractAllDescriptors, anyFaceMatches, loadReference } = require('../lib/faceMatch');

const rootDir = path.resolve(__dirname, '..');
const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.webp'];

async function main() {
  console.log('\n================================================================');
  console.log('  WhatsApp Kid-Photo Forwarder — Offline Match Verifier');
  console.log('================================================================\n');

  const refPath = path.resolve(process.env.REFERENCE_EMBEDDING_PATH || path.join(rootDir, 'data', 'child-reference.json'));
  if (!fs.existsSync(refPath)) {
    console.error(`[✗] Reference embedding not found at: ${refPath}`);
    console.error('    Please enroll your child first: npm run enroll\n');
    process.exit(1);
  }

  const modelsDir = path.resolve(process.env.MODELS_PATH || path.join(rootDir, 'models'));
  const threshold = parseFloat(process.env.MATCH_THRESHOLD || '0.5');

  // Load models & reference
  await loadModels(modelsDir);
  const reference = loadReference(refPath);
  console.log(`[✓] Loaded reference embedding from: ${path.relative(rootDir, refPath)}`);
  console.log(`[✓] Active MATCH_THRESHOLD: ${threshold}\n`);

  // Determine target input (file or directory)
  const inputArg = process.argv[2] || path.join(rootDir, 'train_photos');
  const resolvedTarget = path.resolve(inputArg);

  if (!fs.existsSync(resolvedTarget)) {
    console.error(`[✗] File or folder not found: ${resolvedTarget}`);
    console.error('    Usage: npm run test-match -- <path-to-photo-or-folder>\n');
    process.exit(1);
  }

  const stat = fs.statSync(resolvedTarget);
  let filesToTest = [];

  if (stat.isDirectory()) {
    filesToTest = fs.readdirSync(resolvedTarget)
      .filter(f => SUPPORTED_EXTENSIONS.includes(path.extname(f).toLowerCase()))
      .sort()
      .map(f => path.join(resolvedTarget, f));
    console.log(`Testing ${filesToTest.length} image(s) from folder: ${path.relative(rootDir, resolvedTarget)}/\n`);
  } else {
    if (!SUPPORTED_EXTENSIONS.includes(path.extname(resolvedTarget).toLowerCase())) {
      console.error(`[✗] Unsupported image extension. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
      process.exit(1);
    }
    filesToTest = [resolvedTarget];
    console.log(`Testing single image: ${path.basename(resolvedTarget)}\n`);
  }

  if (filesToTest.length === 0) {
    console.log('No supported images found to test.\n');
    process.exit(0);
  }

  let matchCount = 0;
  let noMatchCount = 0;
  let noFaceCount = 0;

  for (const file of filesToTest) {
    const filename = path.basename(file);
    try {
      const buffer = fs.readFileSync(file);
      const descriptors = await extractAllDescriptors(buffer);

      if (descriptors.length === 0) {
        console.log(`  [NO FACE]   ${filename.padEnd(35)} (0 faces detected)`);
        noFaceCount++;
        continue;
      }

      const match = anyFaceMatches(descriptors, reference, threshold);
      const facesDesc = `${descriptors.length} face${descriptors.length === 1 ? '' : 's'}`;

      if (match.matched) {
        const distStr = match.distance.toFixed(4);
        console.log(`  [MATCH ✓]   ${filename.padEnd(35)} dist: ${distStr} (threshold: ${threshold}, ${facesDesc})`);
        matchCount++;
      } else {
        const bestDistStr = match.bestDistance !== null ? match.bestDistance.toFixed(4) : 'none';
        console.log(`  [NO MATCH ✗] ${filename.padEnd(35)} best dist: ${bestDistStr} (threshold: ${threshold}, ${facesDesc})`);
        noMatchCount++;
      }
    } catch (err) {
      console.log(`  [ERROR]     ${filename.padEnd(35)} ${err.message}`);
    }
  }

  // Summary and recommendations
  console.log('\n----------------------------------------------------------------');
  console.log(`  Results: ${matchCount} matched, ${noMatchCount} not matched, ${noFaceCount} without faces.`);
  console.log(`  Total images tested: ${filesToTest.length}`);
  console.log('----------------------------------------------------------------');

  if (matchCount > 0 && noMatchCount === 0) {
    console.log('  Evaluation: High confidence! All evaluated images matched.');
  } else if (noMatchCount > 0) {
    console.log('  Tip: If your child is in the unmatched photos, check their "best dist" score:');
    console.log('       - If scores are 0.50–0.58, consider raising MATCH_THRESHOLD to 0.55 in .env.');
    console.log('       - If scores are > 0.60, try enrolling clearer photos with npm run enroll.');
  }
  console.log('');
}

main().catch(err => {
  console.error('Fatal error during test-match:', err);
  process.exit(1);
});
