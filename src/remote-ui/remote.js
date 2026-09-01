(() => {
  const $ = (id) => document.getElementById(id);
  const ids = ['sidebar', 'drawerBackdrop', 'closeSidebar', 'threadList', 'connection', 'newThread', 'emptyNew', 'chooseExistingTask', 'existingTaskCount', 'refreshThreads', 'showThreads', 'threadTitle', 'threadMeta', 'runStatus', 'emptyState', 'messages', 'approvalArea', 'approvalRequests', 'queuePanel', 'queueTitle', 'queueCount', 'queueToggle', 'queueList', 'composer', 'prompt', 'composerMode', 'composerError', 'voiceInput', 'voiceModeToggle', 'voiceStatus', 'send', 'stopTurn', 'attachFiles', 'composerToolsMenu', 'modeGoal', 'modePlan', 'menuAttach', 'menuAttachCount', 'filePicker', 'attachmentTray', 'toast', 'newThreadDialog', 'closeNewThreadDialog', 'newThreadForm', 'directoryPickerView', 'projectDirectoryList', 'browseProjectDirectory', 'directoryBrowser', 'directoryBrowserUp', 'directoryBrowserPath', 'directoryBrowserList', 'closeDirectoryBrowser', 'directoryCreateName', 'createProjectDirectory', 'selectCurrentDirectory', 'newThreadStatus', 'confirmNewThread', 'renameDialog', 'closeRenameDialog', 'renameForm', 'renameInput', 'renameStatus', 'confirmRename', 'showModel', 'modelBadge', 'modelPopover', 'modelDetail', 'modelEffortDetail', 'showUsage', 'usagePercent', 'usagePopover', 'usageDetail', 'usageReset', 'showTaskSettings', 'taskSettingsDialog', 'closeTaskSettings', 'autoApprovalToggle', 'autoApprovalStatus', 'modelSelect', 'modelSlider', 'modelValue', 'modelTicks', 'effortSelect', 'effortSlider', 'effortValue', 'effortTicks', 'saveIntelligence', 'intelligenceStatus', 'imageViewer', 'imageViewerName', 'imageViewerImage', 'imageViewerDownload', 'closeImageViewer'];
  const ui = Object.fromEntries(ids.map((id) => [id, $(id)]));
  const shell = document.querySelector('.shell');
  let socket;
  let reconnectTimer;
  let reconnectAttempt = 0;
  let threadListRetryTimer;
  let threadListRetryAttempt = 0;
  const deviceScope = (() => {
    const match = window.location.pathname.match(/\/device\/([^/]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : window.location.host;
  })();
  const recentThreadStorageKey = `gpttool:recent-thread:${deviceScope}`;
  let initialThreadSelectionDone = false;
  let nextId = 1;
  let selectedThreadId = '';
  let currentTurnId = '';
  let turnStarting = false;
  let stoppingTurnId = '';
  let stoppingTimeout;
  let connectionOnline = false;
  let retryThreadId = '';
  let selectionVersion = 0;
  let touchStartX = 0;
  let touchStartY = 0;
  let queueLoadVersion = 0;
  let queueMutation = Promise.resolve();
  let queueSnapshot = { threadId: '', activeTurnId: null, items: [] };
  let officialQueueItems = [];
  let editingQueueId = '';
  let editingQueueDraft = '';
  let queueCollapsed = false;
  let selectedTurnMode = 'normal';
  const pending = new Map();
  const pendingQueueEntries = new Map();
  const optimisticMessages = [];
  const attachmentPreviewUrls = new Map();
  const threadCache = new Map();
  const threadSnapshotCache = new Map();
  const collapsedThreadGroups = new Set();
  const streamItems = new Map();
  const liveItemText = new Map();
  const selectedAttachments = [];
  const MAX_FILES = 5;
  const MAX_THREAD_SNAPSHOTS = 4;
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_TOTAL_FILE_BYTES = 40 * 1024 * 1024;
  const UPLOAD_CHUNK_BYTES = 64 * 1024;
  const IMAGE_COMPRESSION_MIN_BYTES = 400 * 1024;
  const IMAGE_COMPRESSION_MAX_SOURCE_BYTES = 60 * 1024 * 1024;
  const IMAGE_COMPRESSION_MAX_EDGE = 2560;
  const IMAGE_COMPRESSION_MAX_PIXELS = 10_000_000;
  const IMAGE_COMPRESSION_QUALITY = 0.92;
  const VOICE_INPUT_ENABLED = true;
  const previewObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      previewObserver.unobserve(entry.target);
      void loadHistoryPreview(entry.target);
    }
  }, { root: null, rootMargin: '240px 0px' }) : undefined;
  let sending = false;
  let threadOpening = false;
  let historyOffset = 0;
  let historyHasMore = false;
  let historyLoading = false;
  let latestPositionThreadId = '';
  let latestPositionUntil = 0;
  let latestPositionFrame = 0;
  let usageLoading = false;
  let usageLoadedAt = 0;
  let usageExhausted = false;
  let usageBlockMessage = '';
  let intelligenceModels = [];
  let intelligenceSnapshot;
  let intelligenceDirty = false;
  let intelligenceRevision = 0;
  let modelLoadedAt = 0;
  let voiceRecognition;
  let voiceRecognitionConstructor;
  let voiceRecognitionStarted = false;
  let voiceSessionActive = false;
  let voiceSessionId = 0;
  let voiceRestartTimer;
  let voiceBaseText = '';
  let voiceLastCycleText = '';
  let voiceFinalText = '';
  let voiceInterimText = '';
  let voiceStopRequested = false;
  let voiceError = '';
  let composerInputMode = 'text';
  let selectedProjectDirectory = '';
  let creatingThread = false;
  let browsingDirectory = false;
  let currentBrowserDirectory = '';
  let directoryBrowserRoot = '';
  let renameContext;
  let renaming = false;
  const messageResizeObserver = 'ResizeObserver' in window ? new ResizeObserver(() => {
    if (isLatestPositionLocked()) pinLatestPosition();
  }) : undefined;
  const messageMutationObserver = new MutationObserver(() => {
    if (isLatestPositionLocked()) pinLatestPosition();
  });

  bindUi();
  lockMobileViewport();
  messageResizeObserver?.observe(ui.messages);
  messageMutationObserver.observe(ui.messages, { childList: true, subtree: true });
  connect();
  // The official client can create, reorder or archive tasks without emitting
  // an event through this WebSocket. Periodic reconciliation keeps a long-open
  // mobile page aligned instead of retaining its startup snapshot forever.
  setInterval(() => {
    if (connectionOnline && !threadOpening) void loadThreads();
  }, 10_000);

  function bindUi() {
    ui.refreshThreads.addEventListener('click', loadThreads);
    ui.newThread.addEventListener('click', openNewThreadDialog);
    ui.emptyNew.addEventListener('click', openNewThreadDialog);
    ui.closeNewThreadDialog.addEventListener('click', closeNewThreadDialog);
    ui.newThreadDialog.addEventListener('click', (event) => { if (event.target === ui.newThreadDialog) closeNewThreadDialog(); });
    ui.newThreadForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void createThread(selectedProjectDirectory);
    });
    ui.browseProjectDirectory.addEventListener('click', () => void openDirectoryBrowser());
    ui.closeDirectoryBrowser.addEventListener('click', closeDirectoryBrowser);
    ui.directoryBrowserUp.addEventListener('click', () => void browseDirectory(parentDirectoryPath(currentBrowserDirectory, directoryBrowserRoot)));
    ui.selectCurrentDirectory.addEventListener('click', selectCurrentBrowserDirectory);
    ui.directoryCreateName.addEventListener('input', updateNewThreadConfirmation);
    ui.createProjectDirectory.addEventListener('click', () => void createProjectDirectory());
    ui.closeRenameDialog.addEventListener('click', closeRenameDialog);
    ui.renameDialog.addEventListener('click', (event) => { if (event.target === ui.renameDialog) closeRenameDialog(); });
    ui.renameForm.addEventListener('submit', (event) => { event.preventDefault(); void submitRename(); });
    ui.chooseExistingTask.addEventListener('click', openDrawer);
    ui.showThreads.addEventListener('click', openDrawer);
    ui.closeSidebar.addEventListener('click', closeDrawer);
    ui.drawerBackdrop.addEventListener('click', closeDrawer);
    ui.composer.addEventListener('submit', sendPrompt);
    ui.stopTurn.addEventListener('click', stopCurrentTurn);
    ui.queueToggle.addEventListener('click', toggleQueueCollapsed);
    ui.attachFiles.addEventListener('click', toggleComposerTools);
    ui.modePlan.addEventListener('click', () => selectTurnMode('plan'));
    ui.modeGoal.addEventListener('click', () => selectTurnMode('goal'));
    ui.menuAttach.addEventListener('click', openAttachmentPicker);
    ui.composerMode.addEventListener('click', () => selectTurnMode('normal'));
    ui.filePicker.addEventListener('change', () => void selectAttachments());
    document.addEventListener('pointerdown', (event) => {
      if (!ui.composerToolsMenu.classList.contains('hidden') && !event.target.closest?.('.composer-tools-wrap')) closeComposerTools();
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeComposerTools(); });
    if (VOICE_INPUT_ENABLED) {
      ui.voiceModeToggle.hidden = false;
      ui.voiceModeToggle.disabled = false;
      ui.voiceInput.disabled = false;
      ui.voiceInput.addEventListener('click', toggleVoiceCapture);
      ui.voiceModeToggle.addEventListener('click', toggleComposerInputMode);
      renderComposerInputMode();
    }
    ui.showTaskSettings.addEventListener('click', showTaskSettings);
    ui.showModel.addEventListener('click', toggleModelPopover);
    ui.showUsage.addEventListener('click', toggleUsagePopover);
    ui.closeTaskSettings.addEventListener('click', () => ui.taskSettingsDialog.close());
    ui.taskSettingsDialog.addEventListener('click', (event) => { if (event.target === ui.taskSettingsDialog) ui.taskSettingsDialog.close(); });
    ui.autoApprovalToggle.addEventListener('change', updateAutoApproval);
    ui.saveIntelligence.addEventListener('click', saveIntelligence);
    ui.modelSlider.addEventListener('input', selectModelSliderStep);
    ui.effortSlider.addEventListener('input', () => {
      intelligenceDirty = true;
      selectSliderStep(ui.effortSelect, ui.effortSlider, ui.effortValue, ui.effortTicks);
    });
    ui.closeImageViewer.addEventListener('click', closeImageViewer);
    ui.imageViewer.addEventListener('click', (event) => { if (event.target === ui.imageViewer || event.target.classList?.contains('image-viewer-stage')) closeImageViewer(); });
    ui.prompt.addEventListener('input', resizeComposer);
    ui.prompt.addEventListener('focus', keepTextComposerVisible);
    window.visualViewport?.addEventListener('resize', () => {
      if (document.activeElement === ui.prompt) keepTextComposerVisible();
    });
    ui.messages.addEventListener('scroll', () => {
      if (isLatestPositionLocked()) return;
      if (ui.messages.scrollTop < 140 && historyHasMore && !historyLoading) void loadOlderHistory();
    }, { passive: true });
    ui.messages.addEventListener('pointerdown', releaseLatestPositionLock, { passive: true });
    ui.messages.addEventListener('wheel', releaseLatestPositionLock, { passive: true });
    ui.messages.addEventListener('load', () => {
      if (isLatestPositionLocked()) pinLatestPosition();
    }, true);
    ui.prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); ui.composer.requestSubmit(); }
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(); });
    document.addEventListener('pointerdown', (event) => {
      if (!ui.modelPopover.classList.contains('hidden') && !ui.modelPopover.contains(event.target) && !ui.showModel.contains(event.target)) {
        setModelPopover(false);
      }
      if (!ui.usagePopover.classList.contains('hidden') && !ui.usagePopover.contains(event.target) && !ui.showUsage.contains(event.target)) {
        setUsagePopover(false);
      }
    });
    document.addEventListener('touchstart', (event) => {
      const touch = event.touches[0]; if (!touch) return; touchStartX = touch.clientX; touchStartY = touch.clientY;
    }, { passive: true });
    document.addEventListener('touchend', (event) => {
      const touch = event.changedTouches[0]; if (!touch) return;
      const dx = touch.clientX - touchStartX; const dy = Math.abs(touch.clientY - touchStartY);
      if (dy > 70) return;
      if (shell.classList.contains('drawer-open') && dx < -65) closeDrawer();
      else if (!shell.classList.contains('drawer-open') && touchStartX < 24 && dx > 75) openDrawer();
    }, { passive: true });
    window.addEventListener('online', () => {
      reconnectNow();
      if (connectionOnline) void loadUsage(true);
    });
    window.addEventListener('pageshow', () => {
      reconnectNow();
      if (connectionOnline) void loadUsage(true);
    });
    window.addEventListener('focus', () => {
      if (connectionOnline) void loadUsage(true);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!connectionOnline) reconnectNow();
      else void loadUsage(true);
    });
  }

  function openDrawer() { shell.classList.add('drawer-open'); ui.closeSidebar.focus({ preventScroll: true }); }
  function closeDrawer() { shell.classList.remove('drawer-open'); }

  function toggleVoiceCapture(event) {
    event.preventDefault();
    if (voiceSessionActive) {
      voiceStopRequested = true;
      clearTimeout(voiceRestartTimer);
      voiceRestartTimer = undefined;
      renderVoiceState('processing');
      if (voiceRecognition) stopVoiceRecognition();
      else completeVoiceCapture();
      return;
    }
    startVoiceCapture();
  }

  function toggleComposerInputMode(event) {
    event.preventDefault();
    setComposerInputMode(composerInputMode === 'voice' ? 'text' : 'voice');
  }

  function setComposerInputMode(mode) {
    const nextMode = mode === 'voice' && VOICE_INPUT_ENABLED ? 'voice' : 'text';
    if (nextMode === composerInputMode) return;
    composerInputMode = nextMode;
    closeComposerTools();
    if (composerInputMode === 'voice') {
      ui.prompt.blur();
      keepComposerVisibleForVoice();
    } else {
      if (voiceSessionActive) {
        voiceStopRequested = true;
        clearTimeout(voiceRestartTimer);
        voiceRestartTimer = undefined;
        if (voiceRecognition) stopVoiceRecognition();
        else completeVoiceCapture();
      }
      requestAnimationFrame(() => {
        ui.prompt.focus({ preventScroll: true });
        keepTextComposerVisible();
      });
    }
    renderComposerInputMode();
  }

  function renderComposerInputMode() {
    const voiceMode = composerInputMode === 'voice';
    ui.composer.querySelector('.composer-box')?.classList.toggle('voice-mode', voiceMode);
    ui.prompt.hidden = voiceMode;
    ui.voiceInput.hidden = !voiceMode;
    ui.voiceModeToggle.setAttribute('aria-label', voiceMode ? '切换到文字输入' : '切换到语音输入');
    ui.voiceModeToggle.title = voiceMode ? '切换到文字输入' : '切换到语音输入';
  }

  function startVoiceCapture() {
    if (sending || threadOpening || !connectionOnline || !selectedThreadId) return;
    clearComposerError();
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!window.isSecureContext) {
      showComposerError('语音输入需要通过 HTTPS 安全连接使用');
      return;
    }
    if (!Recognition) {
      showComposerError('当前浏览器不支持网页语音转文字，请使用最新版 Safari 或 Chrome');
      return;
    }
    voiceSessionId += 1;
    const sessionId = voiceSessionId;
    voiceRecognitionConstructor = Recognition;
    voiceSessionActive = true;
    voiceBaseText = ui.prompt.value;
    voiceLastCycleText = '';
    voiceFinalText = '';
    voiceInterimText = '';
    voiceStopRequested = false;
    voiceError = '';
    renderVoiceState('starting');
    keepComposerVisibleForVoice();
    startVoiceRecognitionCycle(sessionId);
  }

  function startVoiceRecognitionCycle(sessionId) {
    if (!voiceSessionActive || voiceStopRequested || sessionId !== voiceSessionId) return;
    const Recognition = voiceRecognitionConstructor;
    if (!Recognition) return;
    const recognition = new Recognition();
    voiceRecognition = recognition;
    voiceRecognitionStarted = false;
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.addEventListener('start', () => {
      if (sessionId !== voiceSessionId || voiceRecognition !== recognition) return;
      voiceRecognitionStarted = true;
      if (voiceStopRequested) {
        stopVoiceRecognition();
        return;
      }
      renderVoiceState('listening');
    });
    recognition.addEventListener('result', (resultEvent) => {
      if (sessionId !== voiceSessionId || voiceRecognition !== recognition) return;
      const finalParts = [];
      const interimParts = [];
      for (let index = 0; index < resultEvent.results.length; index += 1) {
        const result = resultEvent.results[index];
        const text = normalizeSpeechText(result?.[0]?.transcript);
        if (!text) continue;
        (result.isFinal ? finalParts : interimParts).push(text);
      }
      // Rebuild from the browser's current result set instead of appending
      // every event. Interim results are revisions of the same phrase and
      // appending them is what caused the previous duplicated text bug.
      voiceFinalText = joinSpeechParts(finalParts);
      voiceInterimText = joinSpeechParts(interimParts);
      ui.prompt.value = appendVoiceText(voiceBaseText, joinSpeechParts([voiceFinalText, voiceInterimText]));
      resizeComposer();
    });
    recognition.addEventListener('error', (errorEvent) => {
      if (sessionId !== voiceSessionId || voiceRecognition !== recognition) return;
      if (errorEvent.error === 'aborted' && voiceStopRequested) return;
      if (errorEvent.error === 'no-speech') return;
      const messages = {
        'not-allowed': '未获得麦克风权限，请在 Safari 网站设置中允许使用麦克风',
        'service-not-allowed': '系统已阻止语音识别服务，请检查浏览器权限设置',
        'audio-capture': '没有检测到可用麦克风',
        'no-speech': '没有听到语音，请靠近麦克风后重试',
        'network': '语音识别服务暂时无法连接，请检查网络后重试',
      };
      voiceError = messages[errorEvent.error] || '语音识别失败，请重新尝试';
      voiceStopRequested = true;
    });
    recognition.addEventListener('end', () => {
      if (sessionId !== voiceSessionId || voiceRecognition !== recognition) return;
      voiceRecognition = undefined;
      voiceRecognitionStarted = false;
      if (voiceStopRequested || voiceError || !connectionOnline) {
        completeVoiceCapture();
        return;
      }
      commitVoiceCycle();
      renderVoiceState('starting');
      clearTimeout(voiceRestartTimer);
      voiceRestartTimer = setTimeout(() => {
        voiceRestartTimer = undefined;
        startVoiceRecognitionCycle(sessionId);
      }, 180);
    });
    try {
      recognition.start();
    } catch {
      voiceRecognition = undefined;
      voiceRecognitionStarted = false;
      voiceError = '无法启动语音输入，请稍后重试';
      voiceStopRequested = true;
      completeVoiceCapture();
    }
  }

  function stopVoiceRecognition(abort = false) {
    if (!voiceRecognition) return;
    try {
      if (abort) voiceRecognition.abort();
      else if (voiceRecognitionStarted) voiceRecognition.stop();
    } catch { /* recognition already ended */ }
  }

  function cancelVoiceCapture() {
    if (!voiceSessionActive) return;
    voiceStopRequested = true;
    voiceError = '语音输入已停止，请重新连接后继续';
    clearTimeout(voiceRestartTimer);
    voiceRestartTimer = undefined;
    if (voiceRecognition) stopVoiceRecognition(true);
    else completeVoiceCapture();
  }

  function commitVoiceCycle() {
    const transcript = joinSpeechParts([voiceFinalText, voiceInterimText]);
    if (transcript && transcript !== voiceLastCycleText) {
      voiceBaseText = appendVoiceText(voiceBaseText, transcript);
      voiceLastCycleText = transcript;
    }
    voiceFinalText = '';
    voiceInterimText = '';
    ui.prompt.value = voiceBaseText;
    resizeComposer();
  }

  function completeVoiceCapture() {
    const transcript = joinSpeechParts([voiceFinalText, voiceInterimText]);
    const error = voiceError;
    clearTimeout(voiceRestartTimer);
    voiceRestartTimer = undefined;
    voiceRecognition = undefined;
    voiceRecognitionConstructor = undefined;
    voiceRecognitionStarted = false;
    voiceSessionActive = false;
    voiceStopRequested = false;
    voiceFinalText = '';
    voiceInterimText = '';
    voiceError = '';
    ui.prompt.value = transcript && transcript !== voiceLastCycleText ? appendVoiceText(voiceBaseText, transcript) : voiceBaseText;
    voiceBaseText = '';
    voiceLastCycleText = '';
    resizeComposer();
    renderVoiceState('idle');
    if (error && !transcript) showComposerError(error);
    else if (transcript) toast('语音已转换为文字，请确认后发送');
  }

  function renderVoiceState(state) {
    const listening = state === 'starting' || state === 'listening';
    ui.voiceInput.classList.toggle('recording', listening);
    ui.voiceInput.classList.toggle('processing', state === 'processing');
    ui.voiceInput.setAttribute('aria-pressed', String(listening));
    ui.voiceInput.setAttribute('aria-label', listening ? '结束语音输入' : '开始语音输入');
    ui.voiceInput.title = listening ? '点击结束语音输入' : '开始语音输入';
    const label = ui.voiceInput.querySelector('.voice-button-label');
    if (label) label.textContent = state === 'starting' ? '正在启动麦克风…'
      : state === 'listening' ? '正在聆听，点击结束'
        : state === 'processing' ? '正在整理识别文字…'
          : '点击开始语音输入';
    ui.voiceStatus.textContent = state === 'starting' ? '正在启动麦克风'
      : state === 'listening' ? '正在听，识别文字会显示在输入框中，再次点击麦克风结束'
        : state === 'processing' ? '正在整理识别文字'
          : '';
  }

  function keepComposerVisibleForVoice() {
    if (document.activeElement === ui.prompt) ui.prompt.blur();
    ui.composer.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  function keepTextComposerVisible() {
    requestAnimationFrame(() => ui.composer.scrollIntoView({ block: 'end', behavior: 'smooth' }));
    setTimeout(() => {
      if (document.activeElement === ui.prompt) ui.composer.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }, 260);
  }

  function normalizeSpeechText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function joinSpeechParts(parts) {
    return parts.map(normalizeSpeechText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function appendVoiceText(base, transcript) {
    const before = String(base || '').trimEnd();
    const spoken = normalizeSpeechText(transcript);
    if (!before) return spoken;
    if (!spoken) return before;
    return `${before}${/[\s\n]$/.test(base) ? '' : ' '}${spoken}`;
  }

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const basePath = location.pathname.endsWith('/') ? location.pathname : location.pathname.replace(/[^/]*$/, '');
    const candidate = new WebSocket(`${protocol}//${location.host}${basePath}ws`);
    socket = candidate;
    setConnection(false, '正在连接…');
    candidate.addEventListener('open', () => {
      if (socket !== candidate) return;
      reconnectAttempt = 0;
      setConnection(true, '已连接本机 Codex'); loadThreads();
      void loadAutoApproval();
      void loadModelSummary(true);
      void loadUsage(true);
      void loadCompatibility();
      const threadId = retryThreadId; retryThreadId = '';
      if (threadId) selectThread(threadId, { keepFocus: true });
    });
    candidate.addEventListener('message', ({ data }) => {
      if (socket !== candidate) return;
      try { handleMessage(JSON.parse(data)); } catch { toast('收到无法解析的服务消息'); }
    });
    candidate.addEventListener('close', (event) => {
      if (socket !== candidate) return;
      socket = undefined;
      console.warn(`Remote connection closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`);
      if (selectedThreadId) retryThreadId = selectedThreadId;
      setConnection(false, '连接已断开，正在重连');
      turnStarting = false;
      setRunning(false);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('连接已断开')); }
      pending.clear();
      scheduleReconnect();
    });
    candidate.addEventListener('error', () => {
      if (socket !== candidate) return;
      setConnection(false, '连接异常，正在重连');
    });
  }

  async function loadCompatibility() {
    try {
      const result = await rpc('compatibility.status.get');
      if (result?.state === 'degraded') toast(result.message);
      if (result?.state === 'incompatible') {
        setConnection(false, '官方客户端版本不兼容');
        showComposerError(result.message);
      }
    } catch {
      // Older clients do not expose the compatibility endpoint. Their normal
      // connection and operation errors remain the fallback safety signal.
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer || connectionOnline) return;
    const delays = [800, 1400, 2400, 4000, 6500, 10_000];
    const baseDelay = delays[Math.min(reconnectAttempt, delays.length - 1)];
    reconnectAttempt += 1;
    const delay = baseDelay + Math.round(Math.random() * Math.min(800, baseDelay * 0.2));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  function reconnectNow() {
    if (connectionOnline || socket?.readyState === WebSocket.OPEN) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    reconnectAttempt = 0;
    if (socket?.readyState === WebSocket.CONNECTING) return;
    connect();
  }

  function rpc(type, payload = {}, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error('尚未连接本机 Codex')); return; }
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('请求超时，请检查本机 Codex 状态')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, type, ...payload }));
    });
  }

  function handleMessage(message) {
    if (typeof message.id === 'number') {
      const request = pending.get(message.id); if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      message.ok ? request.resolve(message.result) : request.reject(new Error(cleanError(message.error)));
      return;
    }
    if (message.type === 'event') handleEvent(message.method, message.params || {});
    else if (message.type === 'queue.updated') applyQueueSnapshot(message);
    else if (message.type === 'queue.error') handleQueueError(message);
    else if (message.type === 'usage.updated') applyUsageSnapshot(message);
    else if (message.type === 'preferences.updated') {
      intelligenceRevision += 1;
      applyIntelligenceSnapshot(message.result);
    }
    else if (message.type === 'approval.auto.updated') renderAutoApproval(message.enabled === true);
    else if (message.type === 'serverRequest') showServerRequest(message.request);
  }

  async function showTaskSettings() {
    ui.taskSettingsDialog.showModal();
    intelligenceDirty = false;
    await Promise.all([loadAutoApproval(), loadIntelligenceSettings()]);
  }

  function toggleModelPopover() {
    const opening = ui.modelPopover.classList.contains('hidden');
    setModelPopover(opening);
    if (opening && Date.now() - modelLoadedAt > 120_000) void loadModelSummary(true);
  }

  function setModelPopover(open) {
    ui.modelPopover.classList.toggle('hidden', !open);
    ui.showModel.setAttribute('aria-expanded', String(open));
  }

  async function loadModelSummary(force = false) {
    if (!force && Date.now() - modelLoadedAt < 120_000) return intelligenceSnapshot;
    try {
      const result = await rpc('composer.preferences.get');
      applyIntelligenceSnapshot(result);
      return result;
    } catch (error) {
      if (!modelLoadedAt) {
        ui.modelBadge.textContent = '--';
        ui.modelDetail.textContent = '暂时无法读取当前模型';
        ui.modelEffortDetail.textContent = error.message;
      }
      return undefined;
    }
  }

  async function loadIntelligenceSettings() {
    const requestRevision = intelligenceRevision;
    if (intelligenceSnapshot) {
      applyIntelligenceSnapshot(intelligenceSnapshot, true);
      ui.intelligenceStatus.textContent = `正在同步官方当前设置…`;
    } else {
      ui.intelligenceStatus.textContent = '正在准备官方客户端设置…';
      ui.saveIntelligence.disabled = true;
    }
    try {
      const result = await rpc('composer.preferences.get');
      // The server intentionally answers from its persistent cache first and
      // refreshes the official client in the background. A fast live push can
      // arrive before this cached RPC response; never let that old response
      // overwrite the newer, actually applied official selection.
      if (result?.cached && intelligenceRevision !== requestRevision) return;
      applyIntelligenceSnapshot(result, !intelligenceDirty);
      if (result?.cached) ui.intelligenceStatus.textContent = '已显示缓存，正在同步官方当前设置…';
    } catch (error) {
      if (!intelligenceSnapshot) ui.intelligenceStatus.textContent = error.message;
    }
  }

  async function saveIntelligence() {
    ui.saveIntelligence.disabled = true;
    ui.intelligenceStatus.textContent = '正在后台应用到官方客户端…';
    try {
      const result = await rpc('composer.preferences.set', { model: ui.modelSelect.value, effort: ui.effortSelect.value });
      intelligenceDirty = false;
      applyIntelligenceSnapshot(result, true);
      ui.intelligenceStatus.textContent = `已应用：${result.model || ui.modelValue.textContent} · ${result.effortLabel || result.effort || ui.effortValue.textContent}`;
      toast('模型与推理强度已更新');
    } catch (error) {
      ui.intelligenceStatus.textContent = error.message;
    } finally {
      ui.saveIntelligence.disabled = false;
    }
  }

  function toggleUsagePopover() {
    const opening = ui.usagePopover.classList.contains('hidden');
    setUsagePopover(opening);
    if (opening && Date.now() - usageLoadedAt > 120_000) void loadUsage(true);
  }

  function setUsagePopover(open) {
    ui.usagePopover.classList.toggle('hidden', !open);
    ui.showUsage.setAttribute('aria-expanded', String(open));
  }

  async function loadUsage(force = false) {
    if (usageLoading || (!force && Date.now() - usageLoadedAt < 120_000)) return;
    usageLoading = true;
    ui.showUsage.classList.add('loading');
    try {
      const result = await rpc('account.usage.get');
      if (result?.enforced === false) {
        applyUsageSnapshot(result);
        return result;
      }
      if (!result.available || !Number.isFinite(Number(result.percentage))) throw new Error(result.message || '暂时无法读取剩余额度');
      applyUsageSnapshot(result);
      usageLoadedAt = Date.now();
      return result;
    } catch (error) {
      ui.showUsage.title = error.message;
      if (!usageLoadedAt) {
        ui.usagePercent.textContent = '--';
        ui.usagePercent.classList.remove('three-digits');
        ui.showUsage.classList.remove('available', 'exhausted');
        ui.usageDetail.textContent = '暂时无法读取剩余额度';
        ui.usageReset.textContent = error.message;
      }
      return undefined;
    } finally {
      usageLoading = false;
      ui.showUsage.classList.remove('loading');
    }
  }

  function applyUsageSnapshot(result) {
    if (result?.enforced === false) {
      usageLoadedAt = Date.now();
      usageExhausted = false;
      usageBlockMessage = '';
      ui.usagePercent.textContent = 'API';
      ui.usagePercent.classList.add('three-digits');
      ui.showUsage.style.setProperty('--usage-percent', '100%');
      ui.showUsage.classList.remove('available', 'exhausted');
      const providerName = result.provider || '第三方模型服务';
      ui.showUsage.title = `${providerName} 用量由服务商管理`;
      ui.usageDetail.textContent = `${providerName} 用量由服务商管理`;
      ui.usageReset.textContent = result.message || 'GPTTool 不会使用 ChatGPT 官方额度阻止任务';
      refreshComposerAvailability();
      if (/剩余额度已用完/.test(ui.composerError.textContent || '')) clearComposerError();
      renderQueue();
      return;
    }
    if (!result?.available || !Number.isFinite(Number(result.percentage))) return;
    usageLoadedAt = Date.now();
    const percentage = Math.max(0, Math.min(100, Math.round(Number(result.percentage))));
    const exhausted = percentage <= 0;
    ui.usagePercent.textContent = `${percentage}`;
    ui.usagePercent.classList.toggle('three-digits', percentage >= 100);
    ui.showUsage.style.setProperty('--usage-percent', `${percentage}%`);
    ui.showUsage.classList.add('available');
    ui.showUsage.classList.toggle('exhausted', exhausted);
    ui.showUsage.title = exhausted ? 'Codex 剩余额度已用完' : `${result.period || '当前周期'}剩余 ${percentage}%`;
    ui.usageDetail.textContent = exhausted ? 'Codex 剩余额度已用完' : `${result.period || '当前周期'}剩余 ${percentage}%`;
    const resetLabel = formatUsageResetTime(result.resetAt);
    ui.usageReset.textContent = resetLabel
      ? `${resetLabel}重置 · 来自官方客户端`
      : exhausted ? '官方客户端已暂停执行新任务' : '数据来自本机官方客户端';
    usageExhausted = exhausted;
    usageBlockMessage = exhausted
      ? `Codex 剩余额度已用完${resetLabel ? `，预计 ${resetLabel}重置` : ''}。官方客户端已阻止执行，新消息暂时不能发送。`
      : '';
    refreshComposerAvailability();
    if (exhausted) {
      setUsagePopover(true);
      showComposerError(usageBlockMessage);
    } else if (/剩余额度已用完/.test(ui.composerError.textContent || '')) {
      clearComposerError();
    }
    renderQueue();
  }

  function formatUsageResetTime(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    const timestamp = Date.parse(text);
    if (!Number.isFinite(timestamp)) return text.replace(/\s*重置\s*$/, '').trim();
    const reset = new Date(timestamp);
    const now = new Date();
    const sameYear = reset.getFullYear() === now.getFullYear();
    const options = {
      ...(sameYear ? {} : { year: 'numeric' }),
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    };
    return new Intl.DateTimeFormat('zh-CN', options).format(reset);
  }

  function configureDiscreteSlider(select, slider, valueLabel, ticks, items, selected) {
    select.replaceChildren();
    const uniqueItems = items.filter((item, index, values) => item?.value && values.findIndex((candidate) => candidate?.value === item.value) === index);
    for (const item of uniqueItems) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label || item.value;
      option.selected = item.value === selected;
      select.append(option);
    }
    if (select.selectedIndex < 0 && select.options.length) select.selectedIndex = 0;
    slider.min = '0';
    slider.max = String(Math.max(0, select.options.length - 1));
    slider.step = '1';
    slider.value = String(Math.max(0, select.selectedIndex));
    slider.disabled = select.options.length < 2;
    ticks.replaceChildren(...Array.from(select.options, (_, index) => {
      const tick = document.createElement('span');
      tick.className = 'slider-tick';
      tick.title = select.options[index].textContent || '';
      return tick;
    }));
    renderDiscreteSlider(select, slider, valueLabel, ticks);
  }

  function selectSliderStep(select, slider, valueLabel, ticks) {
    select.selectedIndex = Math.max(0, Math.min(select.options.length - 1, Number(slider.value)));
    renderDiscreteSlider(select, slider, valueLabel, ticks);
    ui.intelligenceStatus.textContent = `待应用：${ui.modelValue.textContent} · ${ui.effortValue.textContent}`;
  }

  function selectModelSliderStep() {
    intelligenceDirty = true;
    ui.modelSelect.selectedIndex = Math.max(0, Math.min(ui.modelSelect.options.length - 1, Number(ui.modelSlider.value)));
    renderDiscreteSlider(ui.modelSelect, ui.modelSlider, ui.modelValue, ui.modelTicks);
    configureEffortsForSelectedModel();
    ui.intelligenceStatus.textContent = `待应用：${ui.modelValue.textContent} · ${ui.effortValue.textContent}`;
  }

  function configureEffortsForSelectedModel(preferredEffort) {
    const model = intelligenceModels.find((item) => item.value === ui.modelSelect.value);
    const efforts = model?.efforts?.length ? model.efforts : [];
    const selected = efforts.some((item) => item.value === preferredEffort)
      ? preferredEffort
      : model?.effort && efforts.some((item) => item.value === model.effort)
        ? model.effort
        : efforts[Math.floor(Math.max(0, efforts.length - 1) / 2)]?.value;
    configureDiscreteSlider(ui.effortSelect, ui.effortSlider, ui.effortValue, ui.effortTicks, efforts, selected);
    ui.saveIntelligence.disabled = !efforts.length;
    if (!efforts.length) {
      ui.intelligenceStatus.textContent = intelligenceSnapshot?.readOnly
        ? intelligenceSnapshot.message || '模型与推理强度由第三方服务配置管理'
        : '该模型的推理强度暂时无法读取，请重新打开设置';
    }
  }

  function normalizeModelOptions(result) {
    const models = Array.isArray(result.models) ? result.models : [];
    const normalized = models.map((item) => typeof item === 'string'
      ? { value: item, label: item, efforts: item === result.model ? result.efforts || [] : [] }
      : {
          value: item.value || item.label,
          label: item.label || item.value,
          efforts: Array.isArray(item.efforts) ? item.efforts : [],
          effort: item.effort,
          effortLabel: item.effortLabel,
        }).filter((item) => item.value);
    if (!normalized.some((item) => item.value === result.model) && result.model) {
      normalized.unshift({ value: result.model, label: result.model, efforts: result.efforts || [], effort: result.effort, effortLabel: result.effortLabel });
    }
    return normalized;
  }

  function applyIntelligenceSnapshot(result, forceRender = false) {
    if (!result) return;
    applyModelSummary(result);
    if (!Array.isArray(result.models)) return;
    intelligenceSnapshot = result;
    intelligenceModels = normalizeModelOptions(result);
    if (!ui.taskSettingsDialog.open || (intelligenceDirty && !forceRender)) return;
    configureDiscreteSlider(
      ui.modelSelect,
      ui.modelSlider,
      ui.modelValue,
      ui.modelTicks,
      intelligenceModels,
      result.model,
    );
    configureEffortsForSelectedModel(result.effort);
    ui.intelligenceStatus.textContent = result.readOnly
      ? result.message || `当前由 ${result.provider?.name || '第三方服务'} 管理模型设置`
      : `当前：${result.model || '默认模型'} · ${result.effortLabel || result.effort || '默认强度'}`;
    ui.saveIntelligence.disabled = result.readOnly || !ui.effortSelect.options.length;
  }

  function applyModelSummary(result) {
    const model = String(result.model || '').trim();
    if (!model) return;
    modelLoadedAt = Date.now();
    const normalized = model.replace(/^gpt[-\s]*/i, '').trim();
    const parts = normalized.split(/[-\s]+/).filter(Boolean);
    const family = parts.at(-1) || normalized;
    const compact = /^(sol|terra|luna)$/i.test(family) ? family : normalized;
    ui.modelBadge.textContent = compact.slice(0, 5);
    ui.modelBadge.classList.toggle('long', compact.length > 3);
    ui.showModel.title = `当前模型：${model}`;
    ui.modelDetail.textContent = `当前模型：${model}`;
    const effort = result.effortLabel || result.effort || '默认强度';
    ui.modelEffortDetail.textContent = `${effort}${result.cached ? ' · 缓存，正在后台同步' : ' · 已与本机设置同步'}`;
    if (result.synchronized === false) {
      ui.modelEffortDetail.textContent = `${effort} · app-server 默认值，官方界面暂不可读`;
    }
  }

  function renderDiscreteSlider(select, slider, valueLabel, ticks) {
    const index = Math.max(0, select.selectedIndex);
    const lastIndex = Math.max(0, select.options.length - 1);
    slider.value = String(index);
    slider.style.setProperty('--slider-progress', `${lastIndex ? (index / lastIndex) * 100 : 0}%`);
    valueLabel.textContent = select.options[index]?.textContent || '不可用';
    slider.setAttribute('aria-valuetext', valueLabel.textContent);
    [...ticks.children].forEach((tick, tickIndex) => tick.classList.toggle('active', tickIndex <= index));
  }

  async function loadAutoApproval() {
    if (!connectionOnline) {
      ui.autoApprovalStatus.textContent = '连接本机 GPTTool 后可修改此设置';
      return;
    }
    ui.autoApprovalToggle.disabled = true;
    try {
      const result = await rpc('approval.auto.get');
      renderAutoApproval(result.enabled === true);
    } catch (error) {
      ui.autoApprovalStatus.textContent = error.message;
    } finally {
      ui.autoApprovalToggle.disabled = false;
    }
  }

  async function updateAutoApproval() {
    const enabled = ui.autoApprovalToggle.checked;
    ui.autoApprovalToggle.disabled = true;
    ui.autoApprovalStatus.textContent = enabled ? '正在启用自动批准…' : '正在关闭自动批准…';
    try {
      const result = await rpc('approval.auto.set', { enabled });
      renderAutoApproval(result.enabled === true);
      toast(result.enabled ? '自动批准已开启' : '自动批准已关闭');
    } catch (error) {
      ui.autoApprovalToggle.checked = !enabled;
      ui.autoApprovalStatus.textContent = error.message;
      toast(error.message);
    } finally {
      ui.autoApprovalToggle.disabled = false;
    }
  }

  function renderAutoApproval(enabled) {
    ui.autoApprovalToggle.checked = enabled;
    ui.autoApprovalStatus.textContent = enabled ? '已开启：审批出现时将在后台自动选择一次性批准' : '已关闭：审批需要在官方客户端手动处理';
  }

  async function loadThreads() {
    try {
      const result = await rpc('thread.list');
      clearTimeout(threadListRetryTimer);
      threadListRetryTimer = undefined;
      threadListRetryAttempt = 0;
      applyThreadList(result.data || [], { autoOpen: true });
    } catch (error) {
      const message = String(error?.message || error || '');
      if (!isRecoverableSessionReadError(message)) {
        toast(message);
        return;
      }
      if (threadListRetryAttempt === 0) toast('正在恢复本机 Codex 会话，任务列表会自动刷新');
      ui.threadList.replaceChildren();
      const recovering = document.createElement('p');
      recovering.className = 'muted';
      recovering.textContent = '正在恢复本机 Codex 会话…';
      ui.threadList.append(recovering);
      clearTimeout(threadListRetryTimer);
      const retryDelay = Math.min(800 * (2 ** threadListRetryAttempt), 5_000);
      threadListRetryAttempt += 1;
      threadListRetryTimer = setTimeout(() => void loadThreads(), retryDelay);
    }
  }

  function applyThreadList(threads, options = {}) {
    const items = Array.isArray(threads) ? threads : [];
    renderThreads(items);
    if (!options.autoOpen || initialThreadSelectionDone || selectedThreadId || threadOpening || !connectionOnline || items.length === 0) return;
    initialThreadSelectionDone = true;
    const rememberedId = readRecentThreadId();
    const target = items.find((thread) => thread.id === rememberedId) || items[0];
    if (target?.id) void selectThread(target.id, { keepFocus: true, automatic: true });
  }

  function readRecentThreadId() {
    try { return window.localStorage.getItem(recentThreadStorageKey) || ''; } catch { return ''; }
  }

  function rememberRecentThreadId(threadId) {
    try { window.localStorage.setItem(recentThreadStorageKey, String(threadId || '')); } catch { /* private mode */ }
  }

  function isRecoverableSessionReadError(message) {
    return /disk I\/O|SQLITE_IOERR|resource busy|temporarily unavailable|正在恢复会话数据|EBUSY|\bEIO\b/i.test(message);
  }

  function renderThreads(threads) {
    threadCache.clear(); ui.threadList.replaceChildren();
    ui.existingTaskCount.textContent = threads.length ? `共 ${threads.length} 个任务，点击展开列表` : '暂无已有任务';
    ui.chooseExistingTask.disabled = threads.length === 0;
    if (!threads.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '还没有 Codex 任务'; ui.threadList.append(empty); return; }
    for (const thread of threads) threadCache.set(thread.id, thread);
    for (const group of groupThreads(threads)) {
      const section = document.createElement('section');
      section.className = 'thread-group';
      const bodyId = `thread-group-${Math.random().toString(36).slice(2)}`;
      const body = document.createElement('div');
      body.id = bodyId;
      body.className = 'thread-group-items';
      const containsActiveThread = group.threads.some((thread) => thread.id === selectedThreadId);
      if (containsActiveThread) collapsedThreadGroups.delete(group.key);
      const collapsed = collapsedThreadGroups.has(group.key);
      section.classList.toggle('collapsed', collapsed);
      body.hidden = collapsed;

      const heading = document.createElement('div');
      heading.className = 'thread-group-heading';
      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'thread-group-header';
      header.setAttribute('aria-expanded', String(!collapsed));
      header.setAttribute('aria-controls', bodyId);
      const icon = document.createElement('span');
      icon.className = 'thread-group-icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l1.8 2h9.2v8.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V7.5Z"/><path d="M3.5 10h17"/></svg>';
      const label = document.createElement('strong');
      label.textContent = group.label;
      const count = document.createElement('span');
      count.className = 'thread-group-count';
      count.textContent = String(group.threads.length);
      const chevron = document.createElement('span');
      chevron.className = 'thread-group-chevron';
      chevron.textContent = '⌄';
      header.append(icon, label, count, chevron);
      header.addEventListener('click', () => {
        const nextCollapsed = !section.classList.contains('collapsed');
        section.classList.toggle('collapsed', nextCollapsed);
        body.hidden = nextCollapsed;
        header.setAttribute('aria-expanded', String(!nextCollapsed));
        if (nextCollapsed) collapsedThreadGroups.add(group.key);
        else collapsedThreadGroups.delete(group.key);
      });

      heading.append(header);

      for (const thread of group.threads) {
        const row = document.createElement('div'); row.className = 'thread-row';
        const button = document.createElement('button'); button.className = `thread${thread.id === selectedThreadId ? ' active' : ''}`;
        const title = document.createElement('strong'); title.textContent = thread.name || thread.preview || '未命名任务';
        const time = document.createElement('small'); time.textContent = formatTime(thread.updatedAt);
        button.append(title, time); button.addEventListener('click', () => selectThread(thread.id));
        const running = thread?.status?.type === 'active' || thread?.status === 'active';
        if (running) {
          row.classList.add('running');
          const indicator = document.createElement('span');
          indicator.className = 'thread-running-indicator';
          indicator.title = '任务正在运行';
          indicator.setAttribute('aria-label', '任务正在运行');
          row.append(button, indicator);
        } else row.append(button);
        body.append(row);
      }
      section.append(heading, body);
      ui.threadList.append(section);
    }
  }

  function openNewThreadDialog() {
    closeDrawer();
    const directories = collectProjectDirectories();
    const currentDirectory = String(threadCache.get(selectedThreadId)?.cwd || '').trim();
    selectedProjectDirectory = directories.some((item) => item.path === currentDirectory) ? currentDirectory : directories[0]?.path || '';
    currentBrowserDirectory = selectedProjectDirectory;
    directoryBrowserRoot = '';
    ui.newThreadDialog.classList.remove('browser-view');
    ui.directoryPickerView.classList.remove('hidden');
    ui.directoryBrowser.classList.add('hidden');
    ui.newThreadStatus.textContent = '';
    renderProjectDirectories(directories);
    updateNewThreadConfirmation();
    ui.newThreadDialog.showModal();
  }

  function closeNewThreadDialog() {
    if (!creatingThread) ui.newThreadDialog.close();
  }

  function collectProjectDirectories() {
    const directories = new Map();
    for (const thread of threadCache.values()) {
      const projectPath = String(thread.cwd || '').trim();
      if (!projectPath) continue;
      if (/[\\/]Documents[\\/]Codex[\\/]\d{4}-\d{2}-\d{2}(?:[\\/]|$)/i.test(projectPath)) continue;
      const key = projectPath.replace(/[\\/]+$/, '').toLowerCase();
      const previous = directories.get(key);
      const numericTime = Number(thread.updatedAt || 0);
      const updatedAt = Number.isFinite(numericTime) && numericTime > 0 ? numericTime : Date.parse(thread.updatedAt || '') || 0;
      if (!previous || updatedAt > previous.updatedAt) {
        directories.set(key, {
          path: projectPath.replace(/[\\/]+$/, ''),
          label: projectDirectoryName(projectPath),
          updatedAt,
        });
      }
    }
    return [...directories.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  function projectDirectoryName(projectPath) {
    const normalized = String(projectPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized.split('/').filter(Boolean).pop() || normalized || '项目目录';
  }

  function renderProjectDirectories(directories) {
    ui.projectDirectoryList.replaceChildren();
    if (!directories.length) {
      const empty = document.createElement('div');
      empty.className = 'project-directory-empty';
      empty.innerHTML = '<strong>还没有可复用的项目目录</strong><small>点击“选择其他目录”浏览这台电脑。</small>';
      ui.projectDirectoryList.append(empty);
      return;
    }
    const heading = document.createElement('div');
    heading.className = 'project-directory-heading';
    heading.innerHTML = `<strong>最近使用</strong><small>${directories.length} 个项目目录</small>`;
    ui.projectDirectoryList.append(heading);
    for (const directory of directories) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'project-directory-option';
      option.dataset.path = directory.path;
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', String(directory.path === selectedProjectDirectory));
      option.classList.toggle('selected', directory.path === selectedProjectDirectory);
      const icon = document.createElement('span');
      icon.className = 'project-directory-icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l1.8 2h9.2v8.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V7.5Z"/><path d="M3.5 10h17"/></svg>';
      const copy = document.createElement('span');
      copy.className = 'project-directory-copy';
      const title = document.createElement('strong');
      title.textContent = directory.label;
      const path = document.createElement('small');
      path.textContent = directory.path;
      copy.append(title, path);
      const check = document.createElement('span');
      check.className = 'project-directory-check';
      check.textContent = '✓';
      option.append(icon, copy, check);
      option.addEventListener('click', () => {
        selectedProjectDirectory = directory.path;
        currentBrowserDirectory = directory.path;
        markSelectedProjectDirectory(directory.path);
        updateNewThreadConfirmation();
      });
      ui.projectDirectoryList.append(option);
    }
  }

  function markSelectedProjectDirectory(projectPath) {
    for (const option of ui.projectDirectoryList.querySelectorAll('.project-directory-option')) {
      const selected = option.dataset.path === projectPath;
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-checked', String(selected));
    }
  }

  function updateNewThreadConfirmation() {
    ui.confirmNewThread.disabled = creatingThread || !selectedProjectDirectory;
    ui.confirmNewThread.textContent = creatingThread ? '正在创建…' : '在此目录新建任务';
    ui.createProjectDirectory.disabled = browsingDirectory || !currentBrowserDirectory || !ui.directoryCreateName.value.trim();
    ui.selectCurrentDirectory.disabled = creatingThread || browsingDirectory || !currentBrowserDirectory;
    ui.selectCurrentDirectory.textContent = creatingThread ? '正在创建任务…' : '在当前文件夹新建任务';
  }

  async function openDirectoryBrowser() {
    if (browsingDirectory) return;
    ui.directoryPickerView.classList.add('hidden');
    ui.directoryBrowser.classList.remove('hidden');
    ui.newThreadDialog.classList.add('browser-view');
    ui.directoryBrowserList.innerHTML = '<p class="directory-browser-loading">正在打开文件夹…</p>';
    try {
      const result = await rpc('project.directory.root', {}, 10_000);
      directoryBrowserRoot = String(result.path || '');
      await browseDirectory(directoryBrowserRoot);
    } catch (error) {
      renderDirectoryBrowserFailure(error);
    }
  }

  function closeDirectoryBrowser() {
    if (browsingDirectory) return;
    ui.directoryBrowser.classList.add('hidden');
    ui.directoryPickerView.classList.remove('hidden');
    ui.newThreadDialog.classList.remove('browser-view');
  }

  async function browseDirectory(directoryPath) {
    if (!directoryPath || browsingDirectory) return;
    browsingDirectory = true;
    currentBrowserDirectory = directoryPath;
    ui.directoryBrowserPath.textContent = displayDirectoryPath(directoryPath);
    ui.directoryBrowserList.innerHTML = '<p class="directory-browser-loading">正在读取本机目录…</p>';
    updateNewThreadConfirmation();
    try {
      const result = await rpc('project.directory.list', { path: directoryPath }, 20_000);
      currentBrowserDirectory = result.path || directoryPath;
      directoryBrowserRoot = result.root || directoryBrowserRoot;
      ui.directoryBrowserPath.textContent = displayDirectoryPath(currentBrowserDirectory);
      updateDirectoryBrowserNavigation();
      renderDirectoryBrowserEntries(result.entries || []);
    } catch (error) {
      renderDirectoryBrowserFailure(error);
    } finally {
      browsingDirectory = false;
      updateDirectoryBrowserNavigation();
      updateNewThreadConfirmation();
    }
  }

  function renderDirectoryBrowserEntries(entries) {
    ui.directoryBrowserList.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'directory-browser-loading';
      empty.textContent = '此目录中没有子文件夹';
      ui.directoryBrowserList.append(empty);
      return;
    }
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'directory-browser-entry';
      button.innerHTML = '<span class="directory-entry-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3.5 7.5h6l1.8 2h9.2v8.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V7.5Z"/><path d="M3.5 10h17"/></svg></span>';
      const label = document.createElement('strong');
      label.textContent = entry.name;
      const arrow = document.createElement('b');
      arrow.textContent = '›';
      button.append(label, arrow);
      button.addEventListener('click', () => void browseDirectory(childDirectoryPath(currentBrowserDirectory, entry.name)));
      ui.directoryBrowserList.append(button);
    }
  }

  function selectCurrentBrowserDirectory() {
    if (!currentBrowserDirectory || browsingDirectory) return;
    void createThread(currentBrowserDirectory);
  }

  function childDirectoryPath(base, child) {
    const separator = String(base).includes('\\') && !String(base).includes('/') ? '\\' : '/';
    return `${String(base).replace(/[\\/]+$/, '')}${separator}${child}`;
  }

  function parentDirectoryPath(value, boundary) {
    const raw = String(value || '').replace(/\\/g, '/');
    const safeBoundary = String(boundary || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const normalized = raw.replace(/\/+$/, '');
    if (safeBoundary && (normalized === safeBoundary || !normalized.startsWith(`${safeBoundary}/`))) return safeBoundary;
    if (!normalized && raw.startsWith('/')) return '/';
    if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}/`;
    const slash = normalized.lastIndexOf('/');
    const parent = slash <= 0 ? (normalized.startsWith('/') ? '/' : normalized) : normalized.slice(0, slash);
    return safeBoundary && !parent.startsWith(safeBoundary) ? safeBoundary : parent;
  }

  function normalizedDirectoryPath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function displayDirectoryPath(value) {
    const current = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const root = String(directoryBrowserRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!root || current === root) return '主目录';
    return current.startsWith(`${root}/`) ? `主目录 / ${current.slice(root.length + 1).replaceAll('/', ' / ')}` : current;
  }

  function updateDirectoryBrowserNavigation() {
    const atRoot = normalizedDirectoryPath(currentBrowserDirectory) === normalizedDirectoryPath(directoryBrowserRoot);
    ui.directoryBrowserUp.disabled = browsingDirectory || atRoot;
    ui.directoryBrowserUp.setAttribute('aria-disabled', String(atRoot));
  }

  function renderDirectoryBrowserFailure(error) {
    browsingDirectory = false;
    ui.directoryBrowserList.replaceChildren();
    const failure = document.createElement('p');
    failure.className = 'directory-browser-loading error';
    failure.textContent = cleanError(error?.message || error || '无法读取目录');
    ui.directoryBrowserList.append(failure);
    updateDirectoryBrowserNavigation();
  }

  async function createProjectDirectory() {
    const name = ui.directoryCreateName.value.trim();
    if (!name || !currentBrowserDirectory || browsingDirectory) return;
    if (/[\\/]/.test(name) || name === '.' || name === '..') {
      ui.newThreadStatus.textContent = '文件夹名称不能包含路径分隔符';
      return;
    }
    const projectPath = childDirectoryPath(currentBrowserDirectory, name);
    browsingDirectory = true;
    ui.newThreadStatus.textContent = '正在通过官方 Codex 创建目录…';
    updateNewThreadConfirmation();
    try {
      await rpc('project.directory.create', { path: projectPath }, 20_000);
      selectedProjectDirectory = projectPath;
      currentBrowserDirectory = projectPath;
      ui.directoryCreateName.value = '';
      ui.newThreadStatus.textContent = '目录已创建并选中';
      toast('项目目录已创建');
      browsingDirectory = false;
      await browseDirectory(projectPath);
    } catch (error) {
      const detail = cleanError(error.message);
      ui.newThreadStatus.textContent = detail;
      toast(detail);
    } finally {
      browsingDirectory = false;
      updateNewThreadConfirmation();
    }
  }

  function groupThreads(threads) {
    const projects = new Map();
    const chats = [];
    for (const thread of threads) {
      const cwd = String(thread.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (!cwd || /\/Documents\/Codex\/\d{4}-\d{2}-\d{2}(?:\/|$)/i.test(cwd)) {
        chats.push(thread);
        continue;
      }
      const label = cwd.split('/').filter(Boolean).pop() || '项目';
      const key = `project:${cwd.toLowerCase()}`;
      if (!projects.has(key)) projects.set(key, { key, label, cwd, threads: [] });
      projects.get(key).threads.push(thread);
    }
    const groups = [...projects.values()];
    if (chats.length) groups.push({ key: 'chats', label: '聊天', threads: chats });
    return groups;
  }

  function renameActionButton(label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rename-action';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5 4 4M4.8 19.2l3.4-.7L19 7.7a1.8 1.8 0 0 0 0-2.5l-.2-.2a1.8 1.8 0 0 0-2.5 0L5.5 15.8l-.7 3.4Z"/></svg>';
    return button;
  }

  function openRenameDialog(context) {
    renameContext = context;
    ui.renameInput.value = context.name || '';
    ui.renameStatus.textContent = '';
    ui.renameDialog.showModal();
    requestAnimationFrame(() => { ui.renameInput.focus(); ui.renameInput.select(); });
  }

  function closeRenameDialog() {
    if (!renaming) ui.renameDialog.close();
  }

  async function submitRename() {
    if (!renameContext || renaming) return;
    const name = ui.renameInput.value.trim();
    if (!name) { ui.renameStatus.textContent = '任务名称不能为空'; return; }
    renaming = true;
    ui.confirmRename.disabled = true;
    ui.renameStatus.textContent = '正在保存…';
    try {
      await rpc('thread.rename', { threadId: renameContext.key, name }, 20_000);
      ui.renameDialog.close();
      await loadThreads();
      if (renameContext.key === selectedThreadId) ui.threadTitle.textContent = name;
      toast('任务名称已更新');
    } catch (error) {
      ui.renameStatus.textContent = error.message;
    } finally {
      renaming = false;
      ui.confirmRename.disabled = false;
    }
  }

  async function selectThread(threadId, options = {}) {
    const version = ++selectionVersion;
    beginLatestPositionLock(threadId);
    const previousThreadId = selectedThreadId;
    if (previousThreadId && previousThreadId !== threadId) resetStoppingState();
    const cachedSnapshot = getThreadSnapshot(threadId);
    const cachedSignature = cachedSnapshot?.signature || '';
    selectedThreadId = threadId;
    queueLoadVersion += 1;
    resetQueue(threadId);
    closeDrawer();
    ui.emptyState.classList.add('hidden'); ui.messages.classList.remove('hidden'); ui.composer.classList.remove('hidden');
    if (cachedSnapshot) {
      setThreadOpening(false);
      renderThread(cachedSnapshot.thread, cachedSnapshot.history);
      renderThreads([...threadCache.values()]);
      void loadQueue(threadId, version);
    } else {
      ui.threadTitle.textContent = '正在打开任务…'; ui.threadMeta.textContent = '正在恢复 Codex 会话';
      setThreadOpening(true);
      renderThreadSkeleton();
    }
    try {
      const result = await rpc('thread.open', { threadId }, 20000);
      if (version !== selectionVersion) return;
      const freshSignature = cacheThreadSnapshot(result.thread, result.history);
      selectedThreadId = threadId;
      rememberRecentThreadId(threadId);
      setThreadOpening(false);
      if (!cachedSnapshot || freshSignature !== cachedSignature) renderThread(result.thread, result.history);
      renderThreads([...threadCache.values()]);
      if (!cachedSnapshot) void loadQueue(threadId, version);
      if (!options.keepFocus) ui.prompt.focus({ preventScroll: true });
    } catch (error) {
      if (version !== selectionVersion) return;
      setThreadOpening(false);
      const connectionFailure = isConnectionError(error.message);
      if (connectionFailure) retryThreadId = threadId;
      if (cachedSnapshot) {
        selectedThreadId = threadId;
        ui.threadMeta.textContent = connectionFailure ? '正在重新连接，本页显示最近缓存' : ui.threadMeta.textContent;
        renderThreads([...threadCache.values()]);
        toast(connectionFailure ? '连接暂时中断，已显示最近缓存' : error.message);
        return;
      }
      selectedThreadId = previousThreadId;
      ui.messages.replaceChildren(); streamItems.clear(); liveItemText.clear(); optimisticMessages.length = 0; currentTurnId = ''; turnStarting = false; resetQueue(previousThreadId);
      ui.threadTitle.textContent = threadCache.get(threadId)?.name || threadCache.get(threadId)?.preview || '任务打开失败';
      ui.threadMeta.textContent = connectionFailure ? '传输中断，连接恢复后将自动重新加载' : '此任务的本地会话记录不存在或暂时不可读取';
      setRunning(false);
      renderThreads([...threadCache.values()]);
      showComposerError(error.message);
    }
  }

  function cacheThreadSnapshot(thread, history) {
    if (!thread?.id) return '';
    const signature = threadSnapshotSignature(thread, history);
    threadSnapshotCache.delete(thread.id);
    threadSnapshotCache.set(thread.id, { thread, history, signature });
    while (threadSnapshotCache.size > MAX_THREAD_SNAPSHOTS) {
      const oldest = threadSnapshotCache.keys().next().value;
      if (!oldest) break;
      threadSnapshotCache.delete(oldest);
    }
    return signature;
  }

  function getThreadSnapshot(threadId) {
    const cached = threadSnapshotCache.get(threadId);
    if (!cached) return undefined;
    threadSnapshotCache.delete(threadId);
    threadSnapshotCache.set(threadId, cached);
    return cached;
  }

  function threadSnapshotSignature(thread, history) {
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const last = turns.at(-1);
    const lastItem = Array.isArray(last?.items) ? last.items.at(-1) : undefined;
    return [
      thread?.updatedAt || 0,
      thread?.status?.type || '',
      turns.length,
      last?.id || '',
      last?.status || '',
      last?.items?.length || 0,
      lastItem?.id || '',
      lastItem?.status || '',
      history?.nextOffset || 0,
      history?.hasMore === true ? 1 : 0,
    ].join(':');
  }

  function renderThreadSkeleton() {
    ui.messages.setAttribute('aria-busy', 'true');
    const skeleton = document.createElement('div');
    skeleton.className = 'thread-skeleton';
    skeleton.setAttribute('aria-hidden', 'true');
    skeleton.innerHTML = `
      <div class="skeleton-bubble skeleton-user">
        <i style="--width:72%"></i>
        <i style="--width:44%"></i>
      </div>
      <div class="skeleton-agent">
        <i style="--width:92%"></i>
        <i style="--width:86%"></i>
        <i style="--width:64%"></i>
      </div>
      <div class="skeleton-process">
        <span></span>
        <i style="--width:38%"></i>
        <b></b>
      </div>
      <div class="skeleton-agent skeleton-agent-short">
        <i style="--width:84%"></i>
        <i style="--width:70%"></i>
        <i style="--width:48%"></i>
      </div>
      <div class="skeleton-bubble skeleton-user skeleton-user-short">
        <i style="--width:68%"></i>
      </div>`;
    ui.messages.replaceChildren(skeleton);
    ui.messages.scrollTop = 0;
  }

  function setThreadOpening(opening) {
    threadOpening = opening;
    ui.messages.setAttribute('aria-busy', String(opening));
    ui.composer.classList.toggle('loading', opening);
    ui.prompt.disabled = opening || !connectionOnline;
    ui.send.disabled = opening || sending || !connectionOnline || !selectedThreadId;
    ui.attachFiles.disabled = opening || sending || !connectionOnline;
    ui.voiceInput.disabled = opening || sending || !connectionOnline;
  }

  function renderThread(thread, history) {
    beginLatestPositionLock(thread.id);
    ui.messages.setAttribute('aria-busy', 'false');
    ui.threadTitle.textContent = thread.name || thread.preview || 'Codex 任务';
    ui.threadMeta.textContent = thread.cwd || '本机任务';
    ui.messages.replaceChildren(); streamItems.clear(); liveItemText.clear(); optimisticMessages.length = 0; currentTurnId = ''; turnStarting = false;
    historyOffset = Number(history?.nextOffset || thread.turns?.length || 0);
    historyHasMore = history?.hasMore === true;
    historyLoading = false;
    renderTurns(thread.turns || [], ui.messages, true);
    renderHistoryControl();
    setRunning(Boolean(currentTurnId));
    if (currentTurnId) showWorkingPlaceholder(currentTurnId);
    pinLatestPosition();
  }

  function renderTurns(turns, parent, trackActive) {
    for (const turn of turns) {
      if (trackActive && ['inProgress', 'in_progress'].includes(turn.status)) currentTurnId = turn.id;
      let processItems = [];
      const flushProcess = () => {
        if (!processItems.length) return;
        addProcessGroup(processItems, turn.id, turn.status, parent);
        processItems = [];
      };
      for (const item of turn.items || []) {
        if (isProcessItem(item)) processItems.push(item);
        else { flushProcess(); renderItem(item, { parent, replace: false }); }
      }
      flushProcess();
    }
  }

  function renderHistoryControl() {
    ui.messages.querySelector('.history-loader')?.remove();
    if (!historyHasMore && !historyLoading) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-loader';
    button.disabled = historyLoading;
    button.innerHTML = historyLoading
      ? '<i></i><span>正在加载更早记录…</span>'
      : '<span>加载更早记录</span><small>向上滚动时自动加载</small>';
    button.addEventListener('click', () => void loadOlderHistory());
    ui.messages.prepend(button);
  }

  async function loadOlderHistory() {
    if (!selectedThreadId || !historyHasMore || historyLoading || !connectionOnline) return;
    const threadId = selectedThreadId;
    const version = selectionVersion;
    historyLoading = true;
    renderHistoryControl();
    const previousHeight = ui.messages.scrollHeight;
    const previousTop = ui.messages.scrollTop;
    try {
      const result = await rpc('thread.history', { threadId, offset: historyOffset, limit: 12 }, 30000);
      if (threadId !== selectedThreadId || version !== selectionVersion) return;
      const fragment = document.createDocumentFragment();
      renderTurns(result.thread?.turns || [], fragment, false);
      const control = ui.messages.querySelector('.history-loader');
      ui.messages.insertBefore(fragment, control?.nextSibling || ui.messages.firstChild);
      historyOffset = Number(result.history?.nextOffset || historyOffset);
      historyHasMore = result.history?.hasMore === true;
      requestAnimationFrame(() => {
        ui.messages.scrollTop = previousTop + (ui.messages.scrollHeight - previousHeight);
      });
    } catch (error) {
      if (threadId === selectedThreadId) toast(error.message);
    } finally {
      if (threadId === selectedThreadId && version === selectionVersion) {
        historyLoading = false;
        renderHistoryControl();
      }
    }
  }

  function renderItem(item, options = {}) {
    if (!item || typeof item !== 'object') return undefined;
    const existing = options.replace === false ? undefined : findItemNode(item.id);
    const marker = existing ? document.createComment('item-position') : undefined;
    if (existing && marker) existing.replaceWith(marker);
    if (item.id) { streamItems.delete(item.id); liveItemText.delete(item.id); }
    let node;
    if (item.type === 'userMessage') {
      const text = cleanDisplayUserText((item.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n'));
      const attachments = (item.content || []).filter((part) => part.type === 'attachment');
      const optimistic = takeOptimisticMessage(text, item.id);
      if (optimistic) node = optimistic;
      else if (text || attachments.length) {
        node = addMessage('user', text, item.id, undefined, options.parent).node;
        appendAttachmentSummary(node, attachments, item.id);
        if (text) appendHistoryResendAction(node, text, attachments.length);
      }
    } else if (item.type === 'agentMessage') node = addMessage('agent', item.text || '', item.id, undefined, options.parent).node;
    else if (item.type === 'reasoning') node = addCompactEvent('reasoning', '思考过程', statusLabel(item.status || (options.running ? 'inProgress' : 'completed')), item.id, (body) => renderRichText(body, (item.summary || []).join('\n')), false, options.parent);
    else if (item.type === 'commandExecution') node = addCompactEvent('command', '命令执行', statusLabel(item.status), item.id, (body) => {
      body.append(createCodeBlock(item.command || '', 'shell', '命令'));
      if (item.aggregatedOutput) body.append(createCodeBlock(item.aggregatedOutput, 'text', item.exitCode == null ? '输出' : `输出 · exit ${item.exitCode}`));
    }, item.status === 'failed', options.parent);
    else if (item.type === 'fileChange') {
      node = addCompactEvent('file', '文件修改', statusLabel(item.status), item.id, (body) => {
        const list = document.createElement('ul'); list.className = 'change-list';
        for (const change of item.changes || []) { const row = document.createElement('li'); row.textContent = change.path || change.file || '文件变更'; list.append(row); }
        body.append(list);
        if (item.input) body.append(createCodeBlock(item.input, 'diff', '变更内容'));
      }, item.status === 'failed', options.parent);
    } else if (item.type === 'mcpToolCall') node = addCompactEvent(item.kind || 'tool', [item.server, item.tool].filter(Boolean).join(' / ') || '工具调用', statusLabel(item.status), item.id, (body) => {
      if (item.input) body.append(createCodeBlock(item.input, 'json', '输入'));
      if (item.result) body.append(createCodeBlock(item.result, 'text', '结果'));
    }, item.status === 'failed', options.parent);
    else if (item.type === 'plan') node = addCompactEvent('plan', '执行计划', statusLabel(item.status), item.id, (body) => renderRichText(body, item.text || item.plan || ''), false, options.parent);
    if (marker) {
      if (node) marker.replaceWith(node); else marker.remove();
    }
    return node;
  }

  function findItemNode(itemId) {
    if (!itemId) return undefined;
    return [...ui.messages.querySelectorAll('[data-item-id]')].find((node) => node.dataset.itemId === String(itemId));
  }

  function takeOptimisticMessage(text, itemId) {
    const index = optimisticMessages.findIndex((entry) => (
      entry.threadId === selectedThreadId
      && entry.text === text
      && entry.node?.isConnected
    ));
    if (index < 0) return undefined;
    const [entry] = optimisticMessages.splice(index, 1);
    entry.node.dataset.itemId = itemId || entry.node.dataset.itemId;
    entry.node.classList.remove('failed'); entry.node.querySelector('.delivery-error')?.remove();
    setDeliveryState(entry.node, entry.attachmentCount ? `已发送 · ${entry.attachmentCount} 个附件` : '已发送');
    return entry.node;
  }

  function addMessage(kind, text, itemId, label, parent = ui.messages) {
    const node = document.createElement('article'); node.className = `message ${kind}`; node.dataset.itemId = itemId || '';
    if (label) { const badge = document.createElement('span'); badge.className = 'label'; badge.textContent = label; node.append(badge); }
    const content = document.createElement('div'); content.className = 'content';
    if (text && ['agent', 'user'].includes(kind)) renderRichText(content, text); else content.textContent = text;
    node.append(content); parent.append(node);
    return { node, content };
  }

  function appendHistoryResendAction(container, text, attachmentCount = 0) {
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'message-edit-resend';
    edit.setAttribute('aria-label', '编辑此消息并再次发送');
    edit.title = '编辑并再次发送';
    edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.7 5.3 4 4M4 20l3.8-.8L19 8a2.1 2.1 0 0 0-3-3L4.8 16.2 4 20Z"/></svg><span>编辑并再次发送</span>';
    edit.addEventListener('click', () => {
      clearSelectedAttachments();
      ui.prompt.value = text;
      resizeComposer();
      clearComposerError();
      ui.prompt.focus({ preventScroll: true });
      ui.composer.scrollIntoView({ block: 'end', behavior: 'smooth' });
      toast(attachmentCount
        ? '文字已载入；历史附件不会重复附加，请按需重新选择'
        : '历史消息已载入，修改后发送将创建新一轮');
    });
    actions.append(edit);
    container.append(actions);
  }

  function appendAttachmentSummary(container, attachments, itemId = '') {
    if (!attachments?.length) return;
    const list = document.createElement('div'); list.className = 'message-attachments';
    attachments.forEach((attachment, attachmentIndex) => {
      const imageUrl = attachment.imageUrl || attachment.previewUrl;
      const imageAttachment = attachment.mimeType?.startsWith('image/');
      const item = document.createElement('span'); item.className = `message-attachment ${imageAttachment ? 'image' : 'file'}`;
      if (imageUrl || attachment.hasPreview) {
        const image = document.createElement('img');
        image.alt = attachment.name || '图片';
        image.loading = 'lazy';
        if (imageUrl) {
          image.src = imageUrl;
          image.classList.add('loaded');
        } else {
          image.dataset.threadId = selectedThreadId;
          image.dataset.itemId = itemId;
          image.dataset.attachmentIndex = String(attachmentIndex);
          image.classList.add('history-preview');
          if (previewObserver) previewObserver.observe(image); else void loadHistoryPreview(image);
          const placeholder = document.createElement('span'); placeholder.className = 'image-placeholder'; placeholder.textContent = '正在加载图片…';
          item.append(placeholder);
        }
        image.tabIndex = 0;
        image.setAttribute('role', 'button');
        image.setAttribute('aria-label', `打开图片 ${attachment.name || ''}`.trim());
        image.addEventListener('click', () => void openImageViewer(image, attachment.name || '图片'));
        image.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          void openImageViewer(image, attachment.name || '图片');
        });
        item.append(image);
      }
      const meta = document.createElement('span'); meta.className = 'message-attachment-meta';
      const icon = document.createElement('b'); icon.textContent = attachment.mimeType?.startsWith('image/') ? '图' : fileExtension(attachment.name);
      const name = document.createElement('span'); name.textContent = attachment.name;
      meta.append(icon, name); item.append(meta); list.append(item);
    });
    container.append(list);
  }

  function setDeliveryState(container, label) {
    let state = container.querySelector('.delivery-state');
    if (!state) {
      state = document.createElement('span');
      state.className = 'delivery-state';
      container.append(state);
    }
    state.textContent = label;
  }

  async function loadHistoryPreview(image) {
    if (!image?.isConnected || image.dataset.loading === 'true') return;
    const { threadId, itemId, attachmentIndex } = image.dataset;
    if (!threadId || !itemId || !Number.isInteger(Number(attachmentIndex))) return;
    image.dataset.loading = 'true';
    try {
      const result = await rpc('attachment.preview', { threadId, itemId, attachmentIndex: Number(attachmentIndex) });
      if (!image.isConnected || selectedThreadId !== threadId) return;
      image.src = result.imageUrl;
      image.classList.add('loaded');
      image.parentElement?.querySelector('.image-placeholder')?.remove();
    } catch {
      const placeholder = image.parentElement?.querySelector('.image-placeholder');
      if (placeholder) placeholder.textContent = '图片预览不可用';
    }
  }

  async function openImageViewer(image, name) {
    if (!image?.src && image?.classList.contains('history-preview')) await loadHistoryPreview(image);
    if (!image?.src) { toast('图片尚未加载完成，请稍后重试'); return; }
    ui.imageViewer.classList.remove('load-failed');
    ui.imageViewerImage.onload = () => ui.imageViewer.classList.remove('load-failed');
    ui.imageViewerImage.onerror = () => ui.imageViewer.classList.add('load-failed');
    ui.imageViewerName.textContent = name || image.alt || '图片预览';
    ui.imageViewerImage.src = image.src;
    ui.imageViewerImage.alt = name || image.alt || '图片预览';
    ui.imageViewerDownload.href = image.src;
    ui.imageViewerDownload.download = name || 'GPTTool-image';
    if (!ui.imageViewer.open) ui.imageViewer.showModal();
  }

  function closeImageViewer() {
    if (ui.imageViewer.open) ui.imageViewer.close();
    ui.imageViewer.classList.remove('load-failed');
    ui.imageViewerImage.onload = null;
    ui.imageViewerImage.onerror = null;
    ui.imageViewerImage.removeAttribute('src');
    ui.imageViewerDownload.removeAttribute('href');
  }

  function addCompactEvent(kind, title, status, itemId, renderBody, expanded = false, parent = ui.messages) {
    const running = String(status).includes('进行中');
    const details = document.createElement('details'); details.className = `compact-event ${kind}${running ? ' streaming' : ''}`; details.dataset.itemId = itemId || ''; details.open = false;
    const summary = document.createElement('summary');
    const icon = document.createElement('span'); icon.className = 'event-icon'; icon.textContent = ({ reasoning: '◇', command: '›_', file: '±', tool: '◆', plan: '☷' })[kind] || '·';
    const name = document.createElement('span'); name.className = 'event-name'; name.textContent = title;
    const state = document.createElement('span'); state.className = `event-status ${String(status).toLowerCase().includes('失败') ? 'failed' : ''}`; state.textContent = status;
    summary.append(icon, name, state);
    if (renderBody) {
      const chevron = document.createElement('span'); chevron.className = 'event-chevron'; chevron.textContent = '›'; summary.append(chevron);
      const body = document.createElement('div'); body.className = 'event-body'; renderBody(body); details.append(summary, body);
    } else details.append(summary);
    parent.append(details);
    return details;
  }

  function isProcessItem(item) {
    return ['reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'plan'].includes(item?.type);
  }

  function addProcessGroup(items, turnId, turnStatus, parent = ui.messages) {
    const running = ['inProgress', 'in_progress'].includes(turnStatus);
    const details = document.createElement('details');
    details.className = `process-group${running ? ' running' : ''}`;
    details.dataset.turnId = turnId || '';
    const summary = document.createElement('summary');
    const icon = document.createElement('span'); icon.className = 'process-icon'; icon.textContent = '⌕';
    const title = document.createElement('span'); title.className = 'process-title'; title.textContent = processSummary(items);
    const status = document.createElement('span'); status.className = 'process-status';
    status.textContent = running ? '执行中' : '查看';
    const chevron = document.createElement('span'); chevron.className = 'process-chevron'; chevron.textContent = '›';
    summary.append(icon, title, status, chevron);
    const body = document.createElement('div'); body.className = 'process-body';
    items.forEach((item, index) => renderItem(item, {
      replace: false,
      parent: body,
      running: running && index === items.length - 1 && !item.status,
    }));
    details.append(summary, body);
    parent.append(details);
    return details;
  }

  function processSummary(items) {
    const counts = { file: 0, search: 0, command: 0, tool: 0, reasoning: 0, plan: 0, image: 0 };
    for (const item of items) {
      if (item.type === 'commandExecution') counts.command += 1;
      else if (item.type === 'fileChange') counts.file += Math.max(1, item.changes?.length || 0);
      else if (item.type === 'reasoning') counts.reasoning += 1;
      else if (item.type === 'plan') counts.plan += 1;
      else counts[item.kind] = (counts[item.kind] || 0) + 1;
    }
    const parts = [];
    if (counts.file) parts.push(`修改 ${counts.file} 个文件`);
    if (counts.search) parts.push(`执行 ${counts.search} 次搜索`);
    if (counts.command) parts.push(`运行 ${counts.command} 条命令`);
    if (counts.image) parts.push(`查看 ${counts.image} 张图片`);
    if (counts.tool) parts.push(`调用 ${counts.tool} 个工具`);
    if (counts.plan) parts.push(`更新 ${counts.plan} 次计划`);
    if (counts.reasoning && !parts.length) parts.push('查看思考过程');
    return parts.length ? parts.join('，') : `查看 ${items.length} 项执行过程`;
  }

  function renderRichText(container, source) {
    container.replaceChildren();
    const text = normalizeVisibleMessageText(source);
    const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
    let cursor = 0; let match;
    while ((match = fence.exec(text))) {
      renderProse(container, text.slice(cursor, match.index));
      container.append(createCodeBlock(match[2].replace(/\n$/, ''), normalizeLanguage(match[1]), match[1].trim() || '代码'));
      cursor = match.index + match[0].length;
    }
    renderProse(container, text.slice(cursor));
  }

  function normalizeVisibleMessageText(source) {
    return String(source || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => !/^\s*::(?:git-(?:stage|commit|create-branch|push|create-pr)|code-comment|created-thread)\s*\{.*\}\s*$/i.test(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function renderProse(container, source) {
    const lines = source.split('\n'); let paragraph = []; let list;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const block = document.createElement('p'); appendInline(block, paragraph.join('\n').trim()); container.append(block); paragraph = [];
    };
    const flushList = () => { if (list) { container.append(list); list = undefined; } };
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { flushParagraph(); flushList(); continue; }
      const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
      const bullet = trimmed.match(/^[-*]\s+(.+)$/);
      const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
      const quote = trimmed.match(/^>\s?(.*)$/);
      if (heading) {
        flushParagraph(); flushList(); const node = document.createElement(`h${Math.min(heading[1].length + 2, 5)}`); appendInline(node, heading[2]); container.append(node);
      } else if (bullet || ordered) {
        flushParagraph(); const tag = ordered ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== tag) { flushList(); list = document.createElement(tag); }
        const item = document.createElement('li'); appendInline(item, (bullet || ordered)[1]); list.append(item);
      } else if (quote) {
        flushParagraph(); flushList(); const node = document.createElement('blockquote'); appendInline(node, quote[1]); container.append(node);
      } else paragraph.push(trimmed);
    }
    flushParagraph(); flushList();
  }

  function appendInline(container, text) {
    const token = /(\*\*[^*]+\*\*|`[^`\n]+`|\[[^\]]+\]\([^\s)]+\))/g;
    let cursor = 0; let match;
    while ((match = token.exec(text))) {
      container.append(document.createTextNode(text.slice(cursor, match.index)));
      const value = match[0];
      if (value.startsWith('**')) { const strong = document.createElement('strong'); strong.textContent = value.slice(2, -2); container.append(strong); }
      else if (value.startsWith('`')) { const code = document.createElement('code'); code.className = 'inline-code'; code.textContent = value.slice(1, -1); container.append(code); }
      else {
        const parts = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/); const href = parts?.[2] || '';
        if (/^https?:\/\//i.test(href)) { const link = document.createElement('a'); link.textContent = parts[1]; link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; container.append(link); }
        else container.append(document.createTextNode(parts?.[1] || value));
      }
      cursor = match.index + value.length;
    }
    container.append(document.createTextNode(text.slice(cursor)));
  }

  function createCodeBlock(source, language = 'text', title) {
    const wrapper = document.createElement('section'); wrapper.className = 'code-block';
    const header = document.createElement('div'); header.className = 'code-header';
    const label = document.createElement('span'); label.textContent = title || language || '代码';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'copy-code'; copy.textContent = '复制';
    copy.addEventListener('click', async () => { const ok = await copyText(source); copy.textContent = ok ? '已复制' : '复制失败'; setTimeout(() => { copy.textContent = '复制'; }, 1400); });
    const pre = document.createElement('pre'); const code = document.createElement('code'); code.dataset.language = language; highlightCode(code, source, language); pre.append(code);
    header.append(label, copy); wrapper.append(header, pre); return wrapper;
  }

  function highlightCode(container, source, language) {
    const keywordSets = {
      javascript: 'await async break case catch class const continue default delete do else export extends false finally for function if import in instanceof let new null return static super switch this throw true try typeof undefined var while yield',
      typescript: 'abstract any as assert await async boolean break case catch class const continue default delete do else enum export extends false finally for from function if implements import in infer interface keyof let namespace never new null number object private protected public readonly return satisfies static string super switch symbol this throw true try type typeof undefined unknown var void while yield',
      python: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield',
      shell: 'case do done elif else esac export fi for function if in local readonly then while',
    };
    const normalized = normalizeLanguage(language); const keywords = new Set((keywordSets[normalized] || '').split(' ').filter(Boolean));
    const pattern = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|^\s*#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/gm;
    let cursor = 0; let match;
    while ((match = pattern.exec(String(source)))) {
      container.append(document.createTextNode(source.slice(cursor, match.index)));
      const value = match[0]; const span = document.createElement('span');
      if (/^(\/\*|\/\/|\s*#)/.test(value)) span.className = 'token-comment';
      else if (/^["'`]/.test(value)) span.className = 'token-string';
      else if (/^\d/.test(value)) span.className = 'token-number';
      else if (keywords.has(value)) span.className = 'token-keyword';
      else span.className = 'token-name';
      span.textContent = value; container.append(span); cursor = match.index + value.length;
    }
    container.append(document.createTextNode(source.slice(cursor)));
  }

  function normalizeLanguage(value) {
    const lang = String(value || 'text').trim().toLowerCase();
    return ({ js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', bash: 'shell', sh: 'shell', zsh: 'shell', console: 'shell' })[lang] || lang || 'text';
  }

  async function copyText(value) {
    try { await navigator.clipboard.writeText(value); return true; }
    catch {
      const area = document.createElement('textarea'); area.value = value; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select();
      const copied = document.execCommand('copy'); area.remove(); return copied;
    }
  }

  function statusLabel(value) {
    const text = String(value || 'completed');
    return ({ completed: '已完成', failed: '失败', inProgress: '进行中', in_progress: '进行中', declined: '已拒绝' })[text] || text;
  }

  function resetQueue(threadId = '') {
    editingQueueId = '';
    editingQueueDraft = '';
    queueSnapshot = { threadId, activeTurnId: null, items: [] };
    officialQueueItems = [];
    renderQueue();
  }

  function toggleQueueCollapsed() {
    queueCollapsed = !queueCollapsed;
    renderQueue();
  }

  async function loadQueue(threadId = selectedThreadId, selection = selectionVersion) {
    if (!threadId || !connectionOnline) return;
    const version = ++queueLoadVersion;
    ui.queuePanel.setAttribute('aria-busy', 'true');
    try {
      const result = await rpc('turn.queue.list', { threadId });
      if (version !== queueLoadVersion || selection !== selectionVersion || threadId !== selectedThreadId) return;
      applyQueueSnapshot(result, threadId);
    } catch (error) {
      if (version === queueLoadVersion && threadId === selectedThreadId) toast(error.message);
    } finally {
      if (version === queueLoadVersion) ui.queuePanel.setAttribute('aria-busy', 'false');
    }
  }

  function normalizeQueueSnapshot(value, fallbackThreadId = selectedThreadId) {
    const envelope = value && typeof value === 'object' ? value : {};
    const nested = envelope.queue && typeof envelope.queue === 'object' && !Array.isArray(envelope.queue) ? envelope.queue : envelope;
    const rawItems = Array.isArray(nested.items) ? nested.items : Array.isArray(envelope.items) ? envelope.items : Array.isArray(envelope.queue) ? envelope.queue : [];
    const threadId = String(nested.threadId || envelope.threadId || fallbackThreadId || '');
    const activeValue = nested.activeTurnId !== undefined ? nested.activeTurnId : envelope.activeTurnId;
    const items = rawItems.map((item, index) => ({
      ...item,
      id: String(item?.id || item?.queueId || `queue-${index}`),
      threadId: String(item?.threadId || threadId),
      text: String(item?.text || ''),
      mode: item?.mode === 'plan' || item?.mode === 'goal' ? item.mode : 'normal',
      attachments: Array.isArray(item?.attachments) ? item.attachments.map((attachment) => {
        const previewUrl = attachmentPreviewUrls.get(attachment?.id);
        return previewUrl ? { ...attachment, imageUrl: previewUrl } : attachment;
      }) : [],
    })).filter((item) => item.text || item.attachments.length);
    return { threadId, activeTurnId: typeof activeValue === 'string' && activeValue ? activeValue : null, items };
  }

  function queueItemFingerprint(item) {
    const text = String(item?.text || '').replace(/\s+/g, ' ').trim();
    const attachments = (Array.isArray(item?.attachments) ? item.attachments : [])
      .map((attachment) => String(attachment?.name || attachment?.id || '').trim())
      .filter(Boolean)
      .sort()
      .join('|');
    return `${text}\n${attachments}`;
  }

  function mergeQueueItems(...groups) {
    const merged = [];
    const fingerprints = new Set();
    for (const item of groups.flat()) {
      const fingerprint = queueItemFingerprint(item);
      if (!fingerprint || fingerprints.has(fingerprint)) continue;
      fingerprints.add(fingerprint);
      merged.push(item);
    }
    return merged;
  }

  function applyQueueSnapshot(value, fallbackThreadId = selectedThreadId) {
    const next = normalizeQueueSnapshot(value, fallbackThreadId);
    if (!next.threadId || next.threadId !== selectedThreadId) return;
    const pendingItems = [...pendingQueueEntries.values()].filter((item) => item.threadId === next.threadId);
    queueSnapshot = { ...next, items: mergeQueueItems(next.items, officialQueueItems, pendingItems) };
    if (next.activeTurnId) {
      currentTurnId = next.activeTurnId;
      turnStarting = false;
      setRunning(true);
    } else if (!turnStarting) {
      if (stoppingTurnId) finishStoppingState(stoppingTurnId);
      currentTurnId = '';
      setRunning(false);
    }
    renderQueue();
  }

  function renderQueue() {
    const visible = queueSnapshot.threadId === selectedThreadId && queueSnapshot.items.length > 0;
    ui.queuePanel.classList.toggle('hidden', !visible);
    ui.queuePanel.classList.toggle('collapsed', visible && queueCollapsed);
    ui.queueToggle.setAttribute('aria-expanded', String(!queueCollapsed));
    ui.queueList.replaceChildren();
    ui.queueCount.textContent = visible ? `${queueSnapshot.items.length} 条` : '';
    if (!visible) { updateComposerMode(); return; }
    const hasPendingItem = queueSnapshot.items.some((item) => item.local);
    queueSnapshot.items.forEach((item, index) => {
      const summary = item.text || item.attachments.map((attachment) => attachment.name).join('、');
      const editing = editingQueueId === item.id;
      const row = document.createElement('article'); row.className = `queue-item${item.local ? ' sending' : ''}${editing ? ' editing' : ''}`; row.dataset.queueId = item.id; row.setAttribute('role', 'listitem'); row.setAttribute('aria-label', `第 ${index + 1} 条：${summary.slice(0, 80)}`);
      const position = document.createElement('span'); position.className = 'queue-position'; position.textContent = String(index + 1); position.setAttribute('aria-hidden', 'true');
      const main = document.createElement('div'); main.className = 'queue-main';
      if (editing) {
        const editor = document.createElement('textarea'); editor.className = 'queue-edit-input'; editor.rows = 3; editor.value = editingQueueDraft; editor.setAttribute('aria-label', `编辑第 ${index + 1} 条排队消息`);
        editor.addEventListener('input', () => { editingQueueDraft = editor.value; });
        main.append(editor);
        requestAnimationFrame(() => { editor.focus({ preventScroll: true }); editor.setSelectionRange(editor.value.length, editor.value.length); });
      } else {
        const copy = document.createElement('span'); copy.className = 'queue-text'; copy.textContent = summary;
        main.append(copy);
      }
      if (item.mode === 'plan' || item.mode === 'goal') {
        const modeBadge = document.createElement('span');
        modeBadge.className = `turn-mode-badge ${item.mode}`;
        modeBadge.textContent = item.mode === 'plan' ? '计划模式' : '目标模式';
        main.append(modeBadge);
      }
      if (item.attachments.length) {
        const attachmentCount = document.createElement('span');
        attachmentCount.className = 'queue-attachment-count';
        attachmentCount.textContent = `📎 ${item.attachments.length} 个附件`;
        main.append(attachmentCount);
      }
      const footer = document.createElement('div'); footer.className = 'queue-footer';
      const state = document.createElement('span'); state.className = 'queue-status'; state.textContent = item.source === 'official' ? '来自官方客户端' : usageExhausted ? '等待额度恢复' : item.local ? '正在加入…' : index === 0 ? '下一个执行' : '等待执行';
      footer.append(state);
      const actions = document.createElement('div'); actions.className = 'queue-actions';
      const context = `第 ${index + 1} 条排队消息`;
      if (editing) {
        const cancel = queueTextButton('取消', `取消编辑${context}`, cancelQueuedItemEdit);
        const save = queueTextButton('保存', `保存${context}`, () => saveQueuedItem(item)); save.classList.add('primary');
        save.disabled = !connectionOnline || (!editingQueueDraft.trim() && !item.attachments.length);
        actions.append(cancel, save);
      } else {
        const top = queueButton('top', `置顶${context}`, () => reorderQueuedItem(item.id, 0));
        const up = queueButton('up', `上移${context}`, () => reorderQueuedItem(item.id, index - 1));
        const down = queueButton('down', `下移${context}`, () => reorderQueuedItem(item.id, index + 1));
        const edit = queueButton('edit', `编辑${context}`, () => editQueuedItem(item));
        const remove = queueButton('delete', `删除${context}`, () => removeQueuedItem(item.id)); remove.classList.add('queue-remove');
        top.disabled = up.disabled = item.readOnly || !connectionOnline || hasPendingItem || index === 0;
        down.disabled = item.readOnly || !connectionOnline || hasPendingItem || index === queueSnapshot.items.length - 1;
        edit.disabled = remove.disabled = item.readOnly || item.local || !connectionOnline;
        actions.append(top, up, down, edit, remove);
      }
      footer.append(actions); main.append(footer); row.append(position, main); ui.queueList.append(row);
    });
    updateComposerMode();
  }

  function queueButton(icon, label, action) {
    const icons = {
      top: '<path d="M7 3h10M12 7v13m0-13-4 4m4-4 4 4"/>',
      up: '<path d="m7 14 5-5 5 5"/>',
      down: '<path d="m7 10 5 5 5-5"/>',
      edit: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16v4Zm9-13 4 4"/>',
      delete: '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/>',
    };
    const button = document.createElement('button'); button.type = 'button'; button.className = 'queue-action'; button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[icon] || ''}</svg>`; button.title = label; button.setAttribute('aria-label', label);
    button.addEventListener('click', action); return button;
  }

  function queueTextButton(text, label, action) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'queue-text-action'; button.textContent = text; button.setAttribute('aria-label', label);
    button.addEventListener('click', action); return button;
  }

  function runQueueMutation(queueId, action, threadId = queueSnapshot.threadId) {
    queueMutation = queueMutation.catch(() => undefined).then(async () => {
      const row = [...ui.queueList.querySelectorAll('.queue-item')].find((node) => node.dataset.queueId === queueId);
      row?.setAttribute('aria-busy', 'true'); row?.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      try {
        const result = await action();
        if (result) applyQueueSnapshot(result);
        return result;
      } catch (error) {
        if (selectedThreadId === threadId) { showComposerError(error.message); void loadQueue(threadId); }
        return undefined;
      } finally { row?.removeAttribute('aria-busy'); }
    });
    return queueMutation;
  }

  function reorderQueuedItem(queueId, toIndex) {
    if (toIndex < 0 || toIndex >= queueSnapshot.items.length) return;
    const threadId = queueSnapshot.threadId;
    void runQueueMutation(queueId, () => rpc('turn.queue.reorder', { threadId, queueId, toIndex }));
  }

  function removeQueuedItem(queueId) {
    const threadId = queueSnapshot.threadId;
    void runQueueMutation(queueId, () => rpc('turn.queue.remove', { threadId, queueId }));
  }

  function editQueuedItem(item) {
    queueCollapsed = false;
    editingQueueId = item.id;
    editingQueueDraft = item.text || '';
    renderQueue();
  }

  function cancelQueuedItemEdit() {
    editingQueueId = '';
    editingQueueDraft = '';
    renderQueue();
  }

  function saveQueuedItem(item) {
    const threadId = queueSnapshot.threadId;
    const text = editingQueueDraft.trim();
    void runQueueMutation(item.id, async () => {
      const result = await rpc('turn.queue.update', { threadId, queueId: item.id, text });
      editingQueueId = '';
      editingQueueDraft = '';
      return result;
    });
  }

  function steerQueuedItem(item) {
    const threadId = queueSnapshot.threadId;
    const turnId = currentTurnId || queueSnapshot.activeTurnId;
    if (!turnId) { toast('当前没有正在执行的回合'); return; }
    void runQueueMutation(item.id, async () => {
      await rpc('turn.steer', { threadId, turnId, text: item.text });
      try { return await rpc('turn.queue.remove', { threadId, queueId: item.id }); }
      catch (error) { toast('内容已追加到当前回合，但未能从队列移除，请手动删除'); throw error; }
    });
  }

  function handleQueueError(message) {
    if (message.threadId && message.threadId !== selectedThreadId) return;
    const detail = cleanError(message.error || message.message || '排队消息执行失败');
    showComposerError(detail); void loadQueue();
  }

  async function createThread(projectDirectory) {
    const cwd = String(projectDirectory || '').trim();
    if (!cwd || creatingThread) return;
    creatingThread = true;
    ui.newThreadStatus.textContent = `正在使用 ${cwd} 创建任务…`;
    updateNewThreadConfirmation();
    try {
      const result = await rpc('thread.create', { cwd });
      selectionVersion += 1;
      selectedThreadId = result.thread.id;
      ui.newThreadDialog.close();
      ui.emptyState.classList.add('hidden'); ui.messages.classList.remove('hidden'); ui.composer.classList.remove('hidden');
      renderThread(result.thread);
      resetQueue(selectedThreadId);
      void loadQueue(selectedThreadId, selectionVersion);
      await loadThreads();
      ui.prompt.focus({ preventScroll: true });
    } catch (error) {
      const detail = cleanError(error.message);
      ui.newThreadStatus.textContent = detail;
      toast(detail);
    } finally {
      creatingThread = false;
      updateNewThreadConfirmation();
    }
  }

  async function selectAttachments() {
    clearComposerError();
    const files = [...(ui.filePicker.files || [])];
    ui.filePicker.value = '';
    ui.attachFiles.disabled = true;
    let skippedForLimit = 0;
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const sourceFile = files[fileIndex];
      if (selectedAttachments.length >= MAX_FILES) {
        skippedForLimit = files.length - fileIndex;
        break;
      }
      if (!sourceFile.size) { showComposerError(`${sourceFile.name} 文件为空`); continue; }
      if (sourceFile.size > MAX_FILE_BYTES && (!isCompressibleImage(sourceFile) || sourceFile.size > IMAGE_COMPRESSION_MAX_SOURCE_BYTES)) {
        showComposerError(`${sourceFile.name} 超过单文件 20MB 限制`);
        continue;
      }
      const optimized = await optimizeImageFile(sourceFile);
      const file = optimized.file;
      if (file.size > MAX_FILE_BYTES) { showComposerError(`${sourceFile.name} 压缩后仍超过单文件 20MB 限制`); continue; }
      const total = selectedAttachments.reduce((sum, item) => sum + item.file.size, 0);
      if (total + file.size > MAX_TOTAL_FILE_BYTES) { showComposerError('每条消息的附件总量不能超过 40MB'); break; }
      selectedAttachments.push({
        id: `selected-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
        status: optimized.compressed ? `已压缩 ${formatBytes(sourceFile.size)} → ${formatBytes(file.size)}` : '',
      });
      renderAttachmentTray();
    }
    ui.attachFiles.disabled = sending;
    renderAttachmentTray();
    if (skippedForLimit) toast(`附件已满 ${MAX_FILES}/${MAX_FILES}，另有 ${skippedForLimit} 个文件未加入`);
  }

  function openAttachmentPicker() {
    closeComposerTools();
    const remaining = MAX_FILES - selectedAttachments.length;
    if (remaining <= 0) {
      toast(`附件已满 ${MAX_FILES}/${MAX_FILES}，请先移除一个附件`);
      return;
    }
    updateAttachmentPickerState();
    ui.filePicker.click();
  }

  function updateAttachmentPickerState() {
    const count = selectedAttachments.length;
    const remaining = Math.max(0, MAX_FILES - count);
    ui.menuAttachCount.textContent = `${count}/${MAX_FILES}`;
    ui.menuAttachCount.setAttribute('aria-label', `已选择 ${count} 个，最多 ${MAX_FILES} 个`);
    ui.menuAttach.classList.toggle('full', remaining === 0);
    ui.filePicker.multiple = remaining > 1;
    ui.filePicker.disabled = remaining === 0;
  }

  function isCompressibleImage(file) {
    return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
  }

  async function optimizeImageFile(file) {
    if (!isCompressibleImage(file) || file.size < IMAGE_COMPRESSION_MIN_BYTES) return { file, compressed: false };
    let decoded;
    try {
      decoded = await decodeImage(file);
      const pixelScale = Math.sqrt(IMAGE_COMPRESSION_MAX_PIXELS / (decoded.width * decoded.height));
      const edgeScale = IMAGE_COMPRESSION_MAX_EDGE / Math.max(decoded.width, decoded.height);
      const scale = Math.min(1, pixelScale, edgeScale);
      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return { file, compressed: false };
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(decoded.source, 0, 0, width, height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', IMAGE_COMPRESSION_QUALITY));
      if (!blob || blob.size >= file.size * 0.88) return { file, compressed: false };
      const name = file.name.replace(/\.[^.]+$/, '') || 'image';
      return {
        file: new File([blob], `${name}.webp`, { type: 'image/webp', lastModified: file.lastModified }),
        compressed: true,
      };
    } catch {
      return { file, compressed: false };
    } finally {
      decoded?.close?.();
    }
  }

  async function decodeImage(file) {
    if ('createImageBitmap' in window) {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      });
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取图片')); };
      image.src = url;
    });
  }

  function renderAttachmentTray() {
    updateAttachmentPickerState();
    ui.attachmentTray.replaceChildren();
    ui.attachmentTray.classList.toggle('hidden', !selectedAttachments.length);
    for (const item of selectedAttachments) {
      const chip = document.createElement('div'); chip.className = 'attachment-chip';
      let preview;
      if (item.previewUrl) {
        preview = document.createElement('img'); preview.src = item.previewUrl; preview.alt = item.file.name;
      } else {
        preview = document.createElement('span'); preview.className = 'attachment-icon'; preview.textContent = fileExtension(item.file.name);
      }
      const copy = document.createElement('span'); copy.className = 'attachment-copy';
      const name = document.createElement('strong'); name.textContent = item.file.name;
      const meta = document.createElement('small'); meta.textContent = item.status || formatBytes(item.file.size);
      copy.append(name, meta);
      let previewArea;
      if (item.previewUrl) {
        previewArea = document.createElement('button');
        previewArea.type = 'button';
        previewArea.className = 'attachment-preview';
        previewArea.setAttribute('aria-label', `预览 ${item.file.name}`);
        previewArea.title = '点击预览图片';
        previewArea.addEventListener('click', () => void openImageViewer(preview, item.file.name));
      } else {
        previewArea = document.createElement('div');
        previewArea.className = 'attachment-preview file';
      }
      previewArea.append(preview, copy);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除 ${item.file.name}`); remove.disabled = sending;
      remove.addEventListener('click', () => {
        const index = selectedAttachments.indexOf(item);
        if (index < 0) return;
        selectedAttachments.splice(index, 1);
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        renderAttachmentTray();
      });
      chip.append(previewArea, remove); ui.attachmentTray.append(chip);
    }
  }

  function clearSelectedAttachments(revokePreviews = true) {
    if (revokePreviews) for (const item of selectedAttachments) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    selectedAttachments.splice(0);
    renderAttachmentTray();
  }

  function rememberAttachmentPreviews(files, descriptors) {
    return descriptors.map((descriptor, index) => {
      const previewUrl = files[index]?.previewUrl || attachmentPreviewUrls.get(descriptor.id) || '';
      if (previewUrl) {
        attachmentPreviewUrls.delete(descriptor.id);
        attachmentPreviewUrls.set(descriptor.id, previewUrl);
        while (attachmentPreviewUrls.size > 30) {
          const oldestId = attachmentPreviewUrls.keys().next().value;
          const oldestUrl = attachmentPreviewUrls.get(oldestId);
          attachmentPreviewUrls.delete(oldestId);
          if (oldestUrl) URL.revokeObjectURL(oldestUrl);
        }
      }
      return previewUrl ? { ...descriptor, imageUrl: previewUrl } : descriptor;
    });
  }

  async function uploadAttachments(items) {
    const uploadedIds = [];
    const descriptors = [];
    try {
      for (const item of items) {
        item.status = '准备上传…'; renderAttachmentTray();
        const started = await rpc('attachment.upload.start', { name: item.file.name, mimeType: item.file.type || 'application/octet-stream', size: item.file.size });
        uploadedIds.push(started.uploadId);
        let index = 0;
        for (let offset = 0; offset < item.file.size; offset += UPLOAD_CHUNK_BYTES) {
          const bytes = new Uint8Array(await item.file.slice(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, item.file.size)).arrayBuffer());
          await rpc('attachment.upload.chunk', { uploadId: started.uploadId, index, data: bytesToBase64(bytes) });
          index += 1;
          item.status = `上传中 ${Math.min(100, Math.round((Math.min(offset + UPLOAD_CHUNK_BYTES, item.file.size) / item.file.size) * 100))}%`;
          renderAttachmentTray();
        }
        const descriptor = await rpc('attachment.upload.finish', { uploadId: started.uploadId });
        descriptors.push(descriptor);
        item.status = '已上传'; renderAttachmentTray();
      }
      return descriptors;
    } catch (error) {
      await Promise.all(uploadedIds.map((uploadId) => rpc('attachment.upload.remove', { uploadId }).catch(() => undefined)));
      throw error;
    }
  }

  async function sendPrompt(event) {
    event.preventDefault(); clearComposerError();
    if (sending || threadOpening) return;
    if (voiceSessionActive) return;
    const text = ui.prompt.value.trim();
    const turnMode = selectedTurnMode;
    if (!connectionOnline) { showComposerError('尚未连接本机 Codex，请确认电脑上的 GPTTool 已启动 Codex 控制'); return; }
    if ((!text && !selectedAttachments.length) || !selectedThreadId) return;
    sending = true; refreshComposerAvailability(); renderAttachmentTray();
    await loadUsage(true);
    if (usageExhausted) { sending = false; refreshComposerAvailability(); showComposerError(usageBlockMessage); return; }
    const files = [...selectedAttachments];
    const clientRequestId = createClientRequestId();
    let attachments;
    try {
      attachments = await uploadAttachments(files);
    } catch (error) {
      sending = false; refreshComposerAvailability();
      for (const item of files) item.status = '';
      renderAttachmentTray(); showComposerError(error.message); return;
    }
    const displayAttachments = rememberAttachmentPreviews(files, attachments);
    const attachmentIds = attachments.map((attachment) => attachment.id);
    clearSelectedAttachments(false);
    if (currentTurnId || turnStarting || queueSnapshot.activeTurnId) {
      const queued = await queuePrompt(text, displayAttachments, turnMode, clientRequestId);
      sending = false; refreshComposerAvailability();
      if (queued) { ui.prompt.value = ''; selectTurnMode('normal'); resizeComposer(); }
      return;
    }
    ui.prompt.value = ''; resizeComposer();
    const optimistic = addMessage('user', text, `local-${clientRequestId}`); scrollBottom(); turnStarting = true; setRunning(true, true);
    appendTurnModeBadge(optimistic.node, turnMode);
    appendAttachmentSummary(optimistic.node, displayAttachments);
    setDeliveryState(optimistic.node, displayAttachments.length ? `正在确认发送 · ${displayAttachments.length} 个附件` : '正在确认发送');
    const optimisticEntry = {
      threadId: selectedThreadId,
      text,
      node: optimistic.node,
      attachmentCount: displayAttachments.length,
    };
    optimisticMessages.push(optimisticEntry);
    showWorkingPlaceholder('pending');
    try {
      const result = await rpc('turn.start', { threadId: selectedThreadId, text, attachmentIds, mode: turnMode, clientRequestId });
      if (result.threadId && result.threadId !== selectedThreadId) {
        selectedThreadId = result.threadId;
        selectionVersion += 1;
        resetQueue(selectedThreadId);
        void loadThreads();
      }
      currentTurnId = result.turn?.id || currentTurnId || '';
      selectTurnMode('normal');
      turnStarting = false;
      setDeliveryState(optimistic.node, displayAttachments.length ? `已发送 · ${displayAttachments.length} 个附件` : '已发送');
      setRunning(true); showWorkingPlaceholder(currentTurnId);
    } catch (error) {
      const optimisticIndex = optimisticMessages.indexOf(optimisticEntry); if (optimisticIndex >= 0) optimisticMessages.splice(optimisticIndex, 1);
      if (await recoverAcceptedTurn(text, displayAttachments)) {
        turnStarting = false;
        selectTurnMode('normal');
        toast('已从官方 ChatGPT 确认消息发送成功');
        return;
      }
      clearWorkingPlaceholder();
      currentTurnId = ''; turnStarting = false; setRunning(Boolean(queueSnapshot.activeTurnId)); optimistic.node.classList.add('failed');
      setDeliveryState(optimistic.node, '未确认发送');
      const detail = document.createElement('span'); detail.className = 'delivery-error'; detail.textContent = '发送失败，点击此消息重试'; optimistic.node.append(detail);
      optimistic.node.addEventListener('click', () => { ui.prompt.value = text; resizeComposer(); optimistic.node.remove(); clearComposerError(); ui.prompt.focus(); }, { once: true });
      showComposerError(error.message);
    } finally {
      sending = false; refreshComposerAvailability(); renderAttachmentTray();
    }
  }

  async function recoverAcceptedTurn(text, attachments) {
    try {
      const result = await rpc('thread.open', { threadId: selectedThreadId }, 30000);
      const thread = result?.thread;
      const turns = Array.isArray(thread?.turns) ? thread.turns : [];
      const userItems = turns.flatMap((turn) => Array.isArray(turn.items) ? turn.items.filter((item) => item?.type === 'userMessage') : []);
      const lastUser = userItems.at(-1);
      if (!lastUser) return false;
      const content = Array.isArray(lastUser.content) ? lastUser.content : [];
      const confirmedText = cleanDisplayUserText(content.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n'));
      const confirmedFiles = content.filter((part) => part.type === 'attachment').map((part) => part.name);
      const expectedFiles = attachments.map((attachment) => attachment.name);
      if (confirmedText !== text || expectedFiles.some((name) => !confirmedFiles.includes(name))) return false;
      cacheThreadSnapshot(thread, result?.history);
      renderThread(thread, result?.history);
      void loadQueue(selectedThreadId, selectionVersion);
      return true;
    } catch {
      return false;
    }
  }

  async function queuePrompt(text, attachments = [], mode = 'normal', clientRequestId = createClientRequestId()) {
    const threadId = selectedThreadId;
    const localId = `local-queue-${clientRequestId}`;
    const localItem = { id: localId, threadId, text, mode, attachments, attachmentIds: attachments.map((attachment) => attachment.id), createdAt: Date.now(), status: 'sending', local: true };
    pendingQueueEntries.set(localId, localItem);
    if (queueSnapshot.threadId !== threadId) resetQueue(threadId);
    queueSnapshot = { ...queueSnapshot, items: [...queueSnapshot.items, localItem] }; renderQueue();
    try {
      const result = await rpc('turn.queue', { threadId, text, attachmentIds: localItem.attachmentIds, mode, clientRequestId });
      pendingQueueEntries.delete(localId);
      if (threadId === selectedThreadId) {
        const snapshot = result?.queue || result;
        applyQueueSnapshot(snapshot, threadId);
        if (!normalizeQueueSnapshot(snapshot, threadId).items.length && result?.item) {
          const queuedItem = normalizeQueueSnapshot({ threadId, items: [result.item] }, threadId).items[0];
          if (queuedItem) queueSnapshot = { ...queueSnapshot, items: [...queueSnapshot.items.filter((item) => item.id !== localId), queuedItem] }; renderQueue();
        }
        toast('消息已加入下一回合');
        return true;
      }
    } catch (error) {
      pendingQueueEntries.delete(localId);
      if (threadId === selectedThreadId) {
        queueSnapshot = { ...queueSnapshot, items: queueSnapshot.items.filter((item) => item.id !== localId) }; renderQueue();
        if (!ui.prompt.value.trim()) { ui.prompt.value = text; resizeComposer(); }
        showComposerError(error.message); ui.prompt.focus({ preventScroll: true });
      }
      return false;
    }
    return true;
  }

  function createClientRequestId() {
    return globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function stopCurrentTurn() {
    const turnId = currentTurnId || queueSnapshot.activeTurnId;
    if (!selectedThreadId || !turnId || stoppingTurnId) return;
    stoppingTurnId = String(turnId);
    clearTimeout(stoppingTimeout);
    ui.stopTurn.disabled = true;
    ui.stopTurn.classList.add('stopping');
    ui.stopTurn.setAttribute('aria-label', '正在停止当前任务');
    clearWorkingPlaceholder();
    showStoppingPlaceholder(turnId);
    try {
      await rpc('turn.interrupt', { threadId: selectedThreadId, turnId });
      stoppingTimeout = setTimeout(() => {
        const node = ui.messages.querySelector('.stopping-placeholder');
        const detail = node?.querySelector('.execution-wait-copy small');
        if (detail) detail.textContent = '已发送停止请求，正在等待官方客户端确认';
        ui.stopTurn.disabled = false;
      }, 12_000);
    } catch (error) {
      resetStoppingState();
      showWorkingPlaceholder(turnId);
      toast(error.message);
    }
  }

  function handleEvent(method, params) {
    if (method === 'approval/auto/approved') { toast(`已在后台自动${params.label || '批准'}一次审批`); return; }
    if (method === 'queue.updated') { applyQueueSnapshot(params); return; }
    if (method === 'official/queue/updated') {
      if (params.threadId !== selectedThreadId) return;
      officialQueueItems = Array.isArray(params.items) ? params.items : [];
      applyQueueSnapshot({ ...queueSnapshot, items: queueSnapshot.items.filter((item) => item.source !== 'official') });
      return;
    }
    if (method === 'queue.error') { handleQueueError(params); return; }
    if (method === 'thread/list/updated') {
      applyThreadList(Array.isArray(params?.data) ? params.data : [], { autoOpen: true });
      return;
    }
    if (params.threadId) threadSnapshotCache.delete(params.threadId);
    if (params.threadId && params.threadId !== selectedThreadId) { if (method === 'turn/completed') loadThreads(); return; }
    if (method === 'item/agentMessage/delta') {
      let target = streamItems.get(params.itemId);
      if (!target) {
        const existing = findItemNode(params.itemId); const message = existing?.classList.contains('message') ? { node: existing, content: existing.querySelector('.content') } : addMessage('agent', '', params.itemId);
        if (!message.content) { message.content = document.createElement('div'); message.content.className = 'content'; message.node.append(message.content); }
        message.node.classList.add('streaming'); target = message.content; streamItems.set(params.itemId, target);
      }
      const nextText = `${liveItemText.get(params.itemId) || ''}${params.delta || ''}`;
      liveItemText.set(params.itemId, nextText);
      renderRichText(target, nextText);
      showWorkingPlaceholder(params.turnId || currentTurnId);
      scrollBottom();
    }
    if (method === 'item/started') {
      clearWorkingPlaceholder();
      if (isProcessItem(params.item)) renderLiveProcessItem(params.item, params.turnId || currentTurnId, true);
      else renderItem(params.item);
      markItemStreaming(params.item?.id);
      if (['userMessage', 'agentMessage'].includes(params.item?.type)) showWorkingPlaceholder(params.turnId || currentTurnId);
      scrollBottom();
    }
    if (method === 'item/completed') {
      clearWorkingPlaceholder();
      if (isProcessItem(params.item)) renderLiveProcessItem(params.item, params.turnId || currentTurnId, false);
      else renderItem(params.item);
      findItemNode(params.item?.id)?.classList.remove('streaming');
      if (params.item?.id) { streamItems.delete(params.item.id); liveItemText.delete(params.item.id); }
      if (['userMessage', 'agentMessage'].includes(params.item?.type)) showWorkingPlaceholder(params.turnId || currentTurnId);
      scrollBottom();
    }
    if (method === 'item/reasoning/summaryTextDelta') updateLiveCompact(params.itemId, 'reasoning', '思考过程', params.delta || params.text || '', 'rich');
    if (method === 'item/commandExecution/outputDelta') updateLiveCompact(params.itemId, 'command', '命令执行', params.delta || params.output || '', 'code');
    if (method === 'item/mcpToolCall/progress') updateLiveCompact(params.itemId, 'tool', params.tool || '工具调用', params.message || params.delta || '正在执行', 'progress');
    if (method === 'item/plan/delta' || method === 'turn/plan/delta') updateLiveCompact(params.itemId || `plan-${params.turnId || currentTurnId}`, 'plan', '执行计划', params.delta || params.text || '', 'rich');
    if (method === 'turn/started') {
      currentTurnId = params.turn?.id || params.turnId || currentTurnId; turnStarting = false; setRunning(true); showWorkingPlaceholder(currentTurnId);
      const cached = threadCache.get(params.threadId);
      if (cached) { cached.status = { type: 'active' }; renderThreads([...threadCache.values()]); }
    }
    if (method === 'turn/completed') {
      clearWorkingPlaceholder(); ui.messages.querySelectorAll('.streaming').forEach((node) => node.classList.remove('streaming'));
      const completedTurnId = params.turn?.id || params.turnId;
      finalizeProcessGroup(completedTurnId);
      finishStoppingState(completedTurnId);
      if (!completedTurnId || queueSnapshot.activeTurnId === completedTurnId) queueSnapshot = { ...queueSnapshot, activeTurnId: null };
      currentTurnId = queueSnapshot.activeTurnId || ''; turnStarting = false;
      setRunning(Boolean(currentTurnId)); streamItems.clear(); liveItemText.clear();
      const cached = threadCache.get(params.threadId);
      if (cached) cached.status = { type: 'idle' };
      loadThreads();
    }
  }

  function markItemStreaming(itemId) { const node = findItemNode(itemId); if (node) node.classList.add('streaming'); }

  function renderLiveProcessItem(item, turnId, running) {
    let group = [...ui.messages.querySelectorAll('.process-group')].find((node) => node.dataset.turnId === String(turnId || ''));
    if (!group) group = addProcessGroup([], turnId, 'inProgress');
    group.classList.add('running');
    const body = group.querySelector('.process-body');
    renderItem(item, { parent: body, running });
    const items = [...body.querySelectorAll(':scope > [data-item-id]')].map((node) => ({ type: processTypeFromNode(node) }));
    const title = group.querySelector('.process-title');
    if (title) title.textContent = running ? liveProcessLabel(item) : '正在处理下一步…';
    const status = group.querySelector('.process-status');
    if (status) status.textContent = '执行中';
    group.dataset.summary = processSummary(items);
    scrollBottom();
  }

  function liveProcessLabel(item) {
    if (item?.type === 'reasoning') return '正在思考…';
    if (item?.type === 'commandExecution') return '正在运行命令…';
    if (item?.type === 'fileChange') return '正在修改文件…';
    if (item?.type === 'plan') return '正在更新执行计划…';
    if (item?.type === 'mcpToolCall') return `正在调用${item.tool ? ` ${item.tool}` : '工具'}…`;
    return '正在执行…';
  }

  function updateProcessGroupActivity(itemId, label) {
    const item = findItemNode(itemId);
    const group = item?.closest('.process-group');
    if (!group) return;
    group.classList.add('running');
    const title = group.querySelector('.process-title'); if (title) title.textContent = label;
    const status = group.querySelector('.process-status'); if (status) status.textContent = '执行中';
  }

  function finalizeProcessGroup(turnId) {
    const group = [...ui.messages.querySelectorAll('.process-group')].find((node) => !turnId || node.dataset.turnId === String(turnId));
    if (!group) return;
    group.classList.remove('running');
    group.querySelectorAll('.streaming').forEach((node) => node.classList.remove('streaming'));
    const body = group.querySelector('.process-body');
    const items = [...(body?.querySelectorAll(':scope > [data-item-id]') || [])].map((node) => ({ type: processTypeFromNode(node) }));
    const title = group.querySelector('.process-title'); if (title) title.textContent = group.dataset.summary || processSummary(items);
    const status = group.querySelector('.process-status'); if (status) status.textContent = '查看';
  }

  function processTypeFromNode(node) {
    if (node.classList.contains('reasoning')) return 'reasoning';
    if (node.classList.contains('command')) return 'commandExecution';
    if (node.classList.contains('file')) return 'fileChange';
    if (node.classList.contains('plan')) return 'plan';
    return 'mcpToolCall';
  }

  function showWorkingPlaceholder(turnId) {
    if (stoppingTurnId && String(turnId || '') === stoppingTurnId) {
      showStoppingPlaceholder(turnId);
      return;
    }
    if (!turnId || ui.messages.querySelector('.process-group.running, .compact-event.streaming:not(.working-placeholder)')) return;
    let node = ui.messages.querySelector('.working-placeholder');
    if (!node) {
      node = document.createElement('div');
      node.className = 'execution-wait working-placeholder';
      node.dataset.turnId = String(turnId);
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      node.innerHTML = `
        <span class="execution-waves" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="execution-wait-copy"><strong>正在执行</strong><small>Codex 正在准备下一步</small></span>`;
    }
    ui.messages.append(node);
    scrollBottom();
  }

  function clearWorkingPlaceholder() { ui.messages.querySelectorAll('.working-placeholder').forEach((node) => node.remove()); }

  function showStoppingPlaceholder(turnId) {
    if (!turnId) return;
    let node = ui.messages.querySelector('.stopping-placeholder');
    if (!node) {
      node = document.createElement('div');
      node.className = 'execution-wait stopping-placeholder';
      node.dataset.turnId = String(turnId);
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      node.innerHTML = `
        <span class="stopping-spinner" aria-hidden="true"><i></i></span>
        <span class="execution-wait-copy"><strong>正在停止任务…</strong><small>正在等待官方客户端结束当前步骤</small></span>`;
      ui.messages.append(node);
    }
    scrollBottom();
  }

  function finishStoppingState(completedTurnId) {
    if (!stoppingTurnId || (completedTurnId && String(completedTurnId) !== stoppingTurnId)) return;
    clearTimeout(stoppingTimeout);
    stoppingTimeout = undefined;
    const node = ui.messages.querySelector('.stopping-placeholder');
    if (node) {
      node.classList.add('stopped');
      const title = node.querySelector('.execution-wait-copy strong');
      const detail = node.querySelector('.execution-wait-copy small');
      if (title) title.textContent = '任务已停止';
      if (detail) detail.textContent = '官方客户端已结束本次执行';
      setTimeout(() => node.remove(), 2_400);
    }
    stoppingTurnId = '';
    ui.stopTurn.disabled = false;
    ui.stopTurn.classList.remove('stopping');
    ui.stopTurn.setAttribute('aria-label', '停止当前任务');
  }

  function resetStoppingState() {
    clearTimeout(stoppingTimeout);
    stoppingTimeout = undefined;
    stoppingTurnId = '';
    ui.messages.querySelectorAll('.stopping-placeholder').forEach((node) => node.remove());
    ui.stopTurn.disabled = false;
    ui.stopTurn.classList.remove('stopping');
    ui.stopTurn.setAttribute('aria-label', '停止当前任务');
  }

  function updateLiveCompact(itemId, kind, title, delta, display) {
    if (!itemId || !delta) return;
    clearWorkingPlaceholder();
    let node = findItemNode(itemId);
    if (!node) node = addCompactEvent(kind, title, '进行中', itemId, (body) => { body.classList.add('live-event-body'); });
    node.classList.add('streaming');
    updateProcessGroupActivity(itemId, kind === 'reasoning' ? '正在思考…' : kind === 'command' ? '正在运行命令…' : kind === 'plan' ? '正在更新执行计划…' : `正在${title}…`);
    const status = node.querySelector('.event-status'); if (status) status.textContent = '进行中';
    let body = node.querySelector('.event-body');
    if (!body) {
      const summary = node.querySelector('summary');
      if (summary && !summary.querySelector('.event-chevron')) { const chevron = document.createElement('span'); chevron.className = 'event-chevron'; chevron.textContent = '›'; summary.append(chevron); }
      body = document.createElement('div'); body.className = 'event-body live-event-body'; node.append(body);
    }
    const previous = liveItemText.get(itemId) || '';
    const text = display === 'progress' ? String(delta) : `${previous}${delta}`;
    liveItemText.set(itemId, text);
    if (display === 'code') {
      let pre = body.querySelector('pre.live-output'); if (!pre) { pre = document.createElement('pre'); pre.className = 'live-output'; const code = document.createElement('code'); pre.append(code); body.append(pre); }
      pre.querySelector('code').textContent = text;
    } else renderRichText(body, text);
    scrollBottom();
  }

  function showServerRequest(request) {
    if (request?.method === 'item/tool/requestUserInput') { showQuestion(request); return; }
    if (!request || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) { toast('此交互暂需回到本机 Codex 处理'); return; }
    const card = document.createElement('article'); card.className = 'approval';
    const title = document.createElement('strong'); title.textContent = request.method.includes('command') ? 'Codex 请求执行命令' : 'Codex 请求修改文件';
    const details = document.createElement('pre'); details.textContent = request.params?.command || request.params?.reason || JSON.stringify(request.params, null, 2);
    const actions = document.createElement('div'); actions.className = 'actions';
    const approve = document.createElement('button'); approve.className = 'primary'; approve.textContent = '允许一次';
    const decline = document.createElement('button'); decline.className = 'decline'; decline.textContent = '拒绝';
    const respond = async (decision) => { approve.disabled = decline.disabled = true; try { await rpc('approval.respond', { requestId: request.id, decision }); card.remove(); } catch (error) { toast(error.message); approve.disabled = decline.disabled = false; } };
    approve.addEventListener('click', () => respond('accept')); decline.addEventListener('click', () => respond('decline'));
    actions.append(approve, decline); card.append(title, details, actions); ui.approvalRequests.append(card);
  }

  function showQuestion(request) {
    const card = document.createElement('article'); card.className = 'approval';
    const title = document.createElement('strong'); title.textContent = 'Codex 需要你的选择'; card.append(title);
    const controls = new Map();
    for (const question of request.params?.questions || []) {
      const label = document.createElement('label'); label.textContent = question.question || question.header; let control;
      if (question.options?.length) {
        control = document.createElement('select');
        for (const option of question.options) { const node = document.createElement('option'); node.value = option.label; node.textContent = option.description ? `${option.label} — ${option.description}` : option.label; control.append(node); }
      } else { control = document.createElement('input'); control.type = question.isSecret ? 'password' : 'text'; }
      controls.set(question.id, control); card.append(label, control);
    }
    const actions = document.createElement('div'); actions.className = 'actions';
    const submit = document.createElement('button'); submit.className = 'primary'; submit.textContent = '提交回答';
    submit.addEventListener('click', async () => {
      const answers = Object.fromEntries([...controls].map(([id, control]) => [id, { answers: [control.value] }])); submit.disabled = true;
      try { await rpc('userInput.respond', { requestId: request.id, answers }); card.remove(); } catch (error) { toast(error.message); submit.disabled = false; }
    });
    actions.append(submit); card.append(actions); ui.approvalRequests.append(card);
  }

  function setRunning(running, pendingStart = false) {
    ui.runStatus.classList.toggle('hidden', !running); ui.runStatus.querySelector('span').textContent = pendingStart ? '正在启动 Codex' : 'Codex 工作中';
    ui.stopTurn.classList.toggle('hidden', !running || pendingStart); ui.send.classList.remove('hidden');
    refreshComposerAvailability();
    if (running) clearComposerError();
    updateComposerMode(); renderQueue();
  }
  function setConnection(online, label) {
    connectionOnline = online;
    ui.connection.classList.toggle('offline', !online); ui.connection.querySelector('span').textContent = label;
    refreshComposerAvailability();
    if (!online && voiceSessionActive) cancelVoiceCapture();
    renderQueue(); updateComposerMode();
    if (!online && !ui.composer.classList.contains('hidden')) showComposerError(label.includes('重连') ? '连接暂时中断，正在自动重连' : '尚未连接本机 Codex，请在电脑上的 GPTTool 中启动 Codex 控制');
    else if (online) clearComposerError();
  }
  function refreshComposerAvailability() {
    const blocked = usageExhausted;
    ui.send.disabled = threadOpening || sending || !connectionOnline || !selectedThreadId || blocked;
    ui.attachFiles.disabled = threadOpening || sending || !connectionOnline || blocked;
    ui.voiceInput.disabled = threadOpening || sending || !connectionOnline || !selectedThreadId || blocked;
    ui.voiceModeToggle.disabled = threadOpening || sending || !connectionOnline || !selectedThreadId || blocked;
    ui.prompt.disabled = threadOpening || !connectionOnline || blocked;
  }
  function toggleComposerTools() {
    const opening = ui.composerToolsMenu.classList.contains('hidden');
    ui.composerToolsMenu.classList.toggle('hidden', !opening);
    ui.attachFiles.setAttribute('aria-expanded', String(opening));
  }
  function closeComposerTools() {
    ui.composerToolsMenu.classList.add('hidden');
    ui.attachFiles.setAttribute('aria-expanded', 'false');
  }
  function selectTurnMode(mode) {
    selectedTurnMode = mode === 'plan' || mode === 'goal' ? mode : 'normal';
    closeComposerTools();
    updateComposerMode();
    ui.prompt.blur();
    requestAnimationFrame(() => ui.composer.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
  function appendTurnModeBadge(node, mode) {
    if (!node || (mode !== 'plan' && mode !== 'goal')) return;
    const badge = document.createElement('span');
    badge.className = `turn-mode-badge ${mode}`;
    badge.textContent = mode === 'plan' ? '计划模式' : '目标模式';
    node.append(badge);
  }
  function updateComposerMode() {
    const running = Boolean(currentTurnId || turnStarting || queueSnapshot.activeTurnId);
    const modePlaceholder = selectedTurnMode === 'plan'
      ? '描述需要规划的任务…'
      : selectedTurnMode === 'goal'
        ? '描述目标与完成标准…'
        : running ? '发送后将加入下一回合…' : '给 Codex 发送任务…';
    ui.prompt.placeholder = usageExhausted ? '额度已用完，等待重置…' : modePlaceholder;
    ui.send.setAttribute('aria-label', running ? '加入下一回合队列' : '发送');
    ui.send.title = running ? '加入下一回合队列' : '发送';
    ui.composerMode.classList.toggle('hidden', selectedTurnMode === 'normal');
    ui.composerMode.classList.toggle('plan', selectedTurnMode === 'plan');
    ui.composerMode.classList.toggle('goal', selectedTurnMode === 'goal');
    ui.composerMode.textContent = selectedTurnMode === 'plan' ? '计划 ×' : selectedTurnMode === 'goal' ? '目标 ×' : '';
    ui.modePlan.classList.toggle('selected', selectedTurnMode === 'plan');
    ui.modeGoal.classList.toggle('selected', selectedTurnMode === 'goal');
  }
  function resizeComposer() { ui.prompt.style.height = 'auto'; ui.prompt.style.height = `${Math.min(ui.prompt.scrollHeight, 150)}px`; }
  function showComposerError(message) { ui.composerError.textContent = cleanError(message); ui.composerError.classList.add('visible'); }
  function clearComposerError() {
    if (usageExhausted) {
      ui.composerError.textContent = usageBlockMessage;
      ui.composerError.classList.add('visible');
      return;
    }
    ui.composerError.textContent = '';
    ui.composerError.classList.remove('visible');
  }
  function cleanError(value) {
    const message = String(value || '远程请求失败').replace(/^RPC\s+-?\d+:\s*/i, '');
    if (/no rollout found|thread not loaded/i.test(message)) return '该任务的本地会话记录不存在或尚未生成，请刷新任务列表或新建任务';
    if (/CDP.*(?:尚未运行|未启动|not running)|官方同步.*(?:中断|未启动)/i.test(message)) return '官方同步正在后台恢复，恢复后会自动重新打开当前任务';
    if (/max payload size exceeded/i.test(message)) return '任务内容较大导致传输中断，正在自动重连';
    return message;
  }
  function cleanDisplayUserText(value) {
    return String(value || '')
      .replace(/<(environment_context|recommended_plugins|app-context|permissions|apps_instructions|plugins_instructions|skills_instructions|collaboration_mode)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .trim();
  }
  function isConnectionError(value) { return /连接已断开|连接异常|尚未连接|请求超时|max payload size exceeded|CDP.*(?:尚未运行|未启动|not running)|官方同步.*(?:中断|未启动)/i.test(String(value || '')); }
  function shortPath(value) { const parts = String(value).split(/[\\/]/).filter(Boolean); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : value || '本机'; }
  function formatTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return '—';
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fileExtension(name) {
    const extension = String(name || '').split('.').pop();
    return extension && extension !== name ? extension.slice(0, 4).toUpperCase() : '文件';
  }
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  function bytesToBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 8192, bytes.length)));
    return btoa(binary);
  }
  function beginLatestPositionLock(threadId, duration = 3200) {
    latestPositionThreadId = String(threadId || '');
    latestPositionUntil = Date.now() + duration;
    pinLatestPosition();
  }
  function releaseLatestPositionLock() {
    latestPositionUntil = 0;
    latestPositionThreadId = '';
    if (latestPositionFrame) cancelAnimationFrame(latestPositionFrame);
    latestPositionFrame = 0;
  }
  function isLatestPositionLocked() {
    return Boolean(
      latestPositionThreadId
      && latestPositionThreadId === selectedThreadId
      && Date.now() < latestPositionUntil
    );
  }
  function pinLatestPosition() {
    if (latestPositionFrame) cancelAnimationFrame(latestPositionFrame);
    latestPositionFrame = requestAnimationFrame(() => {
      latestPositionFrame = 0;
      ui.messages.scrollTo({ top: ui.messages.scrollHeight, behavior: 'auto' });
    });
  }
  function scrollBottom(smooth = true) {
    requestAnimationFrame(() => ui.messages.scrollTo({
      top: ui.messages.scrollHeight,
      behavior: smooth && !isLatestPositionLocked() ? 'smooth' : 'auto',
    }));
  }
  function toast(message, kind = 'info') {
    ui.toast.textContent = cleanError(message);
    ui.toast.classList.toggle('error', kind === 'error');
    ui.toast.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => ui.toast.classList.remove('show'), 3200);
  }

  function lockMobileViewport() {
    for (const eventName of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(eventName, (event) => event.preventDefault(), { passive: false });
    }
  }
})();
