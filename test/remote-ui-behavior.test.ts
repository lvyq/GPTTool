import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.join(testDirectory, '..');

test('locks a newly opened task to the latest message until the user scrolls', async () => {
  const source = await readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8');

  assert.match(source, /beginLatestPositionLock\(threadId\);[\s\S]*selectedThreadId = threadId;[\s\S]*renderThreadSkeleton\(\)/);
  assert.match(source, /if \(isLatestPositionLocked\(\)\) return;[\s\S]*scrollTop < 140/);
  assert.match(source, /addEventListener\('pointerdown', releaseLatestPositionLock/);
  assert.match(source, /MutationObserver\(\(\) => \{[\s\S]*pinLatestPosition\(\)/);
});

test('uses a dedicated execution activity indicator instead of a blinking message caret', async () => {
  const [source, stylesheet] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.css'), 'utf8'),
  ]);

  assert.match(source, /execution-wait working-placeholder/);
  assert.match(source, /Codex 正在准备下一步/);
  assert.match(stylesheet, /\.execution-waves i/);
  assert.match(stylesheet, /@keyframes executionWave/);
  assert.doesNotMatch(stylesheet, /caretBlink/);
});

test('shows a stopping state until the official task confirms completion', async () => {
  const [source, stylesheet] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.css'), 'utf8'),
  ]);

  assert.match(source, /showStoppingPlaceholder\(turnId\)/);
  assert.match(source, /正在停止任务…/);
  assert.match(source, /finishStoppingState\(completedTurnId\)/);
  assert.match(source, /任务已停止/);
  assert.match(stylesheet, /\.stopping-placeholder/);
  assert.match(stylesheet, /@keyframes stoppingSpin/);
});

test('automatically retries a transient Codex session database read failure', async () => {
  const source = await readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8');

  assert.match(source, /isRecoverableSessionReadError\(message\)/);
  assert.match(source, /正在恢复本机 Codex 会话/);
  assert.match(source, /threadListRetryTimer = setTimeout\(\(\) => void loadThreads\(\), retryDelay\)/);
});

test('checks official-client compatibility after every public Web connection', async () => {
  const source = await readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8');
  assert.match(source, /addEventListener\('open',[\s\S]*loadCompatibility\(\)/);
  assert.match(source, /rpc\('compatibility\.status\.get'\)/);
  assert.match(source, /官方客户端版本不兼容/);
});

test('treats a stopped CDP transport as recoverable instead of a missing task', async () => {
  const source = await readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8');

  assert.match(source, /CDP\.\*\(\?:尚未运行\|未启动\|not running\)/);
  assert.match(source, /官方同步正在后台恢复，恢复后会自动重新打开当前任务/);
  assert.match(source, /if \(connectionFailure\) retryThreadId = threadId/);
});

test('disables the composer and explains when official Codex quota reaches zero', async () => {
  const [source, stylesheet] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.css'), 'utf8'),
  ]);

  assert.match(source, /usageExhausted = exhausted/);
  assert.match(source, /await loadUsage\(true\);[\s\S]*if \(usageExhausted\)/);
  assert.match(source, /额度已用完，等待重置/);
  assert.match(source, /等待额度恢复/);
  assert.match(stylesheet, /\.usage-summary-button\.exhausted/);
});

