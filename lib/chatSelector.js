/**
 * lib/chatSelector.js
 *
 * Interactive helper that queries WhatsApp Web's internal IndexedDB ("model-storage")
 * to search for chats/groups by keyword (e.g. "kindergarten"), lets the user select the IDs,
 * and saves them directly to .env.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

/**
 * Executes a search against WhatsApp Web's internal IndexedDB inside the Puppeteer page.
 * Searches the "chat", "contact", and "group-metadata" stores.
 *
 * @param {import('puppeteer').Page} pupPage - Puppeteer page instance
 * @param {string} searchTerm - Keyword to search for (case-insensitive, UTF-8/Hebrew safe)
 * @returns {Promise<Array<{id: string, name: string, type: string, tables: string[]}>>}
 */
async function searchIndexedDBChats(pupPage, searchTerm = '') {
  if (!pupPage || typeof pupPage.evaluate !== 'function') {
    throw new Error('Puppeteer page is not available to query IndexedDB.');
  }

  const rawMatches = await pupPage.evaluate((search) => {
    return new Promise((resolve) => {
      const term = (search || '').toLowerCase().trim();
      try {
        const req = window.indexedDB.open('model-storage');
        req.onerror = () => resolve([]);
        req.onsuccess = (e) => {
          const db = e.target.result;
          const storeNames = Array.from(db.objectStoreNames || []);
          const relevantStores = storeNames.filter(name =>
            ['chat', 'contact', 'group-metadata'].includes(name)
          );

          if (relevantStores.length === 0) return resolve([]);

          let pending = relevantStores.length;
          const allItems = [];

          relevantStores.forEach((name) => {
            try {
              const tx = db.transaction(name, 'readonly');
              const store = tx.objectStore(name);
              const getAllReq = store.getAll();

              getAllReq.onsuccess = (ev) => {
                const results = ev.target.result || [];
                for (const item of results) {
                  try {
                    const str = JSON.stringify(item).toLowerCase();
                    if (!term || str.includes(term)) {
                      let rawId = null;
                      if (item.id) {
                        if (typeof item.id === 'string') rawId = item.id;
                        else rawId = item.id._serialized || item.id.$1 || item.id.user || null;
                      }
                      if (!rawId) rawId = item.key || item.jid;

                      if (rawId) {
                        const idStr = String(rawId);
                        let type = 'Direct Chat';
                        if (idStr.includes('@g.us')) type = 'Group';
                        else if (idStr.includes('@lid')) type = 'Direct Chat (LID)';
                        else if (idStr.includes('@broadcast') || idStr.includes('newsletter')) {
                          type = 'Channel/Broadcast';
                        }

                        allItems.push({
                          table: name,
                          type,
                          name: item.name || item.formattedTitle || item.subject || item.pushname || '',
                          id: idStr
                        });
                      }
                    }
                  } catch (err) {}
                }
                pending--;
                if (pending === 0) resolve(allItems);
              };

              getAllReq.onerror = () => {
                pending--;
                if (pending === 0) resolve(allItems);
              };
            } catch (err) {
              pending--;
              if (pending === 0) resolve(allItems);
            }
          });
        };
      } catch (err) {
        resolve([]);
      }
    });
  }, searchTerm);

  // Deduplicate entries by ID and pick the most descriptive title
  const chatMap = new Map();
  for (const item of rawMatches) {
    const existing = chatMap.get(item.id);
    const cleanName = item.name && item.name !== '(Matched)' && item.name !== '(Unknown)' ? item.name.trim() : '';

    if (!existing) {
      chatMap.set(item.id, {
        id: item.id,
        name: cleanName || 'Unnamed',
        type: item.type,
        tables: [item.table]
      });
    } else {
      if ((!existing.name || existing.name === 'Unnamed') && cleanName) {
        existing.name = cleanName;
      }
      if (!existing.tables.includes(item.table)) {
        existing.tables.push(item.table);
      }
    }
  }

  // Sort groups first, then contacts, then channels
  const results = Array.from(chatMap.values()).sort((a, b) => {
    const rank = (type) => (type === 'Group' ? 1 : type.startsWith('Direct') ? 2 : 3);
    const rankDiff = rank(a.type) - rank(b.type);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return results;
}

/**
 * Updates or creates the .env file with given key-value pairs without breaking
 * existing comments and variables.
 *
 * @param {Record<string, string>} updates - Key/value pairs to set
 * @param {string} [envPath] - Path to .env file
 */
function updateEnvFile(updates, envPath = path.resolve(process.cwd(), '.env')) {
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  } else {
    const examplePath = path.resolve(path.dirname(envPath), '.env.example');
    if (fs.existsSync(examplePath)) {
      content = fs.readFileSync(examplePath, 'utf-8');
    }
  }

  for (const [key, val] of Object.entries(updates)) {
    if (val === undefined || val === null) continue;
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content += (content.endsWith('\n') || !content ? '' : '\n') + `${key}=${val}\n`;
    }
  }

  fs.writeFileSync(envPath, content, 'utf-8');
}

