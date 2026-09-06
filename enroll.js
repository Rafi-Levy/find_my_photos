/**
 * enroll.js
 *
 * CLI enrollment script: processes a folder of reference photos of your child,
 * extracts face descriptors, averages them into a single reference embedding,
 * and saves it to data/child-reference.json.
 *
 * Only the numeric 128-dimensional embedding is stored — NOT the source photos.
 *
 * Usage: npm run enroll -- <path-to-photos-folder>
 *
 * Requirements:
 *   - 5–15 clear photos of your child (different angles, lighting, expressions)
 *   - At least 3 photos must produce a usable face detection
 *   - Face-api models must be downloaded first (npm run download-models)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadModels, extractSingleDescriptor, averageDescriptors } = require('./lib/faceMatch');
const { loadCache, saveCache, getCachedEntry, setCachedEntry } = require('./lib/faceCache');

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.webp'];

async function main() {
  const defaultDir = './train_photos';
  const photosDir = process.argv[2] || process.env.TRAIN_PHOTOS_PATH || defaultDir;
  const resolvedDir = path.resolve(photosDir);

  if (!fs.existsSync(resolvedDir)) {
    console.error(`\nDirectory not found: ${resolvedDir}`);
    console.error(`\nPlease place 5–15 photos of your child inside the "${defaultDir}" folder,`);
    console.error('or specify another path: npm run enroll -- <folder-path>');
    process.exit(1);
  }

  // Prepare face recognition models path & cache
  const modelsDir = path.resolve(process.env.MODELS_PATH || './models');
  if (!fs.existsSync(modelsDir)) {
    console.error(`Models directory not found: ${modelsDir}`);
    console.error('Run `npm run download-models` first.');
    process.exit(1);
  }

  const cachePath = path.resolve(process.env.TRAIN_CACHE_PATH || './data/train-cache.json');
  const cache = loadCache(cachePath);
  let cacheDirty = false;
  let modelsLoaded = false;

  // Find image files in the provided directory
  const files = fs.readdirSync(resolvedDir)
    .filter(f => SUPPORTED_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .sort()
    .map(f => path.join(resolvedDir, f));

  if (files.length === 0) {
    console.error(`\nNo image files found in: ${resolvedDir}`);
    console.error(`Please copy 5–15 photos of your child into this folder.`);
    console.error(`Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}`);
    process.exit(1);
  }

  console.log(`\nFound ${files.length} image(s) in ${resolvedDir}`);
  console.log('Processing photos for face detection...\n');

  // Extract a face descriptor from each photo
  const descriptors = [];
  const failures = [];

  for (const file of files) {
    const basename = path.basename(file);
    process.stdout.write(`  ${basename.padEnd(40)}`);
    try {
      const buffer = fs.readFileSync(file);
      const cacheEntry = getCachedEntry(cache, buffer);

      if (cacheEntry.hit) {
        if (cacheEntry.detected && cacheEntry.descriptor) {
          descriptors.push(cacheEntry.descriptor);
          console.log('✓ face detected (cached ⚡)');
        } else {
          failures.push(basename);
          console.log('✗ no face detected (cached)');
        }
      } else {
        if (!modelsLoaded) {
          await loadModels(modelsDir);
          modelsLoaded = true;
        }
        const descriptor = await extractSingleDescriptor(buffer);
        if (descriptor) {
          descriptors.push(descriptor);
          console.log('✓ face detected');
        } else {
          failures.push(basename);
          console.log('✗ no face detected');
        }
        setCachedEntry(cache, cacheEntry.hash, {
          filename: basename,
          detected: Boolean(descriptor),
          descriptor,
          error: null
        });
        cacheDirty = true;
      }
    } catch (err) {
      failures.push(basename);
      console.log(`✗ error: ${err.message}`);
    }
  }

  if (cacheDirty) {
    saveCache(cachePath, cache);
  }

  // Report results
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Photos processed: ${files.length}`);
  console.log(`  Faces detected:   ${descriptors.length}`);
  console.log(`  Failed:           ${failures.length}`);

  if (failures.length > 0) {
    console.log(`\n  Failed photos:`);
    for (const f of failures) {
      console.log(`    - ${f}`);
    }
  }

  // Enforce minimum threshold
  if (descriptors.length < 3) {
    console.error(`\n⚠  ERROR: Only ${descriptors.length} valid face detection(s) — minimum is 3.`);
    console.error('   Please provide clearer photos with:');
    console.error('   - Good lighting (no heavy shadows or backlighting)');
    console.error('   - Face clearly visible (not too far, not too close)');
    console.error('   - Variety of angles (front, slight left/right turns)');
    process.exit(1);
  }

  // Average descriptors and save
  const averaged = averageDescriptors(descriptors);
  const outputPath = path.resolve(process.env.REFERENCE_EMBEDDING_PATH || './data/child-reference.json');
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const referenceData = {
    createdAt: new Date().toISOString(),
    photosUsed: descriptors.length,
    totalPhotos: files.length,
    descriptor: Array.from(averaged)
  };

  fs.writeFileSync(outputPath, JSON.stringify(referenceData, null, 2));

  console.log(`\n✓ Reference embedding saved to: ${outputPath}`);
  console.log(`  Based on ${descriptors.length} face detections from ${files.length} photos.`);
  console.log('  Only the numeric embedding is stored — no photos are kept.');
  console.log('\n  You can now run `npm start` to begin monitoring.');
}

main().catch(err => {
  console.error('\nEnrollment failed:', err);
  process.exit(1);
});