test('refreshes remaining usage whenever a mobile page reconnects or becomes active', async () => {
  const source = await readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8');

  assert.match(source, /addEventListener\('pageshow',[\s\S]*loadUsage\(true\)/);
  assert.match(source, /addEventListener\('focus',[\s\S]*loadUsage\(true\)/);
  assert.match(source, /setConnection\(true, '已连接本机 Codex'\); loadThreads\(\);[\s\S]*loadUsage\(true\)/);
});

test('does not let a stale official quota block external model providers', async () => {
  const source = await readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8');

  assert.match(source, /result\?\.enforced === false/);
  assert.match(source, /usageExhausted = false/);
  assert.match(source, /用量由服务商管理/);
  assert.match(source, /GPTTool 不会使用 ChatGPT 官方额度阻止任务/);
});

test('renders remaining usage as a compact green and white ring without a percent suffix', async () => {
  const [markup, source, stylesheet] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.css'), 'utf8'),
  ]);

  assert.match(markup, /class="usage-ring"[\s\S]*id="usagePercent"/);
  assert.doesNotMatch(markup, /usage-chart-icon/);
  assert.match(source, /usagePercent\.textContent = `\$\{percentage\}`/);
  assert.match(source, /three-digits[\s\S]*percentage >= 100/);
  assert.match(stylesheet, /conic-gradient\(from -90deg, #43df9a 0 100%\)/);
  assert.match(stylesheet, /--usage-track: rgba\(255, 255, 255, \.2\)/);
  assert.match(stylesheet, /\.usage-ring > span/);
});

test('shows the current official model beside remaining usage and updates it from live preferences', async () => {
  const [markup, source, stylesheet] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.css'), 'utf8'),
  ]);
  assert.match(markup, /id="showModel"[\s\S]*id="modelBadge"/);
  assert.match(source, /preferences\.updated[\s\S]*applyIntelligenceSnapshot/);
  assert.match(source, /function applyModelSummary\(result\)/);
  assert.match(source, /loadModelSummary\(true\)/);
  assert.match(stylesheet, /\.model-badge/);
});

test('formats ISO quota reset timestamps in the browser local timezone', async () => {
  const source = await readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8');

  assert.match(source, /function formatUsageResetTime\(value\)/);
  assert.match(source, /new Intl\.DateTimeFormat\('zh-CN', options\)/);
  assert.match(source, /const resetLabel = formatUsageResetTime\(result\.resetAt\)/);
  assert.doesNotMatch(source, /`\$\{result\.resetAt\}重置 · 来自官方客户端`/);
});

test('renders task activity as a thin flowing strip below the navigation bar', async () => {
  const [markup, stylesheet] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.css'), 'utf8'),
  ]);

  assert.match(markup, /class="header-actions"[\s\S]*<\/div>\s*<div id="runStatus" class="run-status hidden"/);
  assert.match(stylesheet, /\.run-status \{[\s\S]*position: absolute;[\s\S]*height: 2px/);
  assert.match(stylesheet, /\.run-status::before[\s\S]*headerActivityFlow/);
  assert.match(stylesheet, /@keyframes headerActivityFlow/);
});

test('links each official model to only its supported reasoning effort slider steps', async () => {
  const [markup, source] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8'),
  ]);

  assert.match(markup, /id="modelSlider"[\s\S]*id="effortSlider"/);
  assert.match(markup, /模型与推理强度/);
  assert.match(markup, /id="taskSettingsDialog"[\s\S]*id="modelSlider"[\s\S]*id="autoApprovalToggle"[\s\S]*<\/dialog>/);
  assert.doesNotMatch(markup, /id="showModelSettings"/);
  assert.doesNotMatch(markup, /id="intelligenceDialog"/);
  assert.match(source, /intelligenceModels = normalizeModelOptions\(result\)/);
  assert.match(source, /configureEffortsForSelectedModel/);
  assert.match(source, /model: ui\.modelSelect\.value, effort: ui\.effortSelect\.value/);
});

test('does not let a cached model response overwrite a newer official-client push', async () => {
  const source = await readFile(path.resolve('src/remote-ui/remote.js'), 'utf8');
  assert.match(source, /let intelligenceRevision = 0/);
  assert.match(source, /message\.type === 'preferences\.updated'[\s\S]*intelligenceRevision \+= 1/);
  assert.match(source, /result\?\.cached && intelligenceRevision !== requestRevision/);
});

test('lets a historical user message be edited and sent as a new turn', async () => {
  const [source, stylesheet] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.css'), 'utf8'),
  ]);

  assert.match(source, /appendHistoryResendAction\(node, text, attachments\.length\)/);
  assert.match(source, /编辑此消息并再次发送/);
  assert.match(source, /clearSelectedAttachments\(\);[\s\S]*ui\.prompt\.value = text/);
  assert.match(source, /修改后发送将创建新一轮/);
  assert.match(stylesheet, /\.message-edit-resend/);
});

