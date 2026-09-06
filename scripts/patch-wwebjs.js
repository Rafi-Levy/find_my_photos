/**
 * scripts/patch-wwebjs.js
 *
 * Patches whatsapp-web.js to handle WhatsApp Web's 2026 build updates
 * where `_serialized` was renamed to `$1` on message/chat IDs.
 *
 * This prevents `downloadMedia()` from failing with minified `{"error": "r"}`
 * (caused by passing `undefined` to IndexedDB lookups).
 */
const fs = require('fs');
const path = require('path');

function patchFile(filePath, transforms) {
  if (!fs.existsSync(filePath)) {
    console.log(`[patch-wwebjs] File not found, skipping: ${filePath}`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf-8');
  let modified = false;

  for (const { search, replace, name } of transforms) {
    if (content.includes(replace)) {
      console.log(`[patch-wwebjs] Already patched (${name}) in: ${path.basename(filePath)}`);
      continue;
    }

    if (content.includes(search)) {
      content = content.replace(search, replace);
      modified = true;
      console.log(`[patch-wwebjs] Applied patch (${name}) to: ${path.basename(filePath)}`);
    } else {
      console.warn(`[patch-wwebjs] Warning: Target pattern not found (${name}) in: ${path.basename(filePath)}`);
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

// 1. Patch Message.js
const messageJsPath = path.resolve(__dirname, '../node_modules/whatsapp-web.js/src/structures/Message.js');
patchFile(messageJsPath, [
  {
    name: 'id._serialized fallback in _patch',
    search: `        this.id = data.id;`,
    replace: `        this.id = data.id;
        if (this.id && !this.id._serialized) {
            const _r = typeof this.id.remote === 'object'
                ? (this.id.remote?._serialized || this.id.remote?.$1 || this.id.remote?.user || '')
                : (this.id.remote || '');
            this.id._serialized = this.id.$1 || (_r && this.id.id ? \`\${this.id.fromMe}_\${_r}_\${this.id.id}\` : undefined);
        }`
  },
  {
    name: 'downloadMedia msgId lookup fallback',
    search: `        }, this.id._serialized);`,
    replace: `        }, this.id?._serialized || this.id?.$1 || (this.id?.remote && this.id?.id ? \`\${this.id.fromMe}_\${typeof this.id.remote === 'object' ? (this.id.remote._serialized || this.id.remote.$1 || this.id.remote.user) : this.id.remote}_\${this.id.id}\` : undefined));`
  }
]);

// 2. Patch Injected/Utils.js
const utilsJsPath = path.resolve(__dirname, '../node_modules/whatsapp-web.js/src/util/Injected/Utils.js');
patchFile(utilsJsPath, [
  {
    name: 'getMessageModel _serialized and remote fallback',
    search: `        if (typeof msg.id.remote === 'object') {
            msg.id = Object.assign({}, msg.id, {
                remote: msg.id.remote._serialized,
            });
        }`,
    replace: `        if (msg.id) {
            const _remote = typeof msg.id.remote === 'object'
                ? (msg.id.remote?._serialized || msg.id.remote?.$1 || msg.id.remote?.user)
                : msg.id.remote;
            if (typeof msg.id.remote === 'object') {
                msg.id = Object.assign({}, msg.id, { remote: _remote });
            }
            msg.id._serialized = msg.id._serialized || msg.id.$1 || (_remote && msg.id.id ? \`\${msg.id.fromMe}_\${_remote}_\${msg.id.id}\` : undefined);
        }`
  }
]);

console.log('[patch-wwebjs] Patch check complete.');
