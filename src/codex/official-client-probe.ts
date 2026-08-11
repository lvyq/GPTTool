import { access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type OfficialClientState = 'not-applicable' | 'not-installed' | 'stopped' | 'starting' | 'running' | 'unsupported';

export interface OfficialClientStatus {
  state: OfficialClientState;
  message: string;
  appPath?: string;
  cdpReady?: boolean;
  cdpPort?: number;
  appVersion?: string;
}

export interface OfficialClientProbeOptions {
  platform?: NodeJS.Platform;
  pathExists?: (candidate: string) => Promise<boolean>;
  processCommands?: () => Promise<string>;
  launchApp?: (appPath: string, arguments_: string[]) => Promise<void>;
  quitApp?: (appPath: string) => Promise<void>;
  fetch?: typeof fetch;
  cdpPort?: number;
  delay?: (milliseconds: number) => Promise<void>;
  attempts?: number;
  readAppVersion?: (appPath: string) => Promise<string | undefined>;
}

/** Checks whether the official desktop host is running with loopback-only CDP enabled. */
export class OfficialClientProbe {
  readonly #platform: NodeJS.Platform;
  readonly #pathExists: (candidate: string) => Promise<boolean>;
  readonly #processCommands: () => Promise<string>;
  readonly #launchApp: (appPath: string, arguments_: string[]) => Promise<void>;
  readonly #quitApp: (appPath: string) => Promise<void>;
  readonly #fetch: typeof fetch;
  readonly #cdpPort: number;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #attempts: number;
  readonly #readAppVersion: (appPath: string) => Promise<string | undefined>;

  constructor(options: OfficialClientProbeOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#pathExists = options.pathExists ?? (async (candidate) => access(candidate).then(() => true, () => false));
    this.#processCommands = options.processCommands ?? (() => this.#readProcessCommands());
    this.#launchApp = options.launchApp ?? ((appPath, arguments_) => this.#openApp(appPath, arguments_));
    this.#quitApp = options.quitApp ?? ((appPath) => this.#closeApp(appPath));
    this.#fetch = options.fetch ?? fetch;
    this.#cdpPort = options.cdpPort ?? 39252;
    this.#delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#attempts = options.attempts ?? 30;
    this.#readAppVersion = options.readAppVersion ?? ((appPath) => this.#readVersion(appPath));
  }

  async inspect(codexExecutable: string): Promise<OfficialClientStatus> {
    const appPath = officialAppPath(codexExecutable, this.#platform);
    if (!appPath) {
      return { state: 'unsupported', message: 'CDP 模式需要选择官方 ChatGPT 应用，不能使用独立 codex 命令' };
    }
    if (!await this.#pathExists(appPath)) {
      return { state: 'not-installed', appPath, message: `未找到官方 ChatGPT 客户端：${appPath}` };
    }
    if (!['darwin', 'win32'].includes(this.#platform)) {
      return { state: 'unsupported', appPath, message: '当前系统暂不支持官方客户端运行检测' };
    }
    const appVersion = await this.#readAppVersion(appPath).catch(() => undefined);
    const running = await this.#isRunning(appPath);
    const cdpReady = running ? await this.#isCdpReady() : false;
    return running
      ? {
          state: 'running', appPath, cdpReady, cdpPort: this.#cdpPort, appVersion,
          message: cdpReady ? '官方 ChatGPT 客户端已进入 CDP 受控模式' : '官方 ChatGPT 正在普通模式运行，需要重新启动以启用远程控制',
        }
      : { state: 'stopped', appPath, cdpReady: false, cdpPort: this.#cdpPort, appVersion, message: '官方 ChatGPT 客户端尚未运行' };
  }

  async ensureRunning(codexExecutable: string, onProgress?: (status: OfficialClientStatus) => void): Promise<OfficialClientStatus> {
    const initial = await this.inspect(codexExecutable);
    if (initial.state === 'running' && initial.cdpReady) return initial;
    if (initial.state === 'running' && !initial.cdpReady) throw restartRequiredError();
    if (initial.state !== 'stopped' || !initial.appPath) throw new Error(initial.message);

    const starting: OfficialClientStatus = { ...initial, state: 'starting', message: '正在以 CDP 受控模式启动官方 ChatGPT…' };
    onProgress?.(starting);
    await this.#launchApp(initial.appPath, cdpArguments(this.#cdpPort));
    for (let attempt = 0; attempt < this.#attempts; attempt += 1) {
      await this.#delay(500);
      const current = await this.inspect(codexExecutable);
      if (current.state === 'running' && current.cdpReady) return current;
    }
    throw new Error('官方 ChatGPT CDP 启动超时，请完全退出客户端后重试');
  }

  async restartWithCdp(codexExecutable: string, onProgress?: (status: OfficialClientStatus) => void): Promise<OfficialClientStatus> {
    const initial = await this.inspect(codexExecutable);
    if (!initial.appPath) throw new Error(initial.message);
    if (initial.state === 'running') {
      onProgress?.({ ...initial, state: 'starting', message: '正在重新启动官方 ChatGPT 以启用 CDP…' });
      await this.#quitApp(initial.appPath);
      for (let attempt = 0; attempt < this.#attempts; attempt += 1) {
        if (!(await this.#isRunning(initial.appPath))) break;
        await this.#delay(250);
      }
      if (await this.#isRunning(initial.appPath)) throw new Error('无法完全退出官方 ChatGPT，请手动退出后重试');
    }
    return this.ensureRunning(codexExecutable, onProgress);
  }

  async #isRunning(appPath: string): Promise<boolean> {
    const commands = await this.#processCommands();
    const normalized = normalizePath(appPath);
    const executableMarker = this.#platform === 'darwin' ? `${normalized}/contents/macos/` : normalized;
    return commands.split(/\r?\n/).some((command) => normalizePath(command).includes(executableMarker));
  }

  async #readProcessCommands(): Promise<string> {
    if (this.#platform === 'darwin') return (await execFileAsync('/bin/ps', ['-axo', 'command='])).stdout;
    if (this.#platform === 'win32') return (await execFileAsync('wmic.exe', ['process', 'get', 'ExecutablePath', '/value'])).stdout;
    return '';
  }

  async #readVersion(appPath: string): Promise<string | undefined> {
    if (this.#platform === 'darwin') {
      const infoPath = path.join(appPath, 'Contents', 'Info');
      const [shortVersion, buildVersion] = await Promise.all([
        execFileAsync('/usr/bin/defaults', ['read', infoPath, 'CFBundleShortVersionString']).then((result) => result.stdout.trim()),
        execFileAsync('/usr/bin/defaults', ['read', infoPath, 'CFBundleVersion']).then((result) => result.stdout.trim()),
      ]);
      return [shortVersion, buildVersion && `(${buildVersion})`].filter(Boolean).join(' ');
    }
    if (this.#platform === 'win32') {
      const escaped = appPath.replaceAll("'", "''");
      const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item '${escaped}').VersionInfo.ProductVersion`]);
      return result.stdout.trim() || undefined;
    }
    return undefined;
  }

  async #isCdpReady(): Promise<boolean> {
    try {
      const response = await this.#fetch(`http://127.0.0.1:${this.#cdpPort}/json/list`, { signal: AbortSignal.timeout(1_200) });
      if (!response.ok) return false;
      const targets = await response.json() as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
      return targets.some((target) => target.type === 'page' && Boolean(target.webSocketDebuggerUrl));
    } catch {
      return false;
    }
  }

  async #openApp(appPath: string, arguments_: string[] = []): Promise<void> {
    if (this.#platform === 'darwin') {
      await execFileAsync('/usr/bin/open', ['-a', appPath, '--args', ...arguments_]);
      return;
    }
    if (this.#platform === 'win32') {
      await execFileAsync('cmd.exe', ['/d', '/s', '/c', 'start', '', appPath, ...arguments_]);
      return;
    }
    throw new Error('当前系统不支持自动启动官方 ChatGPT 客户端');
  }

  async #closeApp(_appPath: string): Promise<void> {
    if (this.#platform === 'darwin') {
      await execFileAsync('/usr/bin/osascript', ['-e', 'tell application id "com.openai.codex" to quit']);
      return;
    }
    if (this.#platform === 'win32') {
      await execFileAsync('taskkill.exe', ['/IM', 'ChatGPT.exe', '/T']);
      return;
    }
    throw new Error('当前系统不支持自动重启官方 ChatGPT 客户端');
  }
}

export function officialAppPath(codexExecutable: string, platform = process.platform): string | undefined {
  const candidate = path.normalize(codexExecutable.trim());
  if (platform === 'darwin') {
    const marker = `${path.sep}Contents${path.sep}`;
    const markerIndex = candidate.indexOf(marker);
    if (markerIndex > 0 && candidate.slice(0, markerIndex).toLowerCase().endsWith('.app')) return candidate.slice(0, markerIndex);
    return undefined;
  }
  if (platform === 'win32') {
    const lower = candidate.toLowerCase();
    if (lower.endsWith(`${path.win32.sep}chatgpt.exe`) || lower === 'chatgpt.exe') return candidate;
    const marker = `${path.win32.sep}resources${path.win32.sep}`;
    const markerIndex = lower.lastIndexOf(marker);
    if (markerIndex > 0) return path.win32.join(candidate.slice(0, markerIndex), 'ChatGPT.exe');
    const legacyMarker = `${path.win32.sep}bin${path.win32.sep}codex.exe`;
    if (lower.endsWith(legacyMarker)) return path.win32.join(candidate.slice(0, -legacyMarker.length), 'ChatGPT.exe');
  }
  return undefined;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').toLowerCase();
}

export function cdpArguments(port = 39252): string[] {
  return [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
}

function restartRequiredError(): Error {
  const error = new Error('官方 ChatGPT 正在普通模式运行，需要重新启动后才能启用 CDP 远程控制');
  Object.assign(error, { code: 'OFFICIAL_CLIENT_RESTART_REQUIRED' });
  return error;
}
