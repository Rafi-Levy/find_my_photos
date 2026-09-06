# 👶 WhatsApp Kid-Photo Auto-Forwarder

> **Never miss a photo of your child again.**  
> An automatic, 100% private, on-device WhatsApp monitor that watches your child's kindergarten or school group, detects your child's face in incoming photos and videos, and automatically forwards them to you or your family group.

[![100% Private](https://img.shields.io/badge/Privacy-100%25%20On--Device%20AI-success.svg)](#-100-privacy-guarantee)
[![Zero Cloud](https://img.shields.io/badge/Cloud%20Services-None-blue.svg)](#-how-it-works)
[![Windows 1-Click](https://img.shields.io/badge/Windows-1--Click%20Ready-brightgreen.svg)](#-quick-start-3-simple-steps)

---

## 🔒 100% Privacy Guarantee

* **Zero Cloud Uploads:** All face recognition neural networks run strictly on your local PC via TensorFlow.js.
* **No External APIs:** Not a single photo, embedding, phone number, or chat log ever leaves your computer.
* **Zero Accidental Sends:** Built-in anti-echo guardrails prevent the bot from ever forwarding photos back to the kindergarten group.
* **Practice Mode by Default:** Test with total peace of mind before arming live forwarding.

---

## ✨ Features

* 📊 **Simple Web Dashboard:** View live counters for photos checked, matches found, and forwarded media.
* 📱 **Easy WhatsApp Pairing:** Scan a QR code right on your screen once—stays permanently linked.
* 📸 **Drag & Drop Face Training:** Add 5–15 photos of your child and train face recognition with a single click.
* 👨‍👩‍👧‍👦 **Multi-Child Profiles:** Enroll siblings (e.g. Liam & Maya) so photos of either child get detected.
* 🧪 **Test Recognition Simulator:** Drop any photo from your phone or family album to test accuracy on the spot before going live.
* ⚙️ **Plain English Settings:** Pick your kindergarten group and recipient from friendly dropdowns—no technical IDs or code.
* 🖥️ **Desktop Shortcut:** 1-click desktop icon so you can launch the app directly from your Windows Desktop.

---

## 🚀 Quick Start (3 Simple Steps)

### Step 1: Download the App
1. Click the green **`<> Code`** button at the top of this GitHub page and click **`Download ZIP`**.
2. Unzip the downloaded folder anywhere on your computer (e.g. Desktop or Documents).

### Step 2: Double-Click `start.bat`
* Simply double-click **`start.bat`** inside the folder!
* The app automatically prepares everything and **opens your web browser** to the dashboard at:
  ```
  http://localhost:4848
  ```
*(Note: If your computer does not have Node.js installed yet, the launcher will offer to install it for you automatically).*

### Step 3: Connect & Setup in Your Browser
1. **Link WhatsApp:** Point your phone camera at the QR code on your screen (**WhatsApp → Settings → Linked Devices → Link a Device**).
2. **Train Face:** Go to the **Child Photos & Training** tab, drag in 5–15 photos of your child, and click **🚀 Train Child Recognition**.
3. **Select Chats:** Go to the **Settings** tab, choose your kindergarten group to watch and where you want photos sent, then click **💾 Save Settings**.

**That's it!** Whenever you are in front of your computer, just open the app and let it run in the background.

---

## 🖥️ Optional: Add 1-Click Desktop Shortcut

To launch the forwarder without opening the folder every time:
* Double-click **`create-desktop-shortcut.bat`** inside the folder (or click **🖥️ Desktop Shortcut** inside the web dashboard).
* A **"Kid Photo Forwarder"** shortcut will appear directly on your Windows Desktop!

---

## 🧪 Test Recognition Simulator

Wondering if the AI will recognize tricky angles or group photos?
1. Open the **Child Photos & Training** tab in the app.
2. Scroll to the **🧪 Test Recognition Simulator**.
3. Drop any photo from your family album or phone.
4. The simulator will immediately analyze all faces and tell you:
   * Confidence percentage (e.g. `⭐ 95% Match`).
   * Whether this photo would be forwarded in live mode.
   * Actionable tips to calibrate accuracy.

---

## ⚙️ Settings Explained

| Setting | What it does | Recommended |
|:---|:---|:---|
| **Kindergarten Group** | The WhatsApp group to monitor for photos. | Select your class group |
| **Where to Forward** | The recipient contact or family group. | Your personal chat or spouse |
| **Practice Mode** | Saves matches to your computer for review without sending messages. | Use when first testing |
| **Live Forwarding** | Automatically sends matched photos and videos right away. | Turn on when satisfied |
| **Recognition Strictness** | **Strict:** Zero false alarms.<br>**Balanced:** Ideal everyday balance.<br>**Relaxed:** Catches difficult angles. | Balanced (0.50) |

---

## ❓ Frequently Asked Questions (FAQ)

#### How long does it stay connected?
* Thanks to WhatsApp's official Multi-Device protocol, your session stays linked permanently. You do **not** need to scan the QR code every day.
* As long as your primary phone connects to WhatsApp at least once every 14 days, you will never be logged out.

#### Can it accidentally send messages back to the kindergarten group?
* **No.** The app includes a strict, non-bypassable **Anti-Echo Safety Guardrail**. If the target chat is set to the source group, messages are automatically blocked at the engine level.

#### Can I close the browser tab?
* Yes! The web browser is just the dashboard interface. The forwarder continues running in the background until you close the black launcher window.

#### What formats are supported?
* Photos: JPG, PNG, WEBP, BMP.
* Videos: MP4, MOV (the app extracts frames and checks each frame for your child's face).

---

## 🛠️ Advanced Developer Usage (CLI Mode)

If you prefer using the command line:

```bash
# Clone the repository
git clone https://github.com/your-username/whatsapp-kid-photo-forwarder.git
cd whatsapp-kid-photo-forwarder

# Install dependencies & prepare face models
npm install

# Launch Web UI
npm start

# Or run terminal CLI daemon
npm run cli

# Diagnostic health check
npm run doctor

# Automated safety test suite
npm run test-safety
```

---

## 📄 License

Distributed under the MIT License. 100% Free and Open Source.
