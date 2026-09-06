/**
 * scripts/setup.js
 *
 * Interactive Guided Setup Wizard for WhatsApp Kid-Photo Auto-Forwarder.
 * Guides a new user through environment initialization, face enrollment,
 * and WhatsApp chat selection.
 *
 * Usage: npm run setup
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const envExamplePath = path.join(rootDir, '.env.example');

function askQuestion(rl, query) {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve((answer || '').trim());
    });
  });
}

function ensureDirectories() {
  const dirs = [
    path.join(rootDir, 'train_photos'),
    path.join(rootDir, 'data'),
    path.join(rootDir, 'logs'),
    path.join(rootDir, 'matches_preview'),
    path.join(rootDir, 'models')
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function ensureEnvFile() {
  if (!fs.existsSync(envPath)) {
    if (fs.existsSync(envExamplePath)) {
      fs.copyFileSync(envExamplePath, envPath);
      console.log('  [✓] Created default .env configuration file from template.');
    }
  } else {
    console.log('  [✓] Existing .env configuration file found.');
  }
}

function ensureModels() {
  const downloadScript = path.join(rootDir, 'download-models.js');
  if (fs.existsSync(downloadScript)) {
    const res = spawnSync(process.execPath, [downloadScript], { stdio: 'pipe' });
    if (res.status === 0) {
      console.log('  [✓] Neural network face-recognition models ready.');
    } else {
      console.warn('  [!] Note: Model check output:', res.stderr?.toString());
    }
  }
}

async function runSetup() {
  console.log('\n================================================================');
  console.log('  WhatsApp Kid-Photo Forwarder — Setup Wizard');
  console.log('================================================================');
  console.log('  Welcome! This guided wizard will configure everything step-by-step.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    // ------------------------------------------------------------------------
    // STEP 1: Environment & Directories
    // ------------------------------------------------------------------------
    console.log('► STEP 1: Verifying environment and folders...');
    ensureDirectories();
    ensureEnvFile();
    ensureModels();
    console.log('');

    // Re-load environment variables from .env
    require('dotenv').config({ path: envPath, override: true });

    // ------------------------------------------------------------------------
    // STEP 2: Face Enrollment
    // ------------------------------------------------------------------------
    console.log('► STEP 2: Child face enrollment...');
    const refPath = path.resolve(process.env.REFERENCE_EMBEDDING_PATH || path.join(rootDir, 'data', 'child-reference.json'));
    const trainDir = path.resolve(process.env.TRAIN_PHOTOS_PATH || path.join(rootDir, 'train_photos'));

    let shouldEnroll = false;
    if (fs.existsSync(refPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(refPath, 'utf-8'));
        const count = data.photosUsed || data.totalPhotos || '?';
        console.log(`  Reference face embedding already exists (${count} photos enrolled).`);
        const ans = await askQuestion(rl, '  Do you want to re-enroll with new photos? [y/N]: ');
        if (ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes') {
          shouldEnroll = true;
        }
      } catch {
        shouldEnroll = true;
      }
    } else {
      shouldEnroll = true;
    }

    if (shouldEnroll) {
      let photos = fs.readdirSync(trainDir).filter(f => /\.(jpg|jpeg|png|webp|bmp)$/i.test(f));
      if (photos.length === 0) {
        console.log('\n  Please place 5–15 clear photos of your child into the folder:');
        console.log(`  --> ${trainDir}`);
        console.log('  Tips for best results:');
        console.log('    • Different angles (front, slight turns)');
        console.log('    • Good lighting, natural expressions');
        console.log('    • Face clearly visible (not too far away)\n');

        const proceed = await askQuestion(rl, '  Press Enter when photos are in place (or "s" to skip for now): ');
        if (proceed.toLowerCase() !== 's') {
          photos = fs.readdirSync(trainDir).filter(f => /\.(jpg|jpeg|png|webp|bmp)$/i.test(f));
        }
      }

      if (photos.length > 0) {
        console.log(`\n  Found ${photos.length} photo(s) in train_photos/. Enrolling now...\n`);
        const enrollScript = path.join(rootDir, 'enroll.js');
        const enrollResult = spawnSync(process.execPath, [enrollScript, trainDir], { stdio: 'inherit' });
        if (enrollResult.status === 0) {
          console.log('\n  [✓] Enrollment completed successfully!\n');
        } else {
          console.log('\n  [!] Enrollment did not complete. You can run `npm run enroll` later.\n');
        }
      } else {
        console.log('  Skipping enrollment for now. Remember to place photos and run `npm run enroll` later.\n');
      }
    } else {
      console.log('  [✓] Keeping existing face enrollment.\n');
    }

    // ------------------------------------------------------------------------
    // STEP 3: WhatsApp Chat Configuration
    // ------------------------------------------------------------------------
    console.log('► STEP 3: WhatsApp Chat Configuration...');
    const sourceId = process.env.SOURCE_CHAT_ID;
    const targetId = process.env.TARGET_CHAT_ID;
    const isMissing = (id) => !id || id.includes('xxxx') || id.includes('yyyy');

    let configureChats = false;
    if (isMissing(sourceId) || isMissing(targetId)) {
      configureChats = true;
    } else {
      console.log(`  Current SOURCE_CHAT_ID: ${sourceId}`);
      console.log(`  Current TARGET_CHAT_ID: ${targetId}`);
      const ans = await askQuestion(rl, '  Do you want to search and reconfigure your chats? [y/N]: ');
      if (ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes') {
        configureChats = true;
      }
    }

    if (configureChats) {
      console.log('\n  Launching WhatsApp chat selector.');
      console.log('  (If not linked, a QR code will be displayed to link WhatsApp Web)\n');
      rl.close(); // Close readline before handing over to interactiveSelectChats

      const { createClient } = require('../lib/whatsapp');
      const { interactiveSelectChats } = require('../lib/chatSelector');
      const Logger = require('../lib/logger');

      const logger = new Logger(process.env.LOG_PATH || './logs/activity.log');
      const sessionPath = path.resolve(process.env.SESSION_DATA_PATH || './.wwebjs_auth');

      await new Promise((resolve) => {
        const client = createClient({
          sessionPath,
          logger,
          onReady: async (readyClient) => {
            try {
              await interactiveSelectChats(readyClient, {
                needSource: true,
                needTarget: true,
                envPath
              });
            } catch (err) {
              console.error('\nError during chat selection:', err.message);
            } finally {
              console.log('Closing WhatsApp session...');
              try {
                await readyClient.destroy();
              } catch {}
              resolve();
            }
          }
        });

        client.initialize();
      });
    } else {
      console.log('  [✓] Chat configuration retained.\n');
      rl.close();
    }

    // ------------------------------------------------------------------------
    // SUMMARY
    // ------------------------------------------------------------------------
    console.log('\n================================================================');
    console.log('  SETUP COMPLETE!');
    console.log('================================================================');
    console.log('  Next steps:');
    console.log('  1. Check system status anytime:    npm run doctor');
    console.log('  2. Test face matching on a photo:  npm run test-match -- <path/to/photo.jpg>');
    console.log('  3. Start monitoring:               npm start  (or start.bat)');
    console.log('================================================================\n');
  } catch (err) {
    rl.close();
    console.error('\nSetup encountered an error:', err.message || err);
    process.exit(1);
  }
}

runSetup();