test('switches between text and voice input without squeezing the composer and rebuilds interim text without duplicates', async () => {
  const [markup, source, stylesheet] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.css'), 'utf8'),
  ]);

  assert.match(markup, /class="composer-box"[\s\S]*id="composerMode"[\s\S]*id="prompt"[\s\S]*id="voiceInput"[\s\S]*id="voiceModeToggle"/);
  assert.match(markup, /id="voiceInput"[\s\S]*点击开始语音输入/);
  assert.match(markup, /id="voiceModeToggle"[\s\S]*mic-icon[\s\S]*keyboard-icon/);
  assert.doesNotMatch(markup, /holdToTalk|按住说话/);
  assert.match(source, /voiceInput\.addEventListener\('click', toggleVoiceCapture\)/);
  assert.match(source, /voiceModeToggle\.addEventListener\('click', toggleComposerInputMode\)/);
  assert.match(source, /function setComposerInputMode[\s\S]*ui\.prompt\.hidden = voiceMode[\s\S]*ui\.voiceInput\.hidden = !voiceMode/);
  assert.match(source, /recognition\.continuous = true/);
  assert.match(source, /if \(voiceSessionActive\)[\s\S]*stopVoiceRecognition/);
  assert.match(source, /commitVoiceCycle\(\);[\s\S]*setTimeout\(\(\) =>[\s\S]*startVoiceRecognitionCycle\(sessionId\)/);
  assert.match(source, /function keepComposerVisibleForVoice[\s\S]*ui\.prompt\.blur\(\)[\s\S]*scrollIntoView/);
  assert.match(source, /for \(let index = 0; index < resultEvent\.results\.length; index \+= 1\)/);
  assert.match(source, /voiceFinalText = joinSpeechParts\(finalParts\)/);
  assert.match(source, /ui\.prompt\.value = appendVoiceText\(voiceBaseText, joinSpeechParts\(\[voiceFinalText, voiceInterimText\]\)\)/);
  assert.match(source, /语音已转换为文字，请确认后发送/);
  assert.doesNotMatch(source, /voiceResults|mergeSpeechResults|requestSubmit\(\).*语音/);
  assert.doesNotMatch(source, /focusPromptForVoice/);
  assert.match(stylesheet, /\.voice-button\.recording/);
  assert.match(stylesheet, /@keyframes voiceListeningPulse/);
  assert.match(stylesheet, /\.composer\s*\{[\s\S]*grid-template-columns: auto minmax\(0, 1fr\) auto auto/);
  assert.match(stylesheet, /\.input-mode-toggle[\s\S]*\.keyboard-icon/);
});

