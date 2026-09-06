const fs = require('fs');
const path = require('path');
const Module = require('module');
const sharp = require('sharp');

// Shim: redirect @tensorflow/tfjs-node → pure-JS @tensorflow/tfjs
// The face-api.node.js bundle hardcodes `require('@tensorflow/tfjs-node')` which
// needs native C++ binaries that don't build on Node 24+. By intercepting the
// module resolver, we substitute the pure-JavaScript TF.js package instead.
// This is a standard Node.js module aliasing pattern.
const _origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === '@tensorflow/tfjs-node') {
    return _origResolve.call(this, '@tensorflow/tfjs', ...args);
  }
  return _origResolve.call(this, request, ...args);
};

const tf = require('@tensorflow/tfjs');
const faceapi = require('@vladmandic/face-api/dist/face-api.node.js');

let modelsLoaded = false;

/**
 * Load the three required face-api models from disk:
 *   1. SSD MobileNet v1 — face detection (high accuracy)
 *   2. FaceLandmark68Net — 68-point landmark extraction (required for alignment)
 *   3. FaceRecognitionNet — 128-d embedding extraction (ResNet-34 based)
 *
 * @param {string} modelsDir - Path to directory containing model weight files
 */
async function loadModels(modelsDir) {
  if (modelsLoaded) return;
  console.log('Loading face-api models...');
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsDir);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsDir);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsDir);
  modelsLoaded = true;
  console.log('Face-api models loaded successfully.');
}

/**
 * Decode an image buffer (JPEG/PNG/WebP/etc.) into a TF.js tensor3d [H, W, 3].
 * Uses sharp to extract raw RGB pixel data — no native TF addon or canvas needed.
 *
 * @param {Buffer} imageBuffer - Raw image file data
 * @returns {Promise<tf.Tensor3D>} Decoded image tensor [height, width, 3]
 */
async function decodeImage(imageBuffer) {
  // Use sharp to decode any image format into raw RGB pixel buffer
  const { data, info } = await sharp(imageBuffer)
    .removeAlpha()        // Ensure exactly 3 channels (RGB)
    .raw()                // Output raw uncompressed pixel data
    .toBuffer({ resolveWithObject: true });

  // Create a TF.js tensor from the raw pixel buffer
  return tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
}

/**
 * Extract 128-d face descriptors for ALL faces detected in an image.
 * Uses sharp for image decoding — works on any Node version, no native TF addon.
 *
 * @param {Buffer} imageBuffer - JPEG/PNG image data as a Node Buffer
 * @returns {Promise<Float32Array[]>} Array of 128-d descriptor vectors (one per face)
 */
async function extractAllDescriptors(imageBuffer) {
  const tensor = await decodeImage(imageBuffer);
  try {
    const detections = await faceapi
      .detectAllFaces(tensor, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();
    return detections.map(d => d.descriptor);
  } finally {
    // CRITICAL: Dispose tensor to prevent memory leak.
    // Even with pure-JS TF.js, tensors consume WebGL/CPU backing memory
    // that the JS garbage collector doesn't track.
    tensor.dispose();
  }
}

/**
 * Extract a single face descriptor from an image (picks the most prominent face).
 * Used during enrollment to get one embedding per reference photo.
 *
 * @param {Buffer} imageBuffer - JPEG/PNG image data
 * @returns {Promise<Float32Array|null>} 128-d descriptor, or null if no face found
 */
async function extractSingleDescriptor(imageBuffer) {
  const tensor = await decodeImage(imageBuffer);
  try {
    const detection = await faceapi
      .detectSingleFace(tensor, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    return detection ? detection.descriptor : null;
  } finally {
    tensor.dispose();
  }
}

/**
 * Check if ANY face in a set of descriptors matches the reference embedding
 * within the given euclidean distance threshold. Short-circuits on first match.
 *
 * @param {Float32Array[]} descriptors - Detected face descriptors from an image
 * @param {Float32Array} referenceDescriptor - The enrolled child's reference embedding
 * @param {number} threshold - Max euclidean distance to consider a match (e.g. 0.5)
 * @returns {{ matched: boolean, distance: number|null }}
 */
function anyFaceMatches(descriptors, referenceDescriptor, threshold) {
  let minDistance = Infinity;
  for (const desc of descriptors) {
    const distance = faceapi.euclideanDistance(
      Array.from(desc),
      Array.from(referenceDescriptor)
    );
    if (distance < minDistance) {
      minDistance = distance;
    }
    if (distance < threshold) {
      return { matched: true, distance, bestDistance: minDistance };
    }
  }
  return {
    matched: false,
    distance: null,
    bestDistance: minDistance === Infinity ? null : minDistance
  };
}

/**
 * Average multiple 128-d face descriptors into a single reference embedding.
 *
 * Important: After averaging, the result vector is L2-normalized back to unit length.
 * face-api descriptors live on a unit hypersphere (||v|| = 1). A raw arithmetic mean
 * would produce a vector with ||mean|| < 1, which would break euclidean distance
 * comparisons against normalized query vectors.
 *
 * @param {Float32Array[]} descriptors - Array of 128-d embeddings from reference photos
 * @returns {Float32Array} Single 128-d unit-normalized reference descriptor
 */
function averageDescriptors(descriptors) {
  if (!descriptors || descriptors.length === 0) {
    throw new Error('Must provide at least one descriptor to average');
  }
  if (descriptors.length === 1) {
    return new Float32Array(descriptors[0]);
  }

  const dim = 128;
  const avg = new Float32Array(dim);

  // Step 1: Element-wise sum
  for (const desc of descriptors) {
    for (let i = 0; i < dim; i++) {
      avg[i] += desc[i];
    }
  }

  // Step 2: Arithmetic mean
  for (let i = 0; i < dim; i++) {
    avg[i] /= descriptors.length;
  }

  // Step 3: L2 normalization — project back onto the unit hypersphere
  let sumSquares = 0;
  for (let i = 0; i < dim; i++) {
    sumSquares += avg[i] * avg[i];
  }
  const norm = Math.sqrt(sumSquares);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      avg[i] /= norm;
    }
  }

  return avg;
}

/**
 * Load a previously saved reference embedding from a JSON file.
 *
 * @param {string} filePath - Path to the child-reference.json file
 * @returns {Float32Array} 128-d reference descriptor
 */
function loadReference(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return new Float32Array(data.descriptor);
}

module.exports = {
  loadModels,
  extractAllDescriptors,
  extractSingleDescriptor,
  anyFaceMatches,
  averageDescriptors,
  loadReference
};
