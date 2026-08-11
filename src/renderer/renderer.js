const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  'pageTitle','statusPill','statusDot','sideStatus','statusMessage','codexAction','modeNote','remoteHint','entryState',
  'openRemote','showPairingQr','openPortal','pairingTitle','pairingHint','bindingState','bindingDot','settingsForm','codexExecutable',
  'codexWorkingDirectory','relayDeviceName','autoUpdate','launchAtLogin','keepComputerAwake','pickCodex','pickDirectory','formMessage',
  'updateTitle','updateDetail','updateAction','openNotices','qrDialog','closeQr','qrKicker','qrTitle','qrImage','qrUrl','qrActions','qrOpenLocal',
  'windowBar','windowMinimize','windowMaximize','windowClose',
].map((id) => [id, $(id)]));

let config = await window.asterGate.loadConfig();
let status = await window.asterGate.getStatus();
let updateStatus = await window.asterGate.getUpdateStatus();
let boundConfirmed = Boolean(status.publicRemoteUrl);
fillConfig(); renderStatus(status); renderUpdate(updateStatus); selectMode(config.codexConnectionMode, false);

window.asterGate.onStatus((next) => { status = next; renderStatus(next); });
window.asterGate.onUpdateStatus((next) => { updateStatus = next; renderUpdate(next); });

elements.windowMinimize.addEventListener('click', () => window.asterGate.minimizeWindow());
elements.windowMaximize.addEventListener('click', async () => renderMaximizeState(await window.asterGate.toggleMaximizeWindow()));
elements.windowClose.addEventListener('click', () => window.asterGate.closeWindow());
elements.windowBar.addEventListener('dblclick', async (event) => {
  if (event.target.closest('.window-controls')) return;
  renderMaximizeState(await window.asterGate.toggleMaximizeWindow());
});

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', async () => {
  if (isBusy(status.codexState)) return;
  await selectMode(button.dataset.mode, true);
}));

elements.codexAction.addEventListener('click', async () => run(async () => {
  status = status.codexState === 'running' ? await window.asterGate.stopCodex() : await window.asterGate.startCodex();
}));
elements.openRemote.addEventListener('click', () => showQr('remote'));
elements.showPairingQr.addEventListener('click', () => showQr('pairing'));
elements.openPortal.addEventListener('click', () => run(() => window.asterGate.openRelayPortal()));
elements.qrOpenLocal.addEventListener('click', () => run(() => window.asterGate.openRemoteUrl()));
elements.closeQr.addEventListener('click', () => elements.qrDialog.close());
elements.qrDialog.addEventListener('click', (event) => { if (event.target === elements.qrDialog) elements.qrDialog.close(); });
elements.pickCodex.addEventListener('click', async () => { const value = await window.asterGate.chooseFile(); if (value) elements.codexExecutable.value = value; });
elements.pickDirectory.addEventListener('click', async () => { const value = await window.asterGate.chooseDirectory(); if (value) elements.codexWorkingDirectory.value = value; });
elements.openNotices.addEventListener('click', () => window.asterGate.openNotices());
elements.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await run(async () => {
    config = await window.asterGate.saveConfig({
      ...config,
      codexExecutable: elements.codexExecutable.value,
      codexWorkingDirectory: elements.codexWorkingDirectory.value,
      relayDeviceName: elements.relayDeviceName.value,
      autoUpdate: elements.autoUpdate.checked,
      launchAtLogin: elements.launchAtLogin.checked,
      keepComputerAwake: elements.keepComputerAwake.checked,
    });
    elements.formMessage.textContent = '设置已保存';
  });
});
elements.updateAction.addEventListener('click', async () => run(async () => {
  if (updateStatus.phase === 'downloaded') updateStatus = await window.asterGate.installUpdate();
  else if (updateStatus.phase === 'available') updateStatus = await window.asterGate.downloadUpdate();
  else updateStatus = await window.asterGate.checkForUpdates();
  renderUpdate(updateStatus);
}));

async function selectMode(mode, persist) {
  config.codexConnectionMode = mode === 'app-server' ? 'app-server' : 'hybrid';
  document.querySelectorAll('[data-mode]').forEach((button) => {
    const selected = button.dataset.mode === config.codexConnectionMode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  });
  elements.modeNote.innerHTML = config.codexConnectionMode === 'hybrid'
    ? '<b>推荐</b><span>需要和官方 ChatGPT 客户端实时同步时使用。</span>'
    : '<b>更稳定</b><span>完全使用 app-server，不操作官方客户端界面；官方桌面端不会实时出现 Web 消息。</span>';
  elements.codexAction.textContent = `启动${config.codexConnectionMode === 'hybrid' ? '官方同步' : '独立服务'}`;
  if (persist) {
    config = await window.asterGate.saveConfig(config);
    status = await window.asterGate.getStatus();
    renderStatus(status);
  }
}