test('shows selected attachments in a full-width tray and opens image previews', async () => {
  const [markup, source, stylesheet] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.css'), 'utf8'),
  ]);

  assert.match(markup, /id="filePicker"[\s\S]*id="attachmentTray"[\s\S]*id="attachFiles"[\s\S]*class="composer-box"/);
  assert.match(markup, /id="menuAttachCount"[\s\S]*0\/5/);
  assert.match(markup, /composer-tool-icon composer-attachment-icon[\s\S]*<svg[\s\S]*<path/);
  assert.doesNotMatch(markup, /composer-tool-icon attachment-icon/);
  assert.match(source, /ui\.filePicker\.multiple = remaining > 1/);
  assert.match(source, /ui\.filePicker\.disabled = remaining === 0/);
  assert.match(source, /附件已满 \$\{MAX_FILES\}\/\$\{MAX_FILES\}/);
  assert.doesNotMatch(source, /showComposerError\(`每条消息最多添加/);
  assert.match(source, /previewArea\.className = 'attachment-preview'/);
  assert.match(source, /previewArea\.addEventListener\('click', \(\) => void openImageViewer\(preview, item\.file\.name\)\)/);
  assert.match(source, /imageViewerImage\.onerror = \(\) => ui\.imageViewer\.classList\.add\('load-failed'\)/);
  assert.match(source, /aria-label', `预览 \$\{item\.file\.name\}`/);
  assert.match(stylesheet, /\.attachment-tray \{[\s\S]*grid-column: 1 \/ -1/);
  assert.match(stylesheet, /\.attachment-preview \{[\s\S]*grid-template-columns: 26px minmax\(0, 1fr\)/);
  assert.match(stylesheet, /\.attachment-tray::-webkit-scrollbar/);
  assert.match(stylesheet, /\.attachment-limit-count/);
  assert.match(stylesheet, /\.composer-attachment-icon svg \{[\s\S]*width: 21px;[\s\S]*stroke: currentColor/);
  assert.match(stylesheet, /\.image-viewer\.load-failed \.image-viewer-stage::after/);
});

test('renders message attachments as compact side-by-side thumbnails', async () => {
  const stylesheet = await readFile(path.resolve('src/remote-ui/remote.css'), 'utf8');
  assert.match(stylesheet, /\.message-attachments \{[\s\S]*display: flex;[\s\S]*flex-wrap: wrap;[\s\S]*gap: 6px/);
  assert.match(stylesheet, /\.message-attachment\.image \{[\s\S]*width: 112px;[\s\S]*height: 112px;[\s\S]*flex: 0 0 112px/);
  assert.match(stylesheet, /@media \(max-width: 700px\) \{[\s\S]*\.message-attachment\.image \{[\s\S]*width: 104px;[\s\S]*height: 104px/);
});

test('offers official Plan and Goal modes and keeps queued mode metadata', async () => {
  const [markup, source, stylesheet] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.css'), 'utf8'),
  ]);
  assert.match(markup, /id="modeGoal"[\s\S]*目标模式[\s\S]*id="modePlan"[\s\S]*计划模式/);
  assert.match(source, /selectTurnMode\('plan'\)/);
  assert.match(source, /selectTurnMode\('goal'\)/);
  assert.match(source, /function selectTurnMode[\s\S]*ui\.prompt\.blur\(\)/);
  assert.doesNotMatch(source, /if \(selectedTurnMode !== 'normal'\) ui\.prompt\.focus/);
  assert.match(source, /rpc\('turn\.start', \{ threadId: selectedThreadId, text, attachmentIds, mode: turnMode, clientRequestId \}\)/);
  assert.match(source, /rpc\('turn\.queue', \{ threadId, text, attachmentIds: localItem\.attachmentIds, mode, clientRequestId \}\)/);
  assert.match(stylesheet, /\.composer-tools-menu/);
  assert.match(stylesheet, /\.composer-mode\s*\{[\s\S]*position: static/);
  assert.match(stylesheet, /\.turn-mode-badge\.goal/);
});

test('locks sending before weak-network checks and attaches an idempotency key', async () => {
  const source = await readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8');
  assert.match(source, /sending = true; refreshComposerAvailability\(\); renderAttachmentTray\(\);\s*await loadUsage\(true\)/);
  assert.match(source, /rpc\('turn\.start', \{[^}]*clientRequestId \}\)/);
  assert.match(source, /rpc\('turn\.queue', \{[^}]*clientRequestId \}\)/);
  assert.match(source, /globalThis\.crypto\?\.randomUUID/);
});

test('deduplicates local and official queue representations by message content and attachments', async () => {
  const source = await readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8');
  assert.match(source, /function queueItemFingerprint\(item\)/);
  assert.match(source, /replace\(\/\\s\+\/g, ' '\)\.trim\(\)/);
  assert.match(source, /function mergeQueueItems\(\.\.\.groups\)/);
  assert.match(source, /items: mergeQueueItems\(next\.items, officialQueueItems, pendingItems\)/);
  assert.doesNotMatch(source, /externalItems = officialQueueItems\.filter\(\(item\) => !next\.items\.some\(\(queued\) => queued\.id === item\.id\)\)/);
});

test('periodically reconciles a long-open task list with the official client', async () => {
  const source = await readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8');
  assert.match(source, /setInterval\(\(\) => \{[\s\S]*connectionOnline && !threadOpening[\s\S]*loadThreads\(\)[\s\S]*10_000/);
});

test('hides task rename controls, shows running task activity and filters internal git directives', async () => {
  const script = await readFile(path.join(projectDirectory, 'src/remote-ui/remote.js'), 'utf8');
  const styles = await readFile(path.join(projectDirectory, 'src/remote-ui/remote.css'), 'utf8');
  assert.doesNotMatch(script, /renameTask = renameActionButton/);
  assert.match(script, /thread-running-indicator/);
  assert.match(styles, /@keyframes thread-running-spin/);
  assert.match(script, /git-\(\?:stage\|commit\|create-branch\|push\|create-pr\)/);
});

test('allows local blob image previews through both Web security policies', async () => {
  const [localServer, publicRelay] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote', 'remote-codex-server.ts'), 'utf8'),
    readFile(path.join(projectDirectory, 'deploy', 'relay-server', 'server.mjs'), 'utf8'),
  ]);

  assert.match(localServer, /img-src 'self' data: blob:/);
  assert.match(publicRelay, /img-src 'self' data: blob:/);
});

test('creates a new task only after the user chooses an explicit project directory', async () => {
  const [markup, source, stylesheet] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.css'), 'utf8'),
  ]);

  assert.match(markup, /id="newThreadDialog"[\s\S]*选择项目目录/);
  assert.match(markup, /id="projectDirectoryList"[\s\S]*id="browseProjectDirectory"[\s\S]*id="directoryBrowser"/);
  assert.match(source, /newThread\.addEventListener\('click', openNewThreadDialog\)/);
  assert.match(source, /function collectProjectDirectories\(\)[\s\S]*threadCache\.values\(\)/);
  assert.match(source, /rpc\('thread\.create', \{ cwd \}\)/);
  assert.doesNotMatch(markup, /id="projectPathInput"|请输入这台电脑上的完整路径/);
  assert.match(markup, /id="createProjectDirectory"[^>]*>创建/);
  assert.match(source, /rpc\('project\.directory\.create', \{ path: projectPath \}/);
  assert.match(source, /rpc\('project\.directory\.list', \{ path: directoryPath \}/);
  assert.match(source, /rpc\('project\.directory\.root'/);
  assert.match(source, /function parentDirectoryPath\(value, boundary\)/);
  assert.match(source, /ui\.directoryPickerView\.classList\.add\('hidden'\)/);
  assert.match(source, /ui\.directoryBrowserUp\.disabled = browsingDirectory \|\| atRoot/);
  assert.match(stylesheet, /\.project-directory-option\.selected/);
  assert.match(stylesheet, /\.project-directory-browse/);
  assert.match(stylesheet, /\.directory-browser-list/);
  assert.match(stylesheet, /grid-template-rows: auto auto minmax\(0, 1fr\) auto auto/);
});

test('opens the most recently visited task automatically and locks mobile zoom', async () => {
  const [markup, source, stylesheet] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.css'), 'utf8'),
  ]);
  assert.match(markup, /maximum-scale=1, user-scalable=no, viewport-fit=cover/);
  assert.match(source, /gpttool:recent-thread:/);
  assert.match(source, /items\.find\(\(thread\) => thread\.id === rememberedId\) \|\| items\[0\]/);
  assert.match(source, /rememberRecentThreadId\(threadId\)/);
  assert.match(source, /gesturestart/);
  assert.match(stylesheet, /overscroll-behavior-x:\s*none/);
  assert.match(stylesheet, /grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto/);
});

test('renames official task titles without offering project-directory rename', async () => {
  const [markup, source, stylesheet] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'remote-ui', 'remote.css'), 'utf8'),
  ]);

  assert.match(markup, /id="renameDialog"[\s\S]*重命名任务[\s\S]*id="renameInput"/);
  assert.match(source, /rpc\('thread\.rename', \{ threadId: renameContext\.key, name \}/);
  assert.doesNotMatch(source, /project\.alias\.set|projectAliases|project-rename-action/);
  assert.doesNotMatch(markup, /恢复目录原名|项目显示名称/);
  assert.match(stylesheet, /\.thread-row[\s\S]*display: flex/);
  assert.match(stylesheet, /\.rename-dialog/);
});
