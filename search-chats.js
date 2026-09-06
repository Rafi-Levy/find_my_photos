/**
 * search-chats.js
 *
 * Interactive CLI tool to search WhatsApp Web's internal IndexedDB for chats/groups
 * by keyword (e.g. "kindergarten"), view their details, and select SOURCE_CHAT_ID and
 * TARGET_CHAT_ID to save automatically into your .env file.
 *
 * Usage: npm run search-chats
 */
require('dotenv').config();
const path = require('path');
const { createClient } = require('./lib/whatsapp');
const { interactiveSelectChats } = require('./lib/chatSelector');
const Logger = require('./lib/logger');

const logger = new Logger(process.env.LOG_PATH || './logs/activity.log');
const sessionPath = path.resolve(process.env.SESSION_DATA_PATH || './.wwebjs_auth');

console.log('\nConnecting to WhatsApp Web...\n');

const client = createClient({
  sessionPath,
  logger,
  onReady: async (readyClient) => {
    try {
      await interactiveSelectChats(readyClient, {
        needSource: true,
        needTarget: true
      });
    } catch (err) {
      console.error('\nError during chat selection:', err.message);
    } finally {
      console.log('Closing WhatsApp session...');
      try {
        await readyClient.destroy();
      } catch {}
      process.exit(0);
    }
  }
});

client.initialize();

// Safety timeout: 2 minutes for authentication
setTimeout(() => {
  console.error('\nTimeout: Could not connect within 2 minutes.');
  console.error('Check your internet connection and try again.');
  process.exit(1);
}, 120000);