/**
 * Helper to ask a question via readline.
 */
function askQuestion(rl, query) {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve((answer || '').trim());
    });
  });
}

/**
 * Prints a formatted list of chat search results.
 */
function displayChatResults(matches) {
  console.log('\n' + '─'.repeat(78));
  if (matches.length === 0) {
    console.log('  No matching chats found.');
    console.log('─'.repeat(78) + '\n');
    return;
  }

  console.log(`  Found ${matches.length} matching chat(s):`);
  console.log('─'.repeat(78));

  matches.forEach((chat, index) => {
    const idx = `[${index + 1}]`.padEnd(5);
    const type = `[${chat.type}]`.padEnd(16);
    const name = chat.name.padEnd(30).slice(0, 30);
    console.log(`  ${idx} ${type} ${name}  ${chat.id}`);
  });
  console.log('─'.repeat(78) + '\n');
}

/**
 * Runs the interactive CLI selection workflow.
 *
 * @param {import('whatsapp-web.js').Client} client - Initialized & ready WhatsApp client
 * @param {object} opts
 * @param {boolean} [opts.needSource=true] - Whether to prompt for SOURCE_CHAT_ID
 * @param {boolean} [opts.needTarget=true] - Whether to prompt for TARGET_CHAT_ID
 * @param {string} [opts.defaultSearch=''] - Initial search keyword (e.g. 'kindergarten')
 * @param {string} [opts.envPath] - Path to .env file
 * @returns {Promise<{ sourceChatId?: string, targetChatId?: string }>}
 */
