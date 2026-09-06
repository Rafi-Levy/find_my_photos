const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');

// Use the npm-bundled ffmpeg/ffprobe binaries — no system install required
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

/**
 * Get video duration in seconds using ffprobe.
 * Checks both format-level and stream-level duration metadata.
 *
 * @param {string} videoPath - Absolute path to video file
 * @returns {Promise<number>} Duration in seconds
 */
function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata.format?.duration
        || metadata.streams?.find(s => s.codec_type === 'video')?.duration;
      if (!duration || isNaN(duration) || Number(duration) <= 0) {
        return reject(new Error(`Cannot determine video duration: ${videoPath}`));
      }
      resolve(parseFloat(duration));
    });
  });
}

/**
 * Calculate N evenly-spaced timestamps using midpoint distribution.
 * Avoids 0s (black intro frames) and end-of-file (incomplete frames)
 * by placing each sample at the center of N equal-sized time buckets.
 *
 * Example: duration=10s, count=5 → [1.0, 3.0, 5.0, 7.0, 9.0]
 *
 * @param {number} duration - Video duration in seconds
 * @param {number} count - Number of timestamps to generate
 * @returns {number[]} Array of timestamps in seconds
 */
function calculateTimestamps(duration, count) {
  if (count <= 0) return [];
  if (count === 1) return [Number((duration / 2).toFixed(3))];
  const step = duration / count;
  return Array.from({ length: count }, (_, i) =>
    Number(((i + 0.5) * step).toFixed(3))
  );
}

/**
 * Extract frames at specified timestamps using fluent-ffmpeg screenshots.
 *
 * @param {string} videoPath - Path to video file
 * @param {number[]} timestamps - Array of timestamps in seconds
 * @param {string} outputDir - Directory to save frame images
 * @returns {Promise<string[]>} Array of absolute paths to extracted frame files
 */
function extractFrames(videoPath, timestamps, outputDir) {
  return new Promise((resolve, reject) => {
    const filenames = [];
    ffmpeg(videoPath)
      .on('filenames', (fns) => filenames.push(...fns))
      .on('end', () => resolve(filenames.map(f => path.join(outputDir, f))))
      .on('error', (err, _stdout, stderr) => {
        reject(new Error(`FFmpeg error: ${err.message}\n${stderr || ''}`));
      })
      .screenshots({
        timestamps,
        folder: outputDir,
        filename: 'frame-%03i.jpg'
      });
  });
}

/**
 * High-level helper: extract N evenly-spaced frames from a video into a temp
 * directory, run the provided callback with the frame file paths, and guarantee
 * cleanup of all temp files regardless of success or failure.
 *
 * @param {string} videoPath - Path to the video file
 * @param {number} frameCount - Number of frames to extract
 * @param {function(string[]): Promise<T>} callback - Receives array of frame file paths
 * @returns {Promise<T>} Whatever the callback returns
 */
async function withExtractedFrames(videoPath, frameCount, callback) {
  // Verify input file exists before spawning ffmpeg
  await fs.access(videoPath);

  // Create a dedicated temp directory for this extraction
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kid-fwd-frames-'));

  try {
    const duration = await getVideoDuration(videoPath);
    const timestamps = calculateTimestamps(duration, frameCount);
    const framePaths = await extractFrames(videoPath, timestamps, tempDir);
    return await callback(framePaths);
  } finally {
    // Guarantee cleanup — silently ignore errors (dir may already be gone)
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; don't mask the original error
    }
  }
}

module.exports = { withExtractedFrames };
