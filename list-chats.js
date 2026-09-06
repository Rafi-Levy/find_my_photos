/**
 * list-chats.js
 *
 * CLI helper to list all WhatsApp chats with their names and internal IDs.
 * Use this to find the correct SOURCE_CHAT_ID and TARGET_CHAT_ID for your .env file.
 *
 * Each entry is labeled [GROUP] or [PERSON] so you can easily identify which
 * ID format applies (@g.us for groups, @c.us for individual contacts).
 *
 * Usage: npm run list-chats
 *
 * On first run, you'll need to scan a QR code. On subsequent runs, the saved
 * session will be used automatically.
 */
require('dotenv').config();
const path = require('path');
const { createClient } = require('./lib/whatsapp');
const Logger = require('./lib/logger');

const logger = new Logger(process.env.LOG_PATH || './logs/activity.log');

const client = createClient({
  sessionPath: path.resolve(process.env.SESSION_DATA_PATH || './.wwebjs_auth'),
  logger,
  onReady: async (client) => {
    console.log('\nFetching chats...\n');

    try {
      const chats = await client.getChats();

      console.log('='.repeat(80));
      console.log('  YOUR WHATSAPP CHATS');
      console.log('='.repeat(80));
      console.log('');

      // Separate groups and individuals for clearer display
      const groups = chats.filter(c => c.isGroup);
      const individuals = chats.filter(c => !c.isGroup);

      if (groups.length > 0) {
        console.log(`  ── GROUPS (${groups.length}) ${'─'.repeat(55)}`);
        for (const chat of groups) {
          const name = (chat.name || 'Unnamed').padEnd(40);
          console.log(`  [GROUP]   ${name} ${chat.id._serialized}`);
        }
        console.log('');
      }

      if (individuals.length > 0) {
        console.log(`  ── CONTACTS (${individuals.length}) ${'─'.repeat(53)}`);
        for (const chat of individuals) {
          const name = (chat.name || 'Unnamed').padEnd(40);
          console.log(`  [PERSON]  ${name} ${chat.id._serialized}`);
        }
        console.log('');
      }

      console.log('='.repeat(80));
      console.log(`\n  Total: ${chats.length} chats (${groups.length} groups, ${individuals.length} contacts)`);
      console.log('');
      console.log('  To configure the forwarder, copy the IDs you need into your .env file:');
      console.log('');
      console.log('    SOURCE_CHAT_ID=<the group to watch>        (must end with @g.us)');
      console.log('    TARGET_CHAT_ID=<where to forward matches>  (can be @g.us or @c.us)');
      console.log('');
    } catch (err) {
      console.error('Error fetching chats:', err.message);
    }

    await client.destroy();
    process.exit(0);
  }
});

client.initialize();

// Timeout safety — if auth takes too long, exit gracefully
setTimeout(() => {
  console.error('\nTimeout: Could not connect within 2 minutes.');
  console.error('Check your internet connection and try again.');
  process.exit(1);
}, 120000);
