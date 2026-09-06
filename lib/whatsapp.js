const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

/**
 * Creates and configures a WhatsApp Web client with local session persistence.
 *
 * Session data (auth tokens, cookies, IndexedDB) is stored on disk via Puppeteer's
 * --user-data-dir. On subsequent launches, if the session is still valid, the client
 * authenticates automatically and fires 'ready' without showing a QR code.
 *
 * @param {object} opts
 * @param {string} opts.sessionPath - Directory for session data storage
 * @param {object} opts.logger - Logger instance with info/warn/error methods
 * @param {function} [opts.onReady] - Callback invoked with (client) when ready
 * @param {function} [opts.onMessage] - Message handler invoked with (msg) for each incoming message
 * @returns {Client} The configured (but not yet initialized) WhatsApp client
 */
function createClient({ sessionPath, onReady, onMessage, logger }) {
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'kid-forwarder',
      dataPath: sessionPath
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-first-run'
      ]
    },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });

  // Loading progress
  client.on('loading_screen', (percent, message) => {
    logger.info(`Loading WhatsApp Web: ${percent}% (${message || 'syncing'})`);
  });

  client.on('change_state', (state) => {
    logger.info(`WhatsApp state: ${state}`);
  });

  // QR code for first-time login (or session expiry)
  client.on('qr', (qr) => {
    console.log('\n========================================');
    console.log('  Scan this QR code with WhatsApp:');
    console.log('  (Open WhatsApp → Linked Devices → Link a Device)');
    console.log('========================================\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    logger.info('WhatsApp session authenticated.');
  });

  client.on('auth_failure', (msg) => {
    logger.error('WhatsApp authentication failed. Delete session folder and re-scan QR.', {
      detail: msg
    });
  });

  client.on('ready', () => {
    logger.info('WhatsApp client is ready and connected.');
    if (onReady) onReady(client);
  });

  // Auto-reconnect after disconnection (e.g. sleep/wake cycle)
  client.on('disconnected', (reason) => {
    logger.warn('WhatsApp client disconnected.', { reason });
    logger.info('Attempting to reconnect in 5 seconds...');
    setTimeout(() => {
      client.initialize();
    }, 5000);
  });

  // Register message handlers:
  // - 'message' fires for incoming messages from other participants
  // - 'message_create' fires for all messages (including self-forwarded/outgoing)
  // Deduplication in index.js ensures no double-processing.
  if (onMessage) {
    const handleMsg = (msg) => {
      try {
        if (msg && msg.id && typeof msg.id === 'object' && !msg.id._serialized) {
          const remote = typeof msg.id.remote === 'object'
            ? (msg.id.remote?._serialized || msg.id.remote?.$1 || msg.id.remote?.user || '')
            : (msg.id.remote || '');
          msg.id._serialized = msg.id.$1 || (remote && msg.id.id ? `${msg.id.fromMe}_${remote}_${msg.id.id}` : undefined);
        }
      } catch {}
      return onMessage(msg);
    };

    client.on('message', handleMsg);
    client.on('message_create', handleMsg);
  }

  return client;
}

/**
 * Creates a safe sender wrapper that intercepts all WhatsApp sendMessage calls
 * and enforces strict multi-layered safety guardrails.
 *
 * @param {object} client - WhatsApp client or mock
 * @param {object} opts
 * @param {string} opts.sourceChatId - The monitored source group
 * @param {boolean} opts.enableForwarding - Must be explicitly true to send live messages
 * @param {boolean} opts.allowGroupForwarding - Must be explicitly true to send to a group
 * @param {object} opts.logger - Logger instance
 * @returns {function} safeSendMessage(targetChatId, media, options)
 */
function createSafeSender(client, { sourceChatId, enableForwarding, allowGroupForwarding, logger }) {
  return async function safeSendMessage(targetChatId, media, options = {}) {
    // Check 1: Anti-Echo Protection — NEVER send to the source/kindergarten group
    if (targetChatId === sourceChatId) {
      const err = new Error(
        `CRITICAL SAFETY VIOLATION: Attempted to send media to SOURCE_CHAT_ID (${targetChatId})! Message blocked.`
      );
      if (logger && logger.error) {
        logger.error('CRITICAL: Blocked attempt to send to source group.', { targetChatId });
      }
      throw err;
    }

    // Check 2: Group Protection — Prevent accidental group sends unless explicitly authorized
    if (targetChatId && targetChatId.endsWith('@g.us') && !allowGroupForwarding) {
      if (logger && logger.warn) {
        logger.warn('BLOCKED: Target is a group chat (@g.us), but ALLOW_GROUP_FORWARDING is false.', {
          targetChatId
        });
      }
      return { sent: false, reason: 'GROUP_FORWARDING_DISABLED' };
    }

    // Check 3: Armed / Dry-Run Flag — Only send if ENABLE_FORWARDING is explicitly true
    if (!enableForwarding) {
      if (logger && logger.info) {
        logger.info('DRY-RUN: Match confirmed, but message NOT sent (ENABLE_FORWARDING is false).', {
          targetChatId,
          caption: options.caption || ''
        });
      }
      return { sent: false, reason: 'DRY_RUN' };
    }

    // All safety checks passed — dispatch live message
    return await client.sendMessage(targetChatId, media, options);
  };
}

/**
 * Cleanly stops and destroys a WhatsApp client instance.
 * Unbinds all event listeners first to prevent disconnection handlers from firing.
 *
 * @param {Client} client
 */
async function destroyClient(client) {
  if (!client) return;
  try {
    client.removeAllListeners();
    await client.destroy();
  } catch {}
}

module.exports = { createClient, createSafeSender, destroyClient };


