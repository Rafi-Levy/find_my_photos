/**
 * scripts/matches.js
 *
 * Recent Matches Viewer.
 * Displays a formatted summary of matched photos/videos saved locally in matches_preview/.
 *
 * Usage: npm run matches
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const previewDir = path.resolve(process.env.MATCH_PREVIEW_PATH || path.join(rootDir, 'matches_preview'));

function showMatches() {
  console.log('\n================================================================');
  console.log('  WhatsApp Kid-Photo Forwarder — Recent Matches');
  console.log('================================================================');
  console.log(`  Directory: ${path.relative(rootDir, previewDir)}/\n`);

  if (!fs.existsSync(previewDir)) {
    console.log('  No matches_preview folder found yet. Matches will appear here once detected.\n');
    return;
  }

  const jsonFiles = fs.readdirSync(previewDir)
    .filter(f => f.startsWith('match_') && f.endsWith('.json'))
    .map(f => path.join(previewDir, f));

  if (jsonFiles.length === 0) {
    console.log('  No matching media found yet in preview folder.\n');
    return;
  }

  const matches = [];
  for (const file of jsonFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      matches.push({ ...data, _metaFile: file });
    } catch {}
  }

  matches.sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));

  console.log(`  Found ${matches.length} recorded match(es):\n`);
  console.log('  ' + 'DATE / TIME'.padEnd(20) + 'TYPE'.padEnd(8) + 'DIST'.padEnd(8) + 'STATUS'.padEnd(16) + 'CAPTION / FILE');
  console.log('  ' + '─'.repeat(74));

  for (const m of matches) {
    const dateStr = m.savedAt ? new Date(m.savedAt).toLocaleString().slice(0, 18).padEnd(20) : 'unknown date'.padEnd(20);
    const typeStr = (m.mediaType || 'image').toUpperCase().padEnd(8);
    const distStr = (m.distance ? String(m.distance) : '-').padEnd(8);
    const statusStr = (m.forwardingEnabled ? 'FORWARDED' : 'DRY-RUN (Saved)').padEnd(16);
    const captionOrFile = m.caption ? `"${m.caption.slice(0, 20)}"` : (m.mediaFile || path.basename(m._metaFile));

    console.log(`  ${dateStr}${typeStr}${distStr}${statusStr}${captionOrFile}`);
  }

  console.log('  ' + '─'.repeat(74));
  console.log('\n  Open the folder to view media files directly:');
  console.log(`  ${previewDir}\n`);
}

showMatches();
