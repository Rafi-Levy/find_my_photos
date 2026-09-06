const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Compute a SHA-256 hash of an image buffer.
 * @param {Buffer} buffer
 * @returns {string} Hex-encoded SHA-256 hash
 */
function computeBufferHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Load the cache from disk.
 * @param {string} cachePath
 * @returns {Record<string, { detected: boolean, descriptor: number[]|null, filename?: string, error?: string|null, cachedAt?: string }>}
 */
function loadCache(cachePath) {
  try {
    if (fs.existsSync(cachePath)) {
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (typeof data === 'object' && data !== null) {
        return data;
      }
    }
  } catch {
    // If corrupt or unreadable, return empty cache
  }
  return {};
}

/**
 * Save the cache to disk.
 * @param {string} cachePath
 * @param {object} cache
 */
function saveCache(cachePath, cache) {
  try {
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    // Non-fatal if saving cache fails
  }
}

/**
 * Lookup an entry by image buffer.
 * @param {object} cache
 * @param {Buffer} buffer
 * @returns {{ hit: boolean, hash: string, detected?: boolean, descriptor?: Float32Array|null, error?: string|null }}
 */
function getCachedEntry(cache, buffer) {
  const hash = computeBufferHash(buffer);
  const entry = cache[hash];
  if (!entry) {
    return { hit: false, hash };
  }

  return {
    hit: true,
    hash,
    detected: Boolean(entry.detected),
    descriptor: Array.isArray(entry.descriptor) && entry.descriptor.length === 128
      ? new Float32Array(entry.descriptor)
      : null,
    error: entry.error || null
  };
}

/**
 * Store a result in the cache dictionary.
 * @param {object} cache
 * @param {string} hash
 * @param {{ filename?: string, detected: boolean, descriptor?: Float32Array|number[]|null, error?: string|null }} data
 */
function setCachedEntry(cache, hash, { filename, detected, descriptor, error }) {
  cache[hash] = {
    filename: filename || '',
    detected: Boolean(detected),
    descriptor: descriptor ? Array.from(descriptor) : null,
    error: error || null,
    cachedAt: new Date().toISOString()
  };
}

/**
 * Clear the cache file from disk.
 * @param {string} cachePath
 */
function clearCache(cachePath) {
  try {
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
  } catch {}
}

module.exports = {
  computeBufferHash,
  loadCache,
  saveCache,
  getCachedEntry,
  setCachedEntry,
  clearCache
};
