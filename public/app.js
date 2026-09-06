// public/app.js — Frontend Application Logic

document.addEventListener('DOMContentLoaded', () => {
  // State variables
  let currentStatus = null;
  let currentStats = null;
  let availableChats = [];
  let isTraining = false;

  // DOM Elements
  const elements = {
    // Tabs
    tabButtons: document.querySelectorAll('.tab-btn'),
    tabPanes: document.querySelectorAll('.tab-pane'),
    trainBadge: document.getElementById('train-badge'),
    
    // Header & Status
    btnDesktopShortcut: document.getElementById('btn-desktop-shortcut'),
    waStatusPill: document.getElementById('wa-status-pill'),
    waStatusText: document.getElementById('wa-status-text'),
    btnLogout: document.getElementById('btn-logout'),
    monitoringToggle: document.getElementById('monitoring-toggle'),
    monitoringLabel: document.getElementById('monitoring-label'),

    // Dashboard
    qrBanner: document.getElementById('qr-banner'),
    qrImg: document.getElementById('qr-img'),
    qrSpinner: document.getElementById('qr-spinner'),
    setupCallout: document.getElementById('setup-callout'),
    setupCalloutTitle: document.getElementById('setup-callout-title'),
    setupCalloutDesc: document.getElementById('setup-callout-desc'),
    calloutTrainBtn: document.getElementById('callout-train-btn'),
    calloutSettingsBtn: document.getElementById('callout-settings-btn'),
    statChecked: document.getElementById('stat-checked'),
    statMatched: document.getElementById('stat-matched'),
    statForwarded: document.getElementById('stat-forwarded'),
    statForwardedSub: document.getElementById('stat-forwarded-sub'),
    statTime: document.getElementById('stat-time'),
    statChildStatus: document.getElementById('stat-child-status'),
    matchesGallery: document.getElementById('matches-gallery'),
    logStream: document.getElementById('log-stream'),
    btnClearStats: document.getElementById('btn-clear-stats'),
    btnOpenPreviewFolder: document.getElementById('btn-open-preview-folder'),

    // Training & Profiles
    inputChildName: document.getElementById('input-child-name'),
    enrolledProfilesContainer: document.getElementById('enrolled-profiles-container'),
    enrolledProfilesList: document.getElementById('enrolled-profiles-list'),
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    btnBrowseFiles: document.getElementById('btn-browse-files'),
    trainPhotosGrid: document.getElementById('train-photos-grid'),
    photoCount: document.getElementById('photo-count'),
    btnRefreshPhotos: document.getElementById('btn-refresh-photos'),
    btnRunTrain: document.getElementById('btn-run-train'),
    trainStatusText: document.getElementById('train-status-text'),
    trainStatusSub: document.getElementById('train-status-sub'),
    trainStatusBadge: document.getElementById('training-status-badge'),
    trainProgressBox: document.getElementById('train-progress-box'),
    trainProgressFill: document.getElementById('train-progress-fill'),
    trainProgressDetails: document.getElementById('train-progress-details'),
    trainLogList: document.getElementById('train-log-list'),

    // Test Simulator Playground
    testDropZone: document.getElementById('test-drop-zone'),
    testFileInput: document.getElementById('test-file-input'),
    btnBrowseTestFile: document.getElementById('btn-browse-test-file'),
    testResultBox: document.getElementById('test-result-box'),
    testResultBadge: document.getElementById('test-result-badge'),
    testResultFaces: document.getElementById('test-result-faces'),
    testResultScore: document.getElementById('test-result-score'),
    testResultVerdict: document.getElementById('test-result-verdict'),
    testResultAdvice: document.getElementById('test-result-advice'),

    // Settings
    settingsForm: document.getElementById('settings-form'),
    selectSource: document.getElementById('select-source'),
    selectTarget: document.getElementById('select-target'),
    btnRefreshChats: document.getElementById('btn-refresh-chats'),
    sourceIdDisplay: document.getElementById('source-id-display'),
    targetIdDisplay: document.getElementById('target-id-display'),
    modeDryRun: document.getElementById('mode-dry-run'),
    modeLive: document.getElementById('mode-live'),
    sliderThreshold: document.getElementById('slider-threshold'),
    sliderDesc: document.getElementById('slider-desc'),
    selectVideoFrames: document.getElementById('select-video-frames'),
    btnSaveSettings: document.getElementById('btn-save-settings'),
    saveFeedback: document.getElementById('save-feedback'),

    // Toasts
    toastContainer: document.getElementById('toast-container')
  };

  // =========================================================================
  // Tab Navigation
  // =========================================================================
  function switchTab(tabId) {
    elements.tabButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    elements.tabPanes.forEach(pane => {
      pane.classList.toggle('active', pane.id === tabId);
    });

    if (tabId === 'tab-train') {
      loadTrainingPhotos();
    } else if (tabId === 'tab-settings') {
      loadSettings();
      loadChats();
    }
  }

  elements.tabButtons.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  elements.calloutTrainBtn?.addEventListener('click', () => switchTab('tab-train'));
  elements.calloutSettingsBtn?.addEventListener('click', () => switchTab('tab-settings'));

  // =========================================================================
  // Toast Notifications
  // =========================================================================
  function showToast(message, duration = 3500) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    elements.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // =========================================================================
  // SSE Event Stream
  // =========================================================================
  function initEventSource() {
    const evtSource = new EventSource('/api/events');

    evtSource.addEventListener('status', (e) => {
      try {
        const data = JSON.parse(e.data);
        renderStatus(data);
      } catch {}
    });

    evtSource.addEventListener('stats', (e) => {
      try {
        const data = JSON.parse(e.data);
        renderStats(data);
      } catch {}
    });

    evtSource.addEventListener('log', (e) => {
      try {
        const entry = JSON.parse(e.data);
        appendLogEntry(entry);
      } catch {}
    });

    evtSource.addEventListener('match', (e) => {
      try {
        const match = JSON.parse(e.data);
        showToast(`⭐ Child recognized in incoming ${match.mediaType}!`);
        fetchStats();
      } catch {}
    });

    evtSource.addEventListener('qr', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.qrDataUrl) {
          elements.qrImg.src = data.qrDataUrl;
          elements.qrImg.style.display = 'block';
          elements.qrSpinner.style.display = 'none';
        }
      } catch {}
    });

    evtSource.addEventListener('train_progress', (e) => {
      try {
        const progress = JSON.parse(e.data);
        handleTrainProgress(progress);
      } catch {}
    });

    evtSource.onerror = () => {
      // Reconnection happens automatically in browsers
    };
  }

  // =========================================================================
  // Render Status & Header
  // =========================================================================
  function renderStatus(status) {
    currentStatus = status;

    // Monitoring Toggle
    elements.monitoringToggle.checked = Boolean(status.monitoringActive);
    elements.monitoringLabel.textContent = status.monitoringActive ? 'Monitoring Active' : 'Monitoring Paused';

    // WhatsApp Connection Badge
    elements.waStatusPill.className = 'status-pill';
    elements.btnLogout.style.display = 'none';

    if (status.state === 'READY') {
      elements.waStatusPill.classList.add('status-connected');
      const name = status.userInfo?.pushname || status.userInfo?.wid || 'WhatsApp';
      elements.waStatusText.textContent = `Connected (${name})`;
      elements.btnLogout.style.display = 'inline-block';
      elements.qrBanner.style.display = 'none';
    } else if (status.state === 'WAITING_FOR_QR') {
      elements.waStatusPill.classList.add('status-connecting');
      elements.waStatusText.textContent = 'Scan QR Code';
      elements.qrBanner.style.display = 'block';
      if (status.qrDataUrl) {
        elements.qrImg.src = status.qrDataUrl;
        elements.qrImg.style.display = 'block';
        elements.qrSpinner.style.display = 'none';
      } else {
        elements.qrImg.style.display = 'none';
        elements.qrSpinner.style.display = 'block';
      }
    } else if (status.state === 'CONNECTING') {
      elements.waStatusPill.classList.add('status-connecting');
      elements.waStatusText.textContent = 'Connecting WhatsApp...';
      elements.qrBanner.style.display = 'none';
    } else {
      elements.waStatusPill.classList.add('status-disconnected');
      elements.waStatusText.textContent = 'WhatsApp Disconnected';
      elements.qrBanner.style.display = 'none';
    }

    // Child Enrollment Status
    if (status.enrolled) {
      elements.trainBadge.style.display = 'none';
      elements.trainingStatusBadge.className = 'badge badge-success';
      elements.trainingStatusBadge.textContent = 'Trained & Ready';

      const children = status.referenceInfo?.children || [];
      const names = children.map(c => c.name).join(', ') || 'Active';
      elements.statChildStatus.textContent = `Face Profile: ${names}`;

      if (elements.enrolledProfilesContainer && children.length > 0) {
        elements.enrolledProfilesContainer.style.display = 'block';
        elements.enrolledProfilesList.innerHTML = children.map(c => `
          <span class="profile-pill">
            👶 <strong>${escapeHtml(c.name)}</strong> (${c.photosUsed} photos)
            <button class="profile-delete" title="Remove profile" data-name="${escapeHtml(c.name)}">✕</button>
          </span>
        `).join('');

        elements.enrolledProfilesList.querySelectorAll('.profile-delete').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const name = btn.dataset.name;
            if (confirm(`Remove face profile for "${name}"?`)) {
              await fetch(`/api/train/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
              showToast(`Removed profile for ${name}`);
              fetchInitialStatus();
            }
          });
        });
      }
    } else {
      elements.trainBadge.style.display = 'inline-block';
      elements.trainingStatusBadge.className = 'badge badge-warning';
      elements.trainingStatusBadge.textContent = 'Training Required';
      elements.statChildStatus.textContent = 'Face Profile: Missing';
      if (elements.enrolledProfilesContainer) {
        elements.enrolledProfilesContainer.style.display = 'none';
      }
    }

    // Quick Setup Callout
    const needsTraining = !status.enrolled;
    const needsSource = !status.config.sourceChatId;
    const needsTarget = !status.config.targetChatId;

    if (needsTraining || needsSource || needsTarget) {
      elements.setupCallout.style.display = 'flex';
      const steps = [];
      if (needsTraining) steps.push('Train your child\'s face');
      if (needsSource) steps.push('Select the WhatsApp group to watch');
      if (needsTarget) steps.push('Select where to send matched photos');
      elements.setupCalloutDesc.textContent = `Next steps: ${steps.join(' • ')}`;
    } else {
      elements.setupCallout.style.display = 'none';
    }

    // Forwarding sublabel
    if (status.config.enableForwarding) {
      elements.statForwardedSub.textContent = 'Live Forwarding Active 🚀';
      elements.statForwardedSub.style.color = '#10b981';
    } else {
      elements.statForwardedSub.textContent = 'Review Mode (Safe) 🛡️';
      elements.statForwardedSub.style.color = '#64748b';
    }
  }

  // =========================================================================
  // Render Stats & Recent Matches
  // =========================================================================
  function renderStats(stats) {
    currentStats = stats;
    elements.statChecked.textContent = stats.totalChecked || 0;
    elements.statMatched.textContent = stats.totalMatches || 0;
    elements.statForwarded.textContent = stats.totalForwarded || 0;

    if (stats.lastActivity) {
      const d = new Date(stats.lastActivity);
      elements.statTime.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      elements.statTime.textContent = 'None yet';
    }

    renderRecentMatches(stats.recentMatches || []);
  }

  function renderRecentMatches(matches) {
    if (matches.length === 0) {
      elements.matchesGallery.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🖼️</div>
          <p>No matches yet</p>
          <span>When photos or videos of your child arrive in the watched group, they will appear here.</span>
        </div>
      `;
      return;
    }

    elements.matchesGallery.innerHTML = matches.map(m => {
      const dateStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const confidenceStr = m.confidence ? `${m.confidence}% Match` : 'Matched';
      const badgeClass = m.forwarded ? 'badge-forwarded' : 'badge-saved';
      const badgeText = m.forwarded ? 'Forwarded' : 'Saved';
      const isVideo = m.mediaType === 'video';

      return `
        <div class="match-item">
          <div class="match-thumb-wrapper">
            ${isVideo 
              ? `<video class="match-thumb" src="${m.previewUrl}" preload="metadata" muted></video>`
              : `<img class="match-thumb" src="${m.previewUrl || ''}" alt="Match" loading="lazy" />`
            }
            <span class="match-badge ${badgeClass}">${badgeText}</span>
          </div>
          <div class="match-meta">
            <div class="match-confidence">${confidenceStr} ${isVideo ? '📹' : '📷'}</div>
            <div class="match-time">${dateStr}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // =========================================================================
  // Activity Log Stream
  // =========================================================================
  function appendLogEntry(entry) {
    const div = document.createElement('div');
    const levelClass = entry.level === 'error' ? 'log-error' : entry.level === 'warn' ? 'log-warn' : 'log-info';
    div.className = `log-entry ${levelClass}`;

    const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--:--:--';
    div.innerHTML = `<span class="log-time">${time}</span><span class="log-text">${escapeHtml(entry.message)}</span>`;

    elements.logStream.prepend(div);
    while (elements.logStream.children.length > 80) {
      elements.logStream.lastElementChild.remove();
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // =========================================================================
  // Monitoring Toggle & Logout
  // =========================================================================
  elements.monitoringToggle.addEventListener('change', async () => {
    const active = elements.monitoringToggle.checked;
    elements.monitoringLabel.textContent = active ? 'Monitoring Active' : 'Monitoring Paused';
    try {
      const res = await fetch('/api/monitoring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active })
      });
      const data = await res.json();
      if (data.success) {
        showToast(active ? 'Monitoring activated' : 'Monitoring paused');
      }
    } catch {
      showToast('Error changing monitoring state');
    }
  });

  elements.btnLogout.addEventListener('click', async () => {
    if (confirm('Disconnect WhatsApp? You will need to scan a QR code to link again.')) {
      try {
        await fetch('/api/logout', { method: 'POST' });
        showToast('Logged out. Scan new QR code.');
      } catch {
        showToast('Logout request failed');
      }
    }
  });

  elements.btnClearStats.addEventListener('click', async () => {
    if (confirm('Reset media counters to zero?')) {
      try {
        const res = await fetch('/api/stats/reset', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          renderStats(data.stats);
          showToast('Counters reset');
        }
      } catch {
        showToast('Failed to reset counters');
      }
    }
  });

  // =========================================================================
  // Tab 2: Photos & Training
  // =========================================================================
  async function loadTrainingPhotos() {
    try {
      const res = await fetch('/api/train/photos');
      const data = await res.json();
      renderTrainingPhotos(data.photos || []);
    } catch (err) {
      console.error('Failed to load training photos:', err);
    }
  }

  function renderTrainingPhotos(photos) {
    elements.photoCount.textContent = photos.length;
    if (photos.length === 0) {
      elements.trainPhotosGrid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1; padding: 20px;">
          <p>No photos added yet</p>
          <span>Drag and drop 5–15 photos of your child above to start.</span>
        </div>
      `;
      return;
    }

    elements.trainPhotosGrid.innerHTML = photos.map(p => `
      <div class="photo-card" data-name="${p.name}">
        <img src="${p.url}" alt="${p.name}" loading="lazy" />
        <button class="btn-delete-photo" title="Delete this photo" data-name="${p.name}">✕</button>
      </div>
    `).join('');

    // Attach delete listeners
    elements.trainPhotosGrid.querySelectorAll('.btn-delete-photo').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = btn.dataset.name;
        if (confirm(`Remove photo "${name}"?`)) {
          try {
            const res = await fetch(`/api/train/photos/${encodeURIComponent(name)}`, { method: 'DELETE' });
            const data = await res.json();
            renderTrainingPhotos(data.all || []);
            showToast('Photo removed');
          } catch {
            showToast('Failed to delete photo');
          }
        }
      });
    });
  }

  // File Upload Handlers
  elements.btnBrowseFiles.addEventListener('click', () => {
    elements.fileInput.click();
  });

  elements.fileInput.addEventListener('change', () => {
    if (elements.fileInput.files?.length) {
      uploadFiles(elements.fileInput.files);
    }
  });

  // Drag and Drop
  elements.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.dropZone.classList.add('dragover');
  });

  elements.dropZone.addEventListener('dragleave', () => {
    elements.dropZone.classList.remove('dragover');
  });

  elements.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.dropZone.classList.remove('dragover');
    if (e.dataTransfer.files?.length) {
      uploadFiles(e.dataTransfer.files);
    }
  });

  async function uploadFiles(fileList) {
    const formData = new FormData();
    for (let i = 0; i < fileList.length; i++) {
      formData.append('photos', fileList[i]);
    }

    showToast(`Uploading ${fileList.length} photo(s)...`);
    try {
      const res = await fetch('/api/train/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        renderTrainingPhotos(data.all || []);
        showToast(`Successfully added ${data.uploaded?.length || fileList.length} photos!`);
      } else {
        showToast('Upload error: ' + (data.error || 'Unknown'));
      }
    } catch (err) {
      showToast('Error uploading photos');
    } finally {
      elements.fileInput.value = '';
    }
  }

  elements.btnRefreshPhotos.addEventListener('click', loadTrainingPhotos);

  // Desktop Shortcut Handler
  elements.btnDesktopShortcut?.addEventListener('click', async () => {
    try {
      showToast('Creating desktop shortcut...');
      const res = await fetch('/api/shortcut', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast('✓ Shortcut created on your Desktop!');
      } else {
        showToast('Could not create shortcut: ' + (data.error || 'Unknown error'));
      }
    } catch {
      showToast('Error creating desktop shortcut');
    }
  });

  // Run Training
  elements.btnRunTrain.addEventListener('click', async () => {
    if (isTraining) return;
    isTraining = true;

    const childName = elements.inputChildName ? elements.inputChildName.value.trim() || 'My Child' : 'My Child';

    elements.btnRunTrain.disabled = true;
    elements.btnRunTrain.innerHTML = '<span>⏳ Training in progress...</span>';
    elements.trainProgressBox.style.display = 'block';
    elements.trainProgressFill.style.width = '5%';
    elements.trainProgressDetails.textContent = `Initializing neural network for ${childName}...`;
    elements.trainLogList.innerHTML = '';

    try {
      const res = await fetch('/api/train/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ childName })
      });
      const data = await res.json();

      if (data.success) {
        elements.trainProgressFill.style.width = '100%';
        elements.trainProgressDetails.textContent = `🎉 Training successful! ${data.result.photosUsed} photos recognized for "${childName}".`;
        showToast(`Face profile for ${childName} trained successfully!`);
        fetchInitialStatus();
      } else {
        elements.trainProgressDetails.textContent = `⚠ Training failed: ${data.error}`;
        showToast(data.error || 'Training failed');
      }
    } catch (err) {
      elements.trainProgressDetails.textContent = `⚠ Training error: ${err.message}`;
      showToast('Training error');
    } finally {
      isTraining = false;
      elements.btnRunTrain.disabled = false;
      elements.btnRunTrain.innerHTML = '<span>🚀 Train Child Recognition</span>';
    }
  });

  function handleTrainProgress(progress) {
    const pct = Math.round((progress.index / progress.total) * 100);
    elements.trainProgressFill.style.width = `${pct}%`;
    elements.trainProgressDetails.textContent = `Processing photo ${progress.index} of ${progress.total} (${pct}%)...`;

    const item = document.createElement('div');
    item.className = 'train-log-item ' + (progress.detected ? 'train-log-success' : 'train-log-fail');
    item.textContent = `${progress.filename}: ${progress.detected ? 'Face detected ✓' : 'No face found ✗'}`;
    elements.trainLogList.appendChild(item);
    elements.trainLogList.scrollTop = elements.trainLogList.scrollHeight;
  }

  // =========================================================================
  // Test Recognition Simulator (Playground)
  // =========================================================================
  elements.btnBrowseTestFile?.addEventListener('click', () => {
    elements.testFileInput.click();
  });

  elements.testFileInput?.addEventListener('change', () => {
    if (elements.testFileInput.files?.length) {
      runTestPhoto(elements.testFileInput.files[0]);
    }
  });

  elements.testDropZone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.testDropZone.classList.add('dragover');
  });

  elements.testDropZone?.addEventListener('dragleave', () => {
    elements.testDropZone.classList.remove('dragover');
  });

  elements.testDropZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.testDropZone.classList.remove('dragover');
    if (e.dataTransfer.files?.length) {
      runTestPhoto(e.dataTransfer.files[0]);
    }
  });

  async function runTestPhoto(file) {
    const formData = new FormData();
    formData.append('test_photo', file);

    elements.testResultBox.style.display = 'block';
    elements.testResultBadge.className = 'badge';
    elements.testResultBadge.textContent = 'Testing...';
    elements.testResultScore.textContent = 'Analyzing faces...';
    elements.testResultScore.style.color = 'var(--text-main)';
    elements.testResultVerdict.textContent = '';
    elements.testResultAdvice.textContent = '';

    try {
      const res = await fetch('/api/train/test', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();

      if (!data.success) {
        elements.testResultBadge.className = 'badge badge-match-no';
        elements.testResultBadge.textContent = 'Test Failed';
        elements.testResultScore.textContent = data.error || 'Error analyzing photo';
        return;
      }

      const r = data.result;
      elements.testResultFaces.textContent = `${r.facesCount} face(s) found in photo`;

      if (r.matched) {
        elements.testResultBadge.className = 'badge badge-match-yes';
        elements.testResultBadge.textContent = 'Matched ✓';
        elements.testResultScore.style.color = '#059669';
        elements.testResultScore.textContent = `⭐ ${r.confidence}% Match Confidence${r.childName ? ` (${r.childName})` : ''}`;
        elements.testResultVerdict.textContent = r.verdict;
        elements.testResultAdvice.textContent = `Match distance: ${r.distance} (Strictness threshold: ${r.threshold}). This photo passes your forwarding criteria!`;
      } else {
        elements.testResultBadge.className = 'badge badge-match-no';
        elements.testResultBadge.textContent = 'No Match ✗';
        elements.testResultScore.style.color = '#dc2626';
        elements.testResultScore.textContent = r.bestDistance ? `Closest Match: ${r.confidence}% (Below required threshold)` : 'No Child Recognized';
        elements.testResultVerdict.textContent = r.verdict;
        if (r.bestDistance && parseFloat(r.bestDistance) <= 0.58) {
          elements.testResultAdvice.textContent = `Tip: The face scored a distance of ${r.bestDistance}. If this was your child, you can adjust recognition strictness in Settings to "Relaxed" to catch it!`;
        } else {
          elements.testResultAdvice.textContent = 'Make sure your child is clearly visible in the photo without obstruction or blur.';
        }
      }
    } catch (err) {
      elements.testResultBadge.className = 'badge badge-match-no';
      elements.testResultBadge.textContent = 'Error';
      elements.testResultScore.textContent = 'Failed to analyze test photo';
    } finally {
      elements.testFileInput.value = '';
    }
  }

  // =========================================================================
  // Tab 3: Settings
  // =========================================================================
  async function loadSettings() {
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();

      if (cfg.enableForwarding) {
        elements.modeLive.checked = true;
      } else {
        elements.modeDryRun.checked = true;
      }

      elements.sliderThreshold.value = cfg.matchThreshold || 0.50;
      updateSliderDesc(elements.sliderThreshold.value);

      elements.selectVideoFrames.value = String(cfg.videoFrames || 5);

      elements.sourceIdDisplay.textContent = cfg.sourceChatId ? `ID: ${cfg.sourceChatId}` : '';
      elements.targetIdDisplay.textContent = cfg.targetChatId ? `ID: ${cfg.targetChatId}` : '';
    } catch (err) {
      console.error('Error loading settings:', err);
    }
  }

  async function loadChats() {
    elements.btnRefreshChats.disabled = true;
    elements.btnRefreshChats.textContent = '⏳ Loading...';

    try {
      const res = await fetch('/api/chats');
      const data = await res.json();
      availableChats = data.chats || [];
      populateChatDropdowns(availableChats);
    } catch (err) {
      console.error('Error loading chats:', err);
    } finally {
      elements.btnRefreshChats.disabled = false;
      elements.btnRefreshChats.textContent = '↻ Refresh';
    }
  }

  function populateChatDropdowns(chats) {
    const currentSource = currentStatus?.config?.sourceChatId || '';
    const currentTarget = currentStatus?.config?.targetChatId || '';

    // Filter groups for source
    const groups = chats.filter(c => c.id.endsWith('@g.us'));
    const allEligibleTargets = chats;

    // Populate Source Dropdown
    elements.selectSource.innerHTML = '<option value="">-- Choose Kindergarten / School Group --</option>' +
      groups.map(g => `<option value="${g.id}" ${g.id === currentSource ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('');

    // If source is not in the list but configured, add it
    if (currentSource && !groups.some(g => g.id === currentSource)) {
      const opt = document.createElement('option');
      opt.value = currentSource;
      opt.textContent = `Current Group (${currentSource})`;
      opt.selected = true;
      elements.selectSource.prepend(opt);
    }

    // Populate Target Dropdown
    elements.selectTarget.innerHTML = '<option value="">-- Choose Recipient Contact or Group --</option>' +
      allEligibleTargets.map(c => `<option value="${c.id}" ${c.id === currentTarget ? 'selected' : ''}>[${c.type}] ${escapeHtml(c.name)}</option>`).join('');

    if (currentTarget && !allEligibleTargets.some(c => c.id === currentTarget)) {
      const opt = document.createElement('option');
      opt.value = currentTarget;
      opt.textContent = `Current Target (${currentTarget})`;
      opt.selected = true;
      elements.selectTarget.prepend(opt);
    }
  }

  elements.selectSource.addEventListener('change', () => {
    elements.sourceIdDisplay.textContent = elements.selectSource.value ? `ID: ${elements.selectSource.value}` : '';
  });

  elements.selectTarget.addEventListener('change', () => {
    elements.targetIdDisplay.textContent = elements.selectTarget.value ? `ID: ${elements.selectTarget.value}` : '';
  });

  elements.btnRefreshChats.addEventListener('click', loadChats);

  // Slider Description
  elements.sliderThreshold.addEventListener('input', (e) => {
    updateSliderDesc(e.target.value);
  });

  function updateSliderDesc(val) {
    const num = parseFloat(val);
    let desc = '';
    if (num <= 0.46) {
      desc = `Strict (${num.toFixed(2)}) — Only 100% crystal clear faces, zero false alarms.`;
    } else if (num >= 0.54) {
      desc = `Relaxed (${num.toFixed(2)}) — Catches almost everything, may include similar kids.`;
    } else {
      desc = `Balanced (${num.toFixed(2)}) [Recommended] — Best balance for everyday photos.`;
    }
    elements.sliderDesc.textContent = desc;
  }

  // Save Settings
  elements.settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const source = elements.selectSource.value.trim();
    const target = elements.selectTarget.value.trim();

    if (source && target && source === target) {
      alert('Safety Warning: The group to watch and where to forward cannot be the same! The app must never forward photos back to the kindergarten group.');
      return;
    }

    const payload = {
      sourceChatId: source,
      targetChatId: target,
      enableForwarding: elements.modeLive.checked,
      matchThreshold: parseFloat(elements.sliderThreshold.value),
      videoFrames: parseInt(elements.selectVideoFrames.value, 10)
    };

    elements.btnSaveSettings.disabled = true;
    elements.saveFeedback.textContent = 'Saving...';

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast('Settings saved successfully!');
        elements.saveFeedback.textContent = '✓ Saved!';
        setTimeout(() => elements.saveFeedback.textContent = '', 3000);
      } else {
        showToast('Failed to save settings: ' + (data.error || 'Unknown error'));
        elements.saveFeedback.textContent = 'Error saving';
      }
    } catch {
      showToast('Error communicating with server');
      elements.saveFeedback.textContent = 'Error saving';
    } finally {
      elements.btnSaveSettings.disabled = false;
    }
  });

  // =========================================================================
  // Initial Fetch
  // =========================================================================
  async function fetchStats() {
    try {
      const res = await fetch('/api/stats');
      const stats = await res.json();
      renderStats(stats);
    } catch {}
  }

  async function fetchInitialStatus() {
    try {
      const res = await fetch('/api/status');
      const status = await res.json();
      renderStatus(status);
    } catch {}
  }

  // Boot
  initEventSource();
  fetchInitialStatus();
  fetchStats();
});