async function interactiveSelectChats(client, opts = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const needSource = opts.needSource !== false;
  const needTarget = opts.needTarget !== false;
  let sourceChatId = process.env.SOURCE_CHAT_ID || null;
  let targetChatId = process.env.TARGET_CHAT_ID || null;

  // Filter out placeholder IDs
  if (sourceChatId && sourceChatId.includes('xxxx')) sourceChatId = null;
  if (targetChatId && targetChatId.includes('yyyy')) targetChatId = null;

  console.log('\n================================================================');
  console.log('  WhatsApp Chat Selector (IndexedDB Search)');
  console.log('================================================================');
  console.log('  Search chats by name or keyword directly from WhatsApp Web.');
  console.log('  Type your search term (e.g. "kindergarten", a group name, or contact name).\n');

  try {
    let currentMatches = [];

    // Helper loop for searching
    async function doSearch(promptText) {
      while (true) {
        const query = await askQuestion(rl, promptText);
        if (!query && currentMatches.length > 0) {
          return currentMatches;
        }
        console.log(`\nSearching WhatsApp IndexedDB for "${query || '(all)'}"...`);
        const results = await searchIndexedDBChats(client.pupPage, query);
        currentMatches = results;
        displayChatResults(results);
        if (results.length > 0) return results;
        console.log('Try another search keyword, or press Ctrl+C to cancel.');
      }
    }

    // 1. Select SOURCE_CHAT_ID if needed
    if (needSource && !sourceChatId) {
      console.log('► STEP 1: Select SOURCE GROUP to monitor (kindergarten group)');
      console.log('  Must be a group ending in @g.us.');

      await doSearch(opts.defaultSearch ? `Enter keyword to search [default: ${opts.defaultSearch}]: ` : 'Enter keyword to search: ');

      while (!sourceChatId) {
        const answer = await askQuestion(
          rl,
          `Select SOURCE group number (1-${currentMatches.length}), or 's' to search again: `
        );

        if (answer.toLowerCase() === 's') {
          await doSearch('Enter keyword to search: ');
          continue;
        }

        const num = parseInt(answer, 10);
        if (!isNaN(num) && num >= 1 && num <= currentMatches.length) {
          const selected = currentMatches[num - 1];
          if (!selected.id.endsWith('@g.us')) {
            console.log(`\n⚠ Error: "${selected.name}" (${selected.id}) is not a group!`);
            console.log('  The SOURCE must be a group ending with @g.us. Please pick a group.\n');
            continue;
          }
          sourceChatId = selected.id;
          console.log(`\n✔ Selected SOURCE group: "${selected.name}" (${sourceChatId})\n`);
        } else {
          console.log('Invalid choice. Enter a number from the list or "s" to search again.');
        }
      }
    }

    // 2. Select TARGET_CHAT_ID if needed
    if (needTarget && !targetChatId) {
      console.log('► STEP 2: Select TARGET to forward matched media to');
      console.log('  Can be a person (@c.us) or a group (@g.us).');

      const reuse = await askQuestion(
        rl,
        `Use existing search results (${currentMatches.length} items), or 's' to search a new name? [press Enter to use current / 's' to search]: `
      );

      if (reuse.toLowerCase() === 's' || currentMatches.length === 0) {
        await doSearch('Enter keyword to search for TARGET (e.g. family group or contact name): ');
      } else {
        displayChatResults(currentMatches);
      }

      while (!targetChatId) {
        const answer = await askQuestion(
          rl,
          `Select TARGET chat number (1-${currentMatches.length}), or 's' to search again: `
        );

        if (answer.toLowerCase() === 's') {
          await doSearch('Enter keyword to search: ');
          continue;
        }

        const num = parseInt(answer, 10);
        if (!isNaN(num) && num >= 1 && num <= currentMatches.length) {
          const selected = currentMatches[num - 1];
          if (sourceChatId && selected.id === sourceChatId) {
            console.log('\n⚠ CRITICAL SAFETY ERROR: Target chat cannot be identical to Source chat!');
            console.log('  Never forward media back to the monitored group. Pick another chat.\n');
            continue;
          }
          targetChatId = selected.id;
          console.log(`\n✔ Selected TARGET chat: "${selected.name}" (${targetChatId})\n`);
        } else {
          console.log('Invalid choice. Enter a number from the list or "s" to search again.');
        }
      }
    }

    // 3. Save to .env
    const updates = {};
    if (sourceChatId) updates.SOURCE_CHAT_ID = sourceChatId;
    if (targetChatId) updates.TARGET_CHAT_ID = targetChatId;
    if (targetChatId && targetChatId.endsWith('@g.us')) {
      updates.ALLOW_GROUP_FORWARDING = 'true';
    }

    console.log('Configuration to save:');
    if (sourceChatId) console.log(`  SOURCE_CHAT_ID=${sourceChatId}`);
    if (targetChatId) console.log(`  TARGET_CHAT_ID=${targetChatId}`);
    if (updates.ALLOW_GROUP_FORWARDING) console.log('  ALLOW_GROUP_FORWARDING=true (since target is a group)');

    const confirm = await askQuestion(rl, '\nSave these settings to .env? [Y/n]: ');
    if (confirm.toLowerCase() !== 'n') {
      updateEnvFile(updates, opts.envPath);
      process.env.SOURCE_CHAT_ID = sourceChatId;
      process.env.TARGET_CHAT_ID = targetChatId;
      if (updates.ALLOW_GROUP_FORWARDING) {
        process.env.ALLOW_GROUP_FORWARDING = 'true';
      }
      console.log('\n✔ Successfully updated .env with your selected chat IDs!\n');
    } else {
      console.log('\nChanges not saved to .env.\n');
    }

    return { sourceChatId, targetChatId };
  } finally {
    rl.close();
  }
}

module.exports = {
  searchIndexedDBChats,
  updateEnvFile,
  interactiveSelectChats
};
