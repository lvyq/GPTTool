import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import { validateRules, type CdpOperationRules } from '../codex/cdp-rules.ts';
import type { CollectorSettingsInput, CollectorSettingsView } from './contracts.ts';
import { CdpRuleCollector, uploadRulePackage } from './rule-collector.ts';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENDPOINT = 'https://www.ebbbe.com/astergate/api/admin/cdp-rules';
app.setName('GPTTool CDP Rule Collector');
let window: BrowserWindow | undefined;
let collector: CdpRuleCollector;

interface StoredSettings {
  uploadEndpoint: string;
  platform: string;
  priority: number;
  autoUpload: boolean;
  encryptedToken?: string;
}

void bootstrap().catch((error) => {
  console.error(`CDP collector bootstrap failed: ${formatError(error)}`);
  app.exit(1);
});

async function bootstrap(): Promise<void> {
  await app.whenReady();
  if (process.argv.includes('--configure-upload-token-stdin')) {
    await configureUploadTokenFromStdin();
    app.quit();
    return;
  }
  collector = new CdpRuleCollector({ toolVersion: app.getVersion() });
  registerIpc();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length ? window?.show() : createWindow());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

async function configureUploadTokenFromStdin(): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统安全存储不可用');
  let token = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    token += chunk;
    if (token.length > 4096) throw new Error('上传令牌过长');
  }
  token = token.trim();
  if (!token) throw new Error('没有从标准输入收到上传令牌');
  const settings = await loadSettings();
  settings.encryptedToken = safeStorage.encryptString(token).toString('base64');
  settings.autoUpload = true;
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  console.log('GPTTool CDP collector upload token configured in system secure storage; automatic upload enabled');
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 760,
    minHeight: 620,
    title: 'GPTTool CDP 规则采集器',
    backgroundColor: '#070908',
    webPreferences: {
      preload: path.join(moduleDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadFile(path.join(moduleDirectory, '..', 'collector-ui', 'index.html'));
  if (process.env.GPTTOOL_COLLECTOR_SMOKE_TEST === '1') {
    window.webContents.once('did-finish-load', () => {
      void window?.webContents.executeJavaScript(`({
        title: document.querySelector('h1')?.textContent,
        collectAction: document.querySelector('#collect')?.textContent,
        exportAction: document.querySelector('#exportRules')?.textContent,
        apiReady: typeof window.cdpCollector?.inspect === 'function'
      })`).then((result: unknown) => console.log(`GPTTOOL_COLLECTOR_SMOKE_OK ${JSON.stringify(result)}`))
        .catch((error: unknown) => { console.error(`GPTTOOL_COLLECTOR_SMOKE_FAILED ${formatError(error)}`); process.exitCode = 1; })
        .finally(() => app.quit());
    });
  }
}

function registerIpc(): void {
  ipcMain.handle('collector:inspect', () => collector.inspect());
  ipcMain.handle('collector:settings:load', async () => settingsView(await loadSettings()));
  ipcMain.handle('collector:settings:save', async (_event, input: CollectorSettingsInput) => {
    const current = await loadSettings();
    const next: StoredSettings = {
      uploadEndpoint: validateEndpoint(input.uploadEndpoint),
      platform: ['all', 'darwin', 'win32'].includes(input.platform) ? input.platform : process.platform,
      priority: Math.max(-1000, Math.min(1000, Math.trunc(Number(input.priority) || 0))),
      autoUpload: Boolean(input.autoUpload),
      encryptedToken: current.encryptedToken,
    };
    if (input.clearToken) delete next.encryptedToken;
    else if (input.uploadToken?.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统安全存储不可用，上传令牌不会以明文保存');
      next.encryptedToken = safeStorage.encryptString(input.uploadToken.trim()).toString('base64');
    }
    await writeFile(settingsPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
    return settingsView(next);
  });
  ipcMain.handle('collector:collect', async (_event, input: { consent?: boolean; restartClient?: boolean }) => {
    if (input?.consent !== true) throw new Error('请勾选并确认本次采集授权');
    if (input.restartClient) {
      const choice = await dialog.showMessageBox(window!, {
        type: 'warning',
        buttons: ['取消', '允许重启并采集'],
        defaultId: 0,
        cancelId: 0,
        title: '确认重启官方客户端',
        message: '采集器需要重启官方 ChatGPT 并仅在本机开启 CDP。未保存的输入可能丢失。',
        detail: '不会采集聊天正文、附件、Cookie、登录令牌或原始页面内容。',
      });
      if (choice.response !== 1) throw new Error('已取消采集');
    }
    const rules = await collector.collect({ consent: true, restartClient: Boolean(input.restartClient) });
    const settings = await loadSettings();
    if (!settings.autoUpload) return { rules, uploaded: false };
    try {
      const uploaded = await upload(rules, settings);
      return { rules, uploaded: true, uploadMessage: `规则 ${uploaded.id} 已上传` };
    } catch (error) {
      return { rules, uploaded: false, uploadMessage: `自动上传失败：${formatError(error)}。规则仍可导出。` };
    }
  });
  ipcMain.handle('collector:export', async (_event, value: unknown) => {
    const rules = requireRules(value);
    const result = await dialog.showSaveDialog(window!, {
      title: '导出 CDP 规则包',
      defaultPath: `${rules.id}.json`,
      filters: [{ name: 'GPTTool CDP 规则', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return undefined;
    await writeFile(result.filePath, `${JSON.stringify(rules, null, 2)}\n`, { mode: 0o600 });
    return result.filePath;
  });
  ipcMain.handle('collector:import', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: '导入 CDP 规则包',
      properties: ['openFile'],
      filters: [{ name: 'GPTTool CDP 规则', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return undefined;
    return requireRules(JSON.parse(await readFile(result.filePaths[0], 'utf8')));
  });
  ipcMain.handle('collector:upload', async (_event, value: unknown) => upload(requireRules(value), await loadSettings()));
}

async function upload(rules: CdpOperationRules, settings: StoredSettings): Promise<{ ok: true; id: string }> {
  return uploadRulePackage({
    endpoint: settings.uploadEndpoint,
    token: decryptToken(settings),
    rules,
    platform: settings.platform,
    priority: settings.priority,
  });
}

async function loadSettings(): Promise<StoredSettings> {
  try {
    const value = JSON.parse(await readFile(settingsPath(), 'utf8')) as StoredSettings;
    return {
      uploadEndpoint: validateEndpoint(value.uploadEndpoint),
      platform: ['all', 'darwin', 'win32'].includes(value.platform) ? value.platform : process.platform,
      priority: Number(value.priority) || 0,
      autoUpload: Boolean(value.autoUpload),
      encryptedToken: value.encryptedToken,
    };
  } catch {
    return { uploadEndpoint: DEFAULT_ENDPOINT, platform: process.platform, priority: 100, autoUpload: false };
  }
}

function settingsView(settings: StoredSettings): CollectorSettingsView {
  return { ...settings, tokenConfigured: Boolean(settings.encryptedToken), encryptedToken: undefined } as CollectorSettingsView;
}

function decryptToken(settings: StoredSettings): string {
  if (!settings.encryptedToken || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(settings.encryptedToken, 'base64')); }
  catch { return ''; }
}

function settingsPath(): string { return path.join(app.getPath('userData'), 'collector-settings.json'); }
function validateEndpoint(value: string): string {
  const url = new URL(String(value || DEFAULT_ENDPOINT));
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('上传地址必须使用 HTTPS');
  return url.toString();
}
function requireRules(value: unknown): CdpOperationRules {
  const rules = validateRules(value, (value as CdpOperationRules | undefined)?.exactOfficialVersion);
  if (!rules) throw new Error('规则文件格式无效或包含不安全的选择器');
  return rules;
}
function formatError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
