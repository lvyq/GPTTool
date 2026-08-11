import { constants as fsConstants } from 'node:fs';
import { access, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray,
  powerSaveBlocker,
  type MenuItemConstructorOptions, type MessageBoxOptions,
} from 'electron';
import { ApplicationOrchestrator } from '../app/orchestrator.ts';
import { configScopeChanged, ConfigStore, normalizeConfig, type AppConfig, validateConfig } from '../config/app-config.ts';
import type { DesktopStatus } from './contracts.ts';
import { RemoteCodexServer } from '../remote/remote-codex-server.ts';
import { OfficialClientProbe } from '../codex/official-client-probe.ts';
import { RemoteRelayClient } from '../remote/remote-relay-client.ts';
import { createRelayPairing, relayPortalUrl } from '../remote/relay-pairing.ts';
import { createPairingQrCode, createRemoteQrCode } from './remote-qr.ts';
import { UpdateManager } from './update-manager.ts';
import type { OfficialCompatibilityReport } from '../codex/compatibility.ts';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
// Self-hosted builds provide their own signed update feed. The invalid domain
// deliberately prevents an unconfigured public build from contacting the
// maintainer's private infrastructure.
const UPDATE_MANIFEST_URL = process.env.GPTTOOL_UPDATE_MANIFEST_URL
  || 'https://updates.invalid/gpttool/latest.json';
const UPDATE_PUBLIC_KEY = process.env.GPTTOOL_UPDATE_PUBLIC_KEY || '';
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let orchestrator: ApplicationOrchestrator | undefined;
let config: AppConfig;
let status: DesktopStatus = {
  codexState: 'stopped', connectionMode: 'hybrid', message: '请选择连接模式并启动远程控制', remoteUrls: [],
  officialClient: { state: 'not-applicable', message: '尚未检测官方客户端' },
};
const officialClientProbe = new OfficialClientProbe();
let remoteServer: RemoteCodexServer | undefined;
let relayClient: RemoteRelayClient | undefined;
let shutdownStarted = false;
let allowQuit = false;
let configStore: ConfigStore;
let updateManager: UpdateManager;
let compatibilityMonitor: NodeJS.Timeout | undefined;
let cdpHealthFailures = 0;
let relaySnapshot: import('../remote/remote-relay-client.ts').PersistentRelayRecord[] = [];
let powerSaveBlockerId: number | undefined;

void bootstrap().catch((error) => {
  console.error(`GPTTool bootstrap failed: ${formatError(error)}`);
  app.exit(1);
});

