const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { exec } = require('child_process');
const ForwarderEngine = require('./lib/engine');

const app = express();
const PORT = process.env.PORT || 4848;

app.use(express.json());

// Public static assets
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}
app.use(express.static(publicDir));

// Previews & Training Photos static routes
app.use('/previews', express.static(path.join(__dirname, 'matches_preview')));
app.use('/train_photos', express.static(path.join(__dirname, 'train_photos')));

// Initialize Engine
const engine = new ForwarderEngine();

// Multer configuration for uploading reference photos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = engine.config.trainPhotosDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename and prevent collisions
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const timestamp = Date.now();
    cb(null, `${timestamp}_${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per photo
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp'];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(jpe?g|png|webp|bmp)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WEBP, or BMP images are allowed.'));
    }
  }
});

// SSE Clients set
const sseClients = new Set();

function broadcastEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Attach engine event listeners to broadcast to SSE
engine.on('status', (status) => broadcastEvent('status', status));
engine.on('log', (logEntry) => broadcastEvent('log', logEntry));
engine.on('stats', (stats) => broadcastEvent('stats', stats));
engine.on('match', (match) => broadcastEvent('match', match));
engine.on('qr', (qr) => broadcastEvent('qr', qr));
engine.on('train_progress', (p) => broadcastEvent('train_progress', p));

// --- API Endpoints ---

// SSE Stream
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.add(res);

  // Send initial state snapshot immediately
  res.write(`event: status\ndata: ${JSON.stringify(engine.getStatus())}\n\n`);
  res.write(`event: stats\ndata: ${JSON.stringify(engine.statsTracker.getStats())}\n\n`);

  // Periodic heartbeat
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// Status & State
app.get('/api/status', (req, res) => {
  res.json(engine.getStatus());
});

// Stats
app.get('/api/stats', (req, res) => {
  res.json(engine.statsTracker.getStats());
});

app.post('/api/stats/reset', (req, res) => {
  const resetStats = engine.statsTracker.reset();
  broadcastEvent('stats', resetStats);
  res.json({ success: true, stats: resetStats });
});

// Logs
app.get('/api/logs', (req, res) => {
  res.json({ logs: engine.logs });
});

// Chats
app.get('/api/chats', async (req, res) => {
  const search = req.query.q || '';
  const chats = await engine.getChats(search);
  res.json({ chats });
});

// Config
app.get('/api/config', (req, res) => {
  res.json({
    sourceChatId: engine.config.sourceChatId,
    targetChatId: engine.config.targetChatId,
    enableForwarding: engine.config.enableForwarding,
    allowGroupForwarding: engine.config.allowGroupForwarding,
    matchThreshold: engine.config.matchThreshold,
    videoFrames: engine.config.videoFrames
  });
});

app.post('/api/config', (req, res) => {
  try {
    const { sourceChatId, targetChatId, enableForwarding, matchThreshold, videoFrames } = req.body;
    const updates = {};

    if (sourceChatId !== undefined) updates.SOURCE_CHAT_ID = sourceChatId;
    if (targetChatId !== undefined) updates.TARGET_CHAT_ID = targetChatId;
    if (enableForwarding !== undefined) updates.ENABLE_FORWARDING = String(Boolean(enableForwarding));
    if (matchThreshold !== undefined) updates.MATCH_THRESHOLD = String(matchThreshold);
    if (videoFrames !== undefined) updates.VIDEO_FRAMES_TO_CHECK = String(videoFrames);

    // Group target protection: auto-enable group forwarding if user picks a group as target
    if (targetChatId && targetChatId.endsWith('@g.us')) {
      updates.ALLOW_GROUP_FORWARDING = 'true';
    }

    const updatedStatus = engine.saveConfig(updates);
    res.json({ success: true, status: updatedStatus });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Monitoring toggle
app.post('/api/monitoring', (req, res) => {
  const { active } = req.body;
  const status = engine.setMonitoring(active);
  res.json({ success: true, status });
});

// Logout / Re-link
app.post('/api/logout', async (req, res) => {
  await engine.logout();
  res.json({ success: true, message: 'WhatsApp session cleared. Scan QR to reconnect.' });
});

// Train - Get photos
app.get('/api/train/photos', (req, res) => {
  res.json({ photos: engine.getTrainingPhotos() });
});

// Train - Upload photos
app.post('/api/train/upload', upload.array('photos', 20), (req, res) => {
  const uploaded = (req.files || []).map(f => ({
    name: f.filename,
    url: `/train_photos/${encodeURIComponent(f.filename)}`,
    size: f.size
  }));
  res.json({ success: true, uploaded, all: engine.getTrainingPhotos() });
});

// Train - Delete photo
app.delete('/api/train/photos/:name', (req, res) => {
  const deleted = engine.deleteTrainingPhoto(req.params.name);
  res.json({ success: deleted, all: engine.getTrainingPhotos() });
});

// Train - Profiles
app.get('/api/train/profiles', (req, res) => {
  res.json(engine.getReferenceInfo());
});

app.delete('/api/train/profiles/:name', (req, res) => {
  const deleted = engine.deleteProfile(req.params.name);
  res.json({ success: deleted, profiles: engine.getReferenceInfo() });
});

// Train - Run training
app.post('/api/train/run', async (req, res) => {
  try {
    const childName = req.body.childName || 'My Child';
    const result = await engine.runTraining((progress) => {
      broadcastEvent('train_progress', progress);
    }, childName);
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Train - Test Photo Simulator
app.post('/api/train/test', upload.single('test_photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No test photo was uploaded.' });
    }
    const buffer = fs.readFileSync(req.file.path);
    // Delete temp uploaded test photo after reading buffer
    try { fs.unlinkSync(req.file.path); } catch {}

    const result = await engine.testPhoto(buffer);
    res.json({ success: true, result });
  } catch (err) {
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(400).json({ success: false, error: err.message });
  }
});

// Desktop Shortcut Endpoint
app.post('/api/shortcut', (req, res) => {
  const psScript = path.join(__dirname, 'scripts', 'create-shortcut.ps1');
  exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScript}"`, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({ success: true, message: 'Shortcut created on Desktop!' });
  });
});

// Start Server
const server = app.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  console.log('\n================================================================');
  console.log(`  WhatsApp Kid-Photo Forwarder UI running at: ${url}`);
  console.log('================================================================\n');

  // Initialize engine in background
  engine.init().catch(err => console.error('Engine init error:', err));

  // Auto-open browser on Windows if not running tests
  if (process.env.NO_OPEN !== 'true' && process.env.NODE_ENV !== 'test') {
    const startCmd = process.platform === 'win32' ? `start ${url}` :
                     process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
    exec(startCmd, (err) => {
      if (err) console.log(`Please open ${url} in your browser.`);
    });
  }
});

module.exports = { app, server, engine };
