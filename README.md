# WhatsApp Kid-Photo Auto-Forwarder

A **local-only** desktop tool that monitors a WhatsApp group (e.g. your child's kindergarten group), detects photos and videos containing **your child's face**, and automatically forwards them to another chat.

**Everything runs on your machine** — no cloud services, no external APIs, no data leaves your laptop.

---

## How It Works

1. Connects to your WhatsApp account via WhatsApp Web protocol
2. Watches a specific source group for incoming photos/videos
3. Runs local face detection + recognition against a pre-enrolled reference of your child
4. Forwards matching media (with original caption) to your target chat
5. Ignores everything else — text messages, stickers, voice notes, documents

---

## Prerequisites

- **Node.js 18+** (LTS recommended) — [download here](https://nodejs.org/)
  - Check your version: `node --version`
- **WhatsApp** account with an active phone number
- **5–15 clear photos** of your child (for enrollment)

> **Note:** ffmpeg is bundled automatically via npm — no separate install needed.
> Face recognition runs entirely in JavaScript (no native C++ compilation required).

---

## Quick Start

### 1. Install dependencies

```bash
cd photo_forward
npm install
```

> First install may take a minute or two to download all packages.

### 2. Set up face recognition models

```bash
npm run download-models
```

This copies the neural network weights (~12 MB) from the installed npm package into the `models/` folder (one-time, instant).

### 3. Create your configuration

```bash
copy .env.example .env
```

(On macOS/Linux: `cp .env.example .env`)

Leave the chat IDs blank for now — you'll fill them in after step 5.

### 4. Enroll your child's face

Copy 5–15 clear photos of your child into the `train_photos/` folder:
- Different angles (front, slight turns)
- Different lighting conditions
- Different expressions (smiling, neutral, laughing)
- Face clearly visible (not too far, not too close)

Then simply run:

```bash
npm run enroll
```

*(Or specify a custom folder: `npm run enroll -- ./custom-folder`)*

You should see output like:

```
Found 10 image(s) in C:\Users\...\photos-of-my-kid
Processing each photo for face detection...

  photo1.jpg                              ✓ face detected
  photo2.jpg                              ✓ face detected
  photo3.jpg                              ✗ no face detected
  ...

✓ Reference embedding saved to: ./data/child-reference.json
  Based on 8 face detections from 10 photos.
```

The script requires at least **3 successful face detections**. If too many fail, try clearer/brighter photos.

> **What's stored:** Only a numeric embedding (128 numbers) — not the photos themselves.

### 5. Find your WhatsApp chat IDs

You can search your chats interactively by name (e.g. searching your kindergarten name or contact name):

```bash
npm run search-chats
```

This queries WhatsApp Web's internal IndexedDB (`chat`, `contact`, and `group-metadata`), displays matching chats, and automatically saves your selected `SOURCE_CHAT_ID` and `TARGET_CHAT_ID` directly into your `.env` file!

Alternatively, to print all chats without searching:

```bash
npm run list-chats
```

On first run, a QR code will appear in your terminal. Scan it with WhatsApp:
1. Open WhatsApp on your phone
2. Go to **Settings → Linked Devices → Link a Device**
3. Scan the terminal QR code

After authentication, you'll see a list like:

```
══════════════════════════════════════════════════════════════════════════════════
  YOUR WHATSAPP CHATS
══════════════════════════════════════════════════════════════════════════════════

  ── GROUPS (12) ───────────────────────────────────────────────────────────────
  [GROUP]   Kindergarten Parents                     120363028374829@g.us
  [GROUP]   Family                                   120363019283746@g.us
  ...

  ── CONTACTS (34) ─────────────────────────────────────────────────────────────
  [PERSON]  Partner                                  123456789012@c.us
  ...
```

Copy the IDs you need into your `.env` file:

```env
SOURCE_CHAT_ID=120363028374829@g.us    # The kindergarten group
TARGET_CHAT_ID=123456789012@c.us       # Where to send matches (partner, family group, etc.)
```

### 6. Start monitoring

```bash
npm start
```

Or on Windows, double-click `start.bat`.

The forwarder will:
- Connect using your saved session (no QR scan needed on subsequent runs)
- Load face recognition models
- Begin monitoring the source group
- Stay running until you press **Ctrl+C**

```
  ╔══════════════════════════════════════════╗
  ║  WhatsApp Kid-Photo Auto-Forwarder       ║
  ║  Local face recognition • No cloud       ║
  ╚══════════════════════════════════════════╝

  Watching:    120363028374829@g.us
  Forwarding:  123456789012@c.us
  Threshold:   0.5
  Video frames: 5

  Press Ctrl+C to stop.
```

---

## Configuration Reference

Edit `.env` to customize:

| Setting | Default | Description |
|:---|:---|:---|
| `SOURCE_CHAT_ID` | *(required)* | Group to watch (`@g.us`) |
| `TARGET_CHAT_ID` | *(required)* | Where to forward matches (`@g.us` or `@c.us`) |
| `ENABLE_FORWARDING` | `false` | **Safety Switch**: When `false` (default), forwarder runs in **SAFE DRY-RUN** mode (zero WhatsApp messages sent; matches saved locally). Set to `true` only when ready! |
| `ALLOW_GROUP_FORWARDING` | `false` | **Group Guard**: Set `true` only if `TARGET_CHAT_ID` is intentionally a group (`@g.us`). Prevents accidental group blasts. |
| `MATCH_THRESHOLD` | `0.5` | Euclidean distance cutoff. Lower = stricter. Range: 0.3–0.7. Try `0.55`–`0.6` if missing matches. |
| `VIDEO_FRAMES_TO_CHECK` | `5` | Number of evenly-spaced frames to sample from videos |
| `MATCH_PREVIEW_PATH` | `./matches_preview` | Local directory where matched media & JSON audit logs are saved |
| `REFERENCE_EMBEDDING_PATH` | `./data/child-reference.json` | Path to enrolled face embedding |
| `SESSION_DATA_PATH` | `./.wwebjs_auth` | WhatsApp session storage |
| `LOG_PATH` | `./logs/activity.log` | Activity log file |
| `MODELS_PATH` | `./models` | Face-api model weights directory |

---

## Safety Controls & Verification

The forwarder includes **100% zero-mistake safety guardrails**:

1. **Anti-Echo Protection**: If `TARGET_CHAT_ID` is accidentally set to the same group as `SOURCE_CHAT_ID`, the forwarder immediately aborts on startup and refuses to run.
2. **Default Dry-Run Mode**: By default (`ENABLE_FORWARDING=false`), the bot runs in **Safe Mode**. It monitors messages, detects faces, and saves matching photos/videos into `./matches_preview/` with match distance scores and metadata, but **never sends any message over WhatsApp**.
3. **Group Target Lock**: If you want to forward to a group instead of a 1:1 contact, you must explicitly configure `ALLOW_GROUP_FORWARDING=true`.
4. **Safety Verification Suite**: Run automated checks before launching:
   ```bash
   npm run test-safety
   ```
   Runs 6 automated unit tests verifying that all block conditions and dry-run mechanisms function as expected.

### Tuning the match threshold

- **0.45–0.50**: Strict — fewer false positives, but may miss photos with unusual lighting/angles
- **0.50–0.55**: Balanced — good starting point
- **0.55–0.60**: Lenient — catches more matches, slight risk of false positives
- **0.60+**: Very lenient — may forward photos of other children who look similar

Start with the default (`0.5`) and increase if you notice missing matches.

---

## Re-authenticating WhatsApp

If your session expires (e.g. after being logged out from your phone, or after ~14 days of inactivity):

1. Stop the running process (`Ctrl+C`)
2. Delete the session folder: `rmdir /s .wwebjs_auth` (Windows) or `rm -rf .wwebjs_auth` (Mac/Linux)
3. Start again: `npm start`
4. Scan the new QR code with your phone

---

## Re-enrolling

If you want to update the reference embedding (e.g. your child has grown, or you have better photos):

```bash
npm run enroll -- ./path/to/newer-photos
```

This overwrites the previous embedding. No need to restart — the new embedding will be loaded on the next `npm start`.

---

## Logs

Activity is logged to `logs/activity.log` in JSON-lines format:

```json
{"timestamp":"2026-09-06T10:30:00.000Z","level":"INFO","message":"MATCH — image forwarded.","msgId":"3EB0...","mediaType":"image","distance":"0.3842","facesChecked":3}
```

**No media content or face images are ever written to the log** — metadata only.

---

## Troubleshooting

### "Hi, looks like you are running TensorFlow.js in Node.js…"
This is an informational message from TF.js, not an error. The forwarder uses the pure-JavaScript TF.js backend intentionally — it works on all Node versions without native compilation. You can safely ignore this message.

### "Could not download media (may have expired)"
WhatsApp Web sometimes can't access older media if it was never cached locally. This is normal — it only affects messages sent before the forwarder was running.

### Videos aren't matching even though my child is visible
- Increase `VIDEO_FRAMES_TO_CHECK` (e.g. to 10) for finer sampling
- Increase `MATCH_THRESHOLD` (e.g. to 0.55 or 0.6) for more lenient matching
- Ensure the reference photos include side profiles if the child is often filmed from the side

### Process crashes after laptop sleep
The forwarder includes automatic reconnection logic. If it still fails, restart with `npm start` — the saved session means you won't need to re-scan the QR code.

### QR code doesn't appear / auth fails
If using `whatsapp-web.js` from npm and WhatsApp has updated its web client, you may need the latest version:
```bash
npm install github:wwebjs/whatsapp-web.js
```

### First face detection is slow
The first image processed after startup takes 10–30 seconds (model warm-up with pure-JS backend). Subsequent images are processed much faster (~2–5 seconds each).

---

## Optional: Auto-Start on Boot

This project does **not** include any auto-start mechanism. If you want it to start automatically:

- **Windows**: Create a Task Scheduler task that runs `node index.js` in this directory on login
  - Or add a shortcut to `start.bat` in your Startup folder (`shell:startup`)
- **macOS**: Create a `launchd` plist in `~/Library/LaunchAgents/`
- **Linux**: Create a `systemd` user service in `~/.config/systemd/user/`

You can also use [PM2](https://pm2.keymetrics.io/) for process management with auto-restart:
```bash
npm install -g pm2
pm2 start index.js --name kid-forwarder
pm2 save
pm2 startup
```

---

## Privacy & Ethics Notice

> **Important:** This tool processes photos and videos from a group that contains other people's children. While no faces or images of other children are stored (only your child's numeric embedding is persisted, and all other face data is processed transiently in memory), you should:
>
> 1. **Inform the other parents and/or the teacher** that you're filtering and re-sharing media from the group
> 2. Be transparent about what the tool does (even though it's local-only)
> 3. Respect any parent who objects — their children's images are being processed, even if only transiently
>
> **What is stored locally:**
> - Your child's face embedding (128 numbers in `data/child-reference.json`) — not a photo
> - WhatsApp session tokens (in `.wwebjs_auth/`)
> - Message ID log for deduplication (in `data/processed-messages.json`)
> - Activity metadata log (in `logs/activity.log`)
>
> **What is NOT stored:**
> - Photos or videos of any child
> - Face descriptors of other children
> - Message content beyond metadata
>
> The `.gitignore` excludes all sensitive directories (`data/`, `.wwebjs_auth/`, `logs/`, `models/`) from version control.

---

## Tech Stack

| Component | Package | Purpose |
|:---|:---|:---|
| WhatsApp | `whatsapp-web.js` | WhatsApp Web protocol via Puppeteer |
| Face recognition | `@vladmandic/face-api` | SSD MobileNet + landmarks + recognition |
| ML backend | `@tensorflow/tfjs` | Pure-JS tensor computation (no native build) |
| Image decoding | `sharp` | Fast image decode to raw RGB pixels |
| Video frames | `fluent-ffmpeg` | FFmpeg wrapper for frame extraction |
| FFmpeg binary | `@ffmpeg-installer/ffmpeg` | Portable bundled ffmpeg binary |

---

## Project Structure

```
photo_forward/
├── index.js                 # Main monitoring loop
├── enroll.js                # Face enrollment CLI
├── list-chats.js            # Chat ID discovery CLI
├── download-models.js       # One-time model setup (copies from npm package)
├── start.bat                # Windows double-click launcher
├── lib/
│   ├── whatsapp.js          # WhatsApp client setup + reconnection
│   ├── faceMatch.js         # Face detection, recognition, matching
│   ├── videoFrames.js       # FFmpeg frame extraction
│   ├── dedupe.js            # Message deduplication tracker
│   └── logger.js            # JSON-lines file logger
├── models/                  # Face-api model weights (copied from npm)
├── data/                    # Reference embedding + deduplication state
├── logs/                    # Activity logs
├── .env                     # Your configuration
├── .env.example             # Configuration template
├── .gitignore               # Excludes sensitive data from VCS
├── package.json             # Dependencies and scripts
└── README.md                # This file
```

---

## License

Personal use only. Not affiliated with WhatsApp or Meta.