async function bootstrap(): Promise<void> {
  await app.whenReady();
  await migrateLegacyUserData();
  configStore = new ConfigStore(app.getPath('userData'));
  config = await configStore.load();
  if (!config.launchAtLogin) config = await configStore.save({ ...config, launchAtLogin: true });
  applyKeepComputerAwake();
  status = { ...status, connectionMode: config.codexConnectionMode };
  updateManager = new UpdateManager({
    currentVersion: app.getVersion(),
    platform: process.platform,
    userDataDirectory: app.getPath('userData'),
    executablePath: app.getPath('exe'),
    manifestUrl: UPDATE_MANIFEST_URL,
    publicKey: UPDATE_PUBLIC_KEY,
    autoUpdate: config.autoUpdate && Boolean(UPDATE_PUBLIC_KEY),
    onStatus: (updateStatus) => mainWindow?.webContents.send('updates:status-changed', updateStatus),
  });

  registerIpc();
  createWindow();
  createTray();
  applyLaunchAtLogin();
  await startStandbyRelay().catch((error) => console.warn(`Standby relay unavailable: ${formatError(error)}`));
  if (app.isPackaged) updateManager.start();
  compatibilityMonitor = setInterval(() => void monitorOfficialClientCompatibility(), 20_000);
  compatibilityMonitor.unref();

  if (process.argv.includes('--start-codex') || process.env.GPTTOOL_START_CODEX === '1') {
    await startCodex().catch((error) => console.error(`Failed to auto-start Codex control: ${formatError(error)}`));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') mainWindow = undefined;
  });

  app.on('before-quit', (event) => {
    if (allowQuit) return;
    event.preventDefault();
    void shutdownAndQuit();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 520,
    minWidth: 640,
    minHeight: 480,
    frame: false,
    title: 'GPTTool',
    backgroundColor: '#090b0a',
    show: false,
    webPreferences: {
      preload: path.join(moduleDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void mainWindow.loadFile(path.join(moduleDirectory, '..', 'renderer', 'index.html'));
  if (process.env.ASTERGATE_SMOKE_TEST === '1') {
    setTimeout(() => {
      void mainWindow?.webContents.executeJavaScript(`({
        title: document.querySelector('h1')?.textContent,
        codexAction: document.querySelector('#codexAction')?.textContent,
        modeChoices: document.querySelectorAll('[data-mode]').length,
        qrAction: document.querySelector('#showRemoteQr')?.textContent,
        apiReady: typeof window.asterGate?.getStatus === 'function',
        qrApiReady: typeof window.asterGate?.getRemoteQrCode === 'function',
        updateApiReady: typeof window.asterGate?.checkForUpdates === 'function'
      })`).then((result: unknown) => {
        console.log(`ASTERGATE_SMOKE_OK ${JSON.stringify(result)}`);
      }).catch((error: unknown) => {
        console.error(`ASTERGATE_SMOKE_FAILED ${formatError(error)}`);
        process.exitCode = 1;
      }).finally(() => {
        allowQuit = true;
        app.quit();
      });
    }, 1_500);
  }
  mainWindow.once('ready-to-show', () => { if (!shouldStartHidden()) mainWindow?.show(); });
  mainWindow.on('close', (event) => {
    if (allowQuit) return;
    event.preventDefault();
    mainWindow?.hide();
  });
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(moduleDirectory, '..', 'renderer', 'gpttool-logo.png'));
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
  tray.setToolTip('GPTTool');
  tray.on('click', showWindow);
  updateTrayMenu();
}

function updateTrayMenu(): void {
  const codexRunning = status.codexState === 'running';
  const codexBusy = status.codexState === 'starting' || status.codexState === 'stopping';
  const template: MenuItemConstructorOptions[] = [
    { label: `远程控制：${codexRunning ? '运行中' : '已停止'}`, enabled: false },
    { type: 'separator' },
    { label: '显示主窗口', click: showWindow },
    { label: codexRunning ? '停止 Codex 控制' : '启动 Codex 控制', enabled: !codexBusy, click: () => void (codexRunning ? stopCodex() : startCodex()) },
    { type: 'separator' },
    { label: '退出', click: () => void shutdownAndQuit() },
  ];
  tray?.setContextMenu(Menu.buildFromTemplate(template));
}

function showWindow(): void {
  if (!mainWindow) createWindow();
  mainWindow?.show();
  mainWindow?.focus();
}

function registerIpc(): void {
  ipcMain.handle('window:minimize', () => { mainWindow?.minimize(); });
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => { mainWindow?.hide(); });
  ipcMain.handle('config:load', () => config);
  ipcMain.handle('config:save', async (_event, next: AppConfig) => {
    const normalized = normalizeConfig(next);
    if (isServiceActive(status.codexState) && configScopeChanged('codex', config, normalized)) {
      throw new Error('Codex 控制正在运行，请先停止 Codex 控制再修改远程配置');
    }
    const saved = await configStore.save(normalized);
    config = saved;
    setStatus({ ...status, connectionMode: saved.codexConnectionMode, message: `已选择${saved.codexConnectionMode === 'hybrid' ? '官方同步' : '独立服务'}模式` });
    if (!isAnyServiceActive()) orchestrator = undefined;
    applyLaunchAtLogin();
    applyKeepComputerAwake();
    updateManager.setAutoUpdate(saved.autoUpdate);
    return saved;
  });
  ipcMain.handle('service:status', () => status);
  ipcMain.handle('codex:start', () => startCodex());
  ipcMain.handle('codex:stop', () => stopCodex());
  ipcMain.handle('codex:inspect-client', async () => {
    const officialClient = await officialClientProbe.inspect(config.codexExecutable);
    setStatus({ ...status, officialClient });
    return officialClient;
  });
  ipcMain.handle('dialog:file', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择 Codex 可执行文件',
      properties: ['openFile'],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle('dialog:directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择默认项目目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle('notices:open', async () => {
    const noticePath = app.isPackaged
      ? path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES.md')
      : path.join(moduleDirectory, '..', '..', 'THIRD_PARTY_NOTICES.md');
    await shell.openPath(noticePath);
  });
  ipcMain.handle('remote:qr-code', async () => {
    const url = preferredRemoteUrl();
    if (!url) throw new Error('请先启动远程 Codex');
    return createRemoteQrCode(url);
  });
  ipcMain.handle('remote:pairing-qr-code', async () => {
    const pairing = await createRelayPairing({
      relayUrl: config.relayUrl,
      deviceName: config.relayDeviceName,
      deviceId: config.relayDeviceId,
      deviceToken: config.relayDeviceToken,
    });
    config = await configStore.save({
      ...config,
      relayDeviceId: pairing.deviceId,
      relayDeviceToken: pairing.deviceToken,
      relayPairingCode: pairing.pairingCode,
    });
    setStatus({
      ...status,
      relayPairingCode: pairing.pairingCode,
      relayPortalUrl: pairing.portalUrl,
      message: '新的配对二维码已生成，10 分钟内有效',
    });
    return createPairingQrCode(pairing.portalUrl, pairing.pairingCode);
  });
  ipcMain.handle('remote:open-url', async () => {
    const url = status.publicRemoteUrl;
    if (!url) throw new Error('公网入口尚未就绪，请等待中继连接后重试');
    await shell.openExternal(url);
  });
  ipcMain.handle('remote:open-portal', async () => {
    await shell.openExternal(relayPortalUrl(config.relayUrl));
  });
  ipcMain.handle('updates:status', () => updateManager.status);
  ipcMain.handle('updates:check', () => updateManager.check({ downloadWhenAvailable: false }));
  ipcMain.handle('updates:download', () => updateManager.download());
  ipcMain.handle('updates:install', async () => {
    const updateStatus = await updateManager.scheduleInstall();
    setTimeout(() => void shutdownAndQuit(), 180);
    return updateStatus;
  });
}

function ensureOrchestrator(): ApplicationOrchestrator {
  orchestrator ??= new ApplicationOrchestrator({
    executable: config.codexExecutable,
    clientVersion: app.getVersion(),
    connectionMode: config.codexConnectionMode,
  });
  return orchestrator;
}

async function startCodex(options: { remote?: boolean } = {}): Promise<DesktopStatus> {
  if (status.codexState === 'running' || status.codexState === 'starting') return status;
  const errors = validateConfig(config);
  if (errors.length) throw new Error(errors.join('\n'));
  await access(config.codexExecutable, fsConstants.X_OK).catch(() => { throw new Error('Codex 可执行文件不存在或不可执行'); });
  setStatus({ ...status, codexState: 'starting', connectionMode: config.codexConnectionMode, message: config.codexConnectionMode === 'hybrid' ? '正在连接官方 ChatGPT…' : '正在启动独立 Codex 服务…' });
  try {
    if (!config.relayDeviceId || !config.relayDeviceToken) {
      const pairing = await createRelayPairing({
        relayUrl: config.relayUrl, deviceName: config.relayDeviceName,
        deviceId: config.relayDeviceId, deviceToken: config.relayDeviceToken,
      });
      config = await configStore.save({
        ...config, relayDeviceId: pairing.deviceId, relayDeviceToken: pairing.deviceToken, relayPairingCode: pairing.pairingCode,
      });
      setStatus({ ...status, codexState: 'starting', relayPairingCode: pairing.pairingCode, relayPortalUrl: pairing.portalUrl, message: '请使用手机设备中心扫描配对二维码' });
    }
    await startStandbyRelay();
    relayClient?.updateServiceState('starting', '正在启动远程控制…');
    const inspectedClient = await officialClientProbe.inspect(config.codexExecutable);
    let officialClient = inspectedClient;
    if (config.codexConnectionMode === 'hybrid' && inspectedClient.state === 'running' && !inspectedClient.cdpReady) {
      const restartDialog: MessageBoxOptions = {
        type: 'question',
        title: '重新启动 ChatGPT 以启用远程控制',
        message: '官方 ChatGPT 当前以普通模式运行',
        detail: 'GPTTool 需要重新启动官方客户端并启用本机 CDP。正在执行的任务会被中断，但历史记录不会丢失。是否现在重新启动？',
        buttons: ['重新启动并启用', '取消'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      if (!options.remote) {
        const confirmation = mainWindow
          ? await dialog.showMessageBox(mainWindow, restartDialog)
          : await dialog.showMessageBox(restartDialog);
        if (confirmation.response !== 0) throw new Error('已取消启用 CDP，远程 Codex 未启动');
      }
      officialClient = await officialClientProbe.restartWithCdp(config.codexExecutable, (clientStatus) => {
        setStatus({ ...status, codexState: 'starting', officialClient: clientStatus, message: clientStatus.message });
      });
    } else if (config.codexConnectionMode === 'hybrid') {
      officialClient = await officialClientProbe.ensureRunning(config.codexExecutable, (clientStatus) => {
        setStatus({ ...status, codexState: 'starting', officialClient: clientStatus, message: clientStatus.message });
      });
    }
    setStatus({ ...status, codexState: 'starting', officialClient, message: config.codexConnectionMode === 'hybrid' ? '官方同步通道已就绪，正在启动远程控制…' : '独立服务已就绪，正在建立公网通道…' });
    const service = ensureOrchestrator();
    service.configureCodex({
      executable: config.codexExecutable,
      clientVersion: app.getVersion(),
      sessionCacheDirectory: path.join(app.getPath('userData'), 'task-history-cache'),
      officialAppVersion: officialClient.appVersion,
      connectionMode: config.codexConnectionMode,
    });
    await service.startCodex();
    // Passive background handshake only: do not navigate, open a task, click
    // controls or show a separate compatibility-testing phase to the user.
    const compatibility = await service.codex.verifyCompatibility(config.codexWorkingDirectory || app.getPath('documents'));
    const pendingRelayState = new Map<string, { kind: string; key: string; value: unknown }>();
    remoteServer = new RemoteCodexServer({
      codex: service.codex,
      assetsDirectory: path.join(moduleDirectory, '..', 'remote-ui'),
      stateDirectory: app.getPath('userData'),
      port: config.remotePort,
      allowLan: false,
      defaultCwd: config.codexWorkingDirectory || app.getPath('documents'),
      onPersistentStateChange: (kind, key, value) => {
        if (relayClient) relayClient.persistState(kind, key, value);
        else pendingRelayState.set(`${kind}:${key}`, { kind, key, value });
      },
    });
    await remoteServer.start();
    if (relaySnapshot.length) remoteServer.restorePersistentState(relaySnapshot);
    for (const record of pendingRelayState.values()) relayClient?.persistState(record.kind, record.key, record.value);
    pendingRelayState.clear();
    relayClient?.updateServiceState('running');
    setStatus({
      ...status,
      codexState: 'running',
      remoteUrls: remoteServer.accessUrls,
      officialClient,
      compatibility,
      message: compatibility.state === 'degraded'
        ? compatibility.message
        : config.codexConnectionMode === 'hybrid'
          ? '官方同步模式已启动，Web 与官方客户端保持实时同步'
          : '独立服务模式已启动，无需保持官方客户端窗口运行',
    });
  } catch (error) {
    await remoteServer?.stop().catch(() => undefined);
    relayClient?.updateServiceState('failed', formatError(error));
    remoteServer = undefined;
    await orchestrator?.stopCodex().catch(() => undefined);
    const compatibility = compatibilityFromError(error) ?? status.compatibility;
    let message = formatError(error);
    if (compatibility?.state === 'incompatible') {
      const update = await updateManager.check({ downloadWhenAvailable: config.autoUpdate }).catch(() => updateManager.status);
      message = update.phase === 'downloaded'
        ? `${compatibility.message} 兼容更新已下载，请在“设置”中安装。`
        : update.phase === 'available' || update.phase === 'downloading'
          ? `${compatibility.message} 正在准备兼容更新。`
          : `${compatibility.message} 当前尚无兼容更新，请稍后重试。`;
    }
    setStatus({ ...status, codexState: 'failed', remoteUrls: [], compatibility, message });
    throw error;
  }
  return status;
}

async function stopCodex(): Promise<DesktopStatus> {
  if (status.codexState === 'stopped' || status.codexState === 'stopping') return status;
  setStatus({ ...status, codexState: 'stopping', message: '正在停止 Codex 控制…' });
  try {
    await remoteServer?.stop();
    remoteServer = undefined;
    await orchestrator?.stopCodex();
    relayClient?.updateServiceState('standby', 'GPTTool 后台在线，可远程启动');
    setStatus({ ...status, codexState: 'stopped', remoteUrls: [], relayPairingCode: undefined, message: '远程控制已停止，后台唤醒服务仍在线' });
  } catch (error) {
    setStatus({ ...status, codexState: 'failed', message: `Codex 停止失败：${formatError(error)}` });
    throw error;
  }
  return status;
}

async function monitorOfficialClientCompatibility(): Promise<void> {
  if (status.codexState !== 'running') { cdpHealthFailures = 0; return; }
  if (config.codexConnectionMode === 'app-server') {
    cdpHealthFailures = 0;
    return;
  }
  const inspected = await officialClientProbe.inspect(config.codexExecutable).catch(() => undefined);
  if (inspected?.state === 'running' && inspected.cdpReady) {
    cdpHealthFailures = 0;
    if (inspected.appVersion !== status.officialClient.appVersion) {
      setStatus({ ...status, officialClient: inspected });
    }
    return;
  }
  cdpHealthFailures += 1;
  if (cdpHealthFailures < 2) return;
  cdpHealthFailures = 0;
  const compatibility: OfficialCompatibilityReport = {
    state: 'incompatible',
    mode: 'blocked',
    checkedAt: new Date().toISOString(),
    officialAppVersion: inspected?.appVersion,
    features: [{ id: 'cdp-connection', label: '官方客户端连接', required: true, available: false }],
    message: '官方 ChatGPT 已退出、更新或失去受控连接。GPTTool 已停止接收远程操作，重新启动时会再次检查兼容性。',
  };
  await remoteServer?.stop().catch(() => undefined);
  remoteServer = undefined;
  relayClient?.updateServiceState('failed', compatibility.message);
  await orchestrator?.stopCodex().catch(() => undefined);
  const update = await updateManager.check({ downloadWhenAvailable: config.autoUpdate }).catch(() => updateManager.status);
  setStatus({
    ...status,
    codexState: 'failed',
    remoteUrls: [],
    officialClient: inspected ?? status.officialClient,
    compatibility,
    message: update.phase === 'downloaded'
      ? `${compatibility.message} 已下载 GPTTool 更新，请安装后重试。`
      : compatibility.message,
  });
}

function compatibilityFromError(error: unknown): OfficialCompatibilityReport | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const report = (error as { compatibility?: OfficialCompatibilityReport }).compatibility;
  return report?.state ? report : undefined;
}

function isAnyServiceActive(): boolean {
  return isServiceActive(status.codexState);
}

function isServiceActive(value: string): boolean {
  return ['running', 'starting', 'stopping'].includes(value);
}

function setStatus(next: DesktopStatus): void {
  status = next;
  mainWindow?.webContents.send('service:status-changed', status);
  updateTrayMenu();
}

async function startStandbyRelay(): Promise<void> {
  if (relayClient?.running || !config.relayDeviceId || !config.relayDeviceToken) return;
  relayClient = new RemoteRelayClient({
    relayUrl: config.relayUrl,
    deviceToken: config.relayDeviceToken,
    deviceId: config.relayDeviceId,
    resolveLocalEndpoint: () => remoteServer ? { port: remoteServer.port, token: remoteServer.token } : undefined,
    onCommand: async (command) => {
      if (command !== 'start') throw new Error('不支持的远程指令');
      await startCodex({ remote: true });
    },
    onPublicUrl: (publicRemoteUrl) => {
      setStatus({
        ...status, publicRemoteUrl,
        relayPairingCode: config.relayPairingCode || undefined,
        relayPortalUrl: relayPortalUrl(config.relayUrl),
        message: status.codexState === 'running' ? '公网远程 Codex 已连接' : '后台唤醒服务已在线',
      });
    },
    onState: (relayState, relayMessage) => {
      if (relayState !== 'disconnected') return;
      setStatus({ ...status, publicRemoteUrl: undefined, message: relayMessage || '公网中继已断开，正在自动重连' });
    },
    onPersistentState: (records) => {
      relaySnapshot = records;
      remoteServer?.restorePersistentState(records);
    },
  });
  relayClient.start();
  relayClient.updateServiceState(status.codexState === 'running' ? 'running' : 'standby', status.message);
}

function shouldStartHidden(): boolean {
  return process.argv.includes('--background') || process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
}

function applyLaunchAtLogin(): void {
  if (!app.isPackaged) return;
  if (!config.launchAtLogin && !app.getLoginItemSettings().openAtLogin) return;
  app.setLoginItemSettings({ openAtLogin: config.launchAtLogin, openAsHidden: true, args: ['--background'] });
}

function applyKeepComputerAwake(): void {
  if (config.keepComputerAwake) {
    if (powerSaveBlockerId === undefined || !powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      // Keep the OS and relay network connection responsive while preserving
      // the user's normal display-off and lock-screen behaviour.
      powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
    return;
  }
  releaseKeepComputerAwake();
}

function releaseKeepComputerAwake(): void {
  if (powerSaveBlockerId !== undefined && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId);
  }
  powerSaveBlockerId = undefined;
}

async function shutdownAndQuit(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  releaseKeepComputerAwake();
  updateManager?.stop();
  try {
    await remoteServer?.stop();
    remoteServer = undefined;
    await relayClient?.stop();
    relayClient = undefined;
    await orchestrator?.stopAll();
  } finally {
    allowQuit = true;
    app.quit();
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preferredRemoteUrl(): string | undefined {
  return status.publicRemoteUrl;
}

async function migrateLegacyUserData(): Promise<void> {
  const target = app.getPath('userData');
  const legacy = path.join(app.getPath('appData'), 'astergate-desktop');
  if (path.resolve(target) === path.resolve(legacy)) return;
  await mkdir(target, { recursive: true });
  for (const name of ['settings.json', 'remote-access-token']) {
    const source = path.join(legacy, name);
    const destination = path.join(target, name);
    if (await access(destination).then(() => true, () => false)) continue;
    await cp(source, destination, { recursive: true, errorOnExist: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error;
    });
  }
}