function fillConfig() {
  elements.codexExecutable.value = config.codexExecutable;
  elements.codexWorkingDirectory.value = config.codexWorkingDirectory;
  elements.relayDeviceName.value = config.relayDeviceName;
  elements.autoUpdate.checked = config.autoUpdate;
  elements.launchAtLogin.checked = config.launchAtLogin;
  elements.keepComputerAwake.checked = config.keepComputerAwake;
}

function renderMaximizeState(maximized) {
  elements.windowMaximize.classList.toggle('restore', maximized);
  elements.windowMaximize.setAttribute('aria-label', maximized ? '还原窗口' : '最大化');
  elements.windowMaximize.title = maximized ? '还原窗口' : '最大化';
}

function renderStatus(next) {
  const labels = { stopped:'已停止', starting:'启动中', running:'运行中', stopping:'停止中', failed:'异常' };
  const running = next.codexState === 'running';
  const busy = ['starting','stopping'].includes(next.codexState);
  elements.statusPill.textContent = labels[next.codexState] || next.codexState;
  elements.statusPill.className = `status-pill ${next.codexState}`;
  elements.statusDot.className = running ? 'live' : next.codexState === 'failed' ? 'failed' : '';
  elements.sideStatus.textContent = running ? `${next.connectionMode === 'hybrid' ? '官方同步' : '独立服务'}运行中` : '远程控制未启动';
  elements.statusMessage.textContent = next.message;
  elements.codexAction.disabled = busy;
  elements.codexAction.textContent = running ? '停止远程控制' : busy ? labels[next.codexState] : `启动${config.codexConnectionMode === 'hybrid' ? '官方同步' : '独立服务'}`;
  document.querySelectorAll('[data-mode]').forEach((button) => { button.disabled = isBusy(next.codexState); });
  if (next.publicRemoteUrl) boundConfirmed = true;
  elements.remoteHint.textContent = next.publicRemoteUrl ? '手机扫码或在本机浏览器打开' : '正在连接公网入口';
  elements.entryState.textContent = next.publicRemoteUrl ? running ? '控制已启动' : '后台在线' : '正在连接';
  elements.openRemote.disabled = !next.publicRemoteUrl;
  elements.showPairingQr.disabled = false;
  elements.bindingState.textContent = boundConfirmed ? '当前电脑已绑定到账户' : '正在确认绑定状态';
  elements.bindingDot.classList.toggle('bound', boundConfirmed);
  elements.pairingTitle.textContent = boundConfirmed ? '重新生成绑定二维码' : '绑定当前电脑';
  elements.pairingHint.textContent = boundConfirmed ? '仅在需要重新确认绑定时使用' : '生成 10 分钟绑定二维码';
}

function renderUpdate(next) {
  const title = { checking:'正在检查更新', available:`发现 GPTTool ${next.availableVersion || ''}`, downloading:'正在下载更新', downloaded:'更新已准备好', error:'更新检查失败' }[next.phase] || 'GPTTool 已是最新版本';
  elements.updateTitle.textContent = title;
  elements.updateDetail.textContent = next.message || '自动更新已启用';
  elements.updateAction.textContent = next.phase === 'downloaded' ? '安装并重启' : next.phase === 'available' ? '下载' : '检查更新';
  elements.updateAction.disabled = ['checking','downloading'].includes(next.phase);
}

function showPage(name) {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === name));
  document.querySelectorAll('[data-page-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.pagePanel === name));
  elements.pageTitle.textContent = { home:'远程控制', settings:'设置' }[name];
}

async function showQr(kind) {
  await run(async () => {
    const qr = kind === 'pairing' ? await window.asterGate.getPairingQrCode() : await window.asterGate.getRemoteQrCode();
    elements.qrKicker.textContent = kind === 'pairing' ? '绑定设备' : '手机访问';
    elements.qrTitle.textContent = kind === 'pairing' ? '用手机设备中心扫描' : '扫描二维码打开 Web';
    elements.qrImage.src = qr.dataUrl;
    if (kind === 'pairing') {
      const code = new URL(qr.url).hash.replace(/^#pair=/, '');
      elements.qrUrl.textContent = '请使用手机设备中心扫描 · 10 分钟内有效';
      elements.qrActions.hidden = true;
    } else {
      elements.qrUrl.textContent = qr.url;
      elements.qrActions.hidden = false;
    }
    elements.qrDialog.showModal();
  });
}

async function run(operation) {
  try { await operation(); }
  catch (error) { flash(error?.message || String(error), true); }
}
function flash(text, error = false) { elements.statusMessage.textContent = text; elements.statusMessage.classList.toggle('error', error); setTimeout(() => elements.statusMessage.classList.remove('error'), 3000); }
function isBusy(value) { return ['running','starting','stopping'].includes(value); }
