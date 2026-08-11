import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AppConfig {
  codexExecutable: string;
  codexConnectionMode: 'hybrid' | 'app-server';
  launchAtLogin: boolean;
  keepComputerAwake: boolean;
  autoUpdate: boolean;
  remotePort: number;
  remoteAllowLan: boolean;
  codexWorkingDirectory: string;
  relayEnabled: boolean;
  relayUrl: string;
  relayDeviceToken: string;
  relayDeviceId: string;
  relayDeviceName: string;
  relayPairingCode: string;
}

export const GPTTOOL_REMOTE_PORT = 8518;
const BUILT_IN_RELAY_URL = process.env.GPTTOOL_RELAY_URL || 'wss://relay.example.com/gpttool/agent';

const CODEX_CONFIG_KEYS: Array<keyof AppConfig> = [
  'codexExecutable', 'codexConnectionMode', 'codexWorkingDirectory', 'remotePort', 'remoteAllowLan', 'relayEnabled',
  'relayUrl', 'relayDeviceToken', 'relayDeviceId', 'relayDeviceName', 'relayPairingCode',
];

export function configScopeChanged(scope: 'codex', current: AppConfig, next: AppConfig): boolean {
  return CODEX_CONFIG_KEYS.some((key) => current[key] !== next[key]);
}

export function defaultConfig(platform = process.platform, env = process.env): AppConfig {
  const codexExecutable = platform === 'darwin'
    ? '/Applications/ChatGPT.app/Contents/Resources/codex'
    : platform === 'win32' && env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'ChatGPT', 'ChatGPT.exe')
      : platform === 'win32' ? 'ChatGPT.exe' : 'codex';

  return {
    codexExecutable,
    codexConnectionMode: 'hybrid',
    // Keep a tiny relay agent available after sign-in so the public Web portal
    // can start the heavier Codex control service on demand.
    launchAtLogin: true,
    // Opt-in because keeping a laptop awake can increase battery usage. The
    // desktop app uses Electron's app-suspension blocker, which still allows
    // the display to turn off normally.
    keepComputerAwake: false,
    autoUpdate: true,
    remotePort: GPTTOOL_REMOTE_PORT,
    remoteAllowLan: false,
    codexWorkingDirectory: '',
    relayEnabled: true,
    // Public source builds never default to the maintainer's production relay.
    // Set GPTTOOL_RELAY_URL while developing/building, or configure the URL in
    // the desktop app after deploying your own relay.
    relayUrl: env.GPTTOOL_RELAY_URL || BUILT_IN_RELAY_URL,
    relayDeviceToken: '',
    relayDeviceId: '',
    relayDeviceName: platform === 'darwin' ? '我的 Mac' : platform === 'win32' ? '我的 Windows 电脑' : '我的电脑',
    relayPairingCode: '',
  };
}

export function normalizeConfig(value: Partial<AppConfig>, platform = process.platform): AppConfig {
  const defaults = defaultConfig(platform);
  return {
    codexExecutable: String(value.codexExecutable ?? defaults.codexExecutable).trim(),
    codexConnectionMode: value.codexConnectionMode === 'app-server' ? 'app-server' : 'hybrid',
    launchAtLogin: value.launchAtLogin ?? defaults.launchAtLogin,
    keepComputerAwake: value.keepComputerAwake ?? defaults.keepComputerAwake,
    autoUpdate: value.autoUpdate ?? defaults.autoUpdate,
    // The desktop-to-relay contract uses one deterministic loopback port.
    // Migrate old settings automatically instead of keeping 8787/temporary
    // fallback ports in existing installations.
    remotePort: GPTTOOL_REMOTE_PORT,
    remoteAllowLan: false,
    codexWorkingDirectory: String(value.codexWorkingDirectory ?? defaults.codexWorkingDirectory).trim(),
    relayEnabled: true,
    relayUrl: normalizeRelayUrl(String(value.relayUrl ?? defaults.relayUrl)),
    relayDeviceToken: String(value.relayDeviceToken ?? defaults.relayDeviceToken).trim(),
    relayDeviceId: String(value.relayDeviceId ?? defaults.relayDeviceId).trim(),
    relayDeviceName: String(value.relayDeviceName ?? defaults.relayDeviceName).trim().slice(0, 64),
    relayPairingCode: String(value.relayPairingCode ?? defaults.relayPairingCode).trim(),
  };
}

export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];
  if (!config.codexExecutable) errors.push('请选择 Codex 可执行文件');
  return errors;
}

function normalizeRelayUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['wss:', 'ws:'].includes(url.protocol)) throw new Error('公网中继地址必须使用 WSS 或 WS');
  if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('公网中继必须使用加密 WSS');
  }
  url.hash = '';
  return url.toString();
}

export class ConfigStore {
  readonly filePath: string;

  constructor(private readonly directory: string) {
    this.filePath = path.join(directory, 'settings.json');
  }

  async load(): Promise<AppConfig> {
    let stored: Partial<AppConfig>;
    try {
      stored = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<AppConfig>;
    } catch {
      return defaultConfig();
    }
    const normalized = normalizeConfig(stored);
    // Rewrite legacy settings once so removed proxy/subscription keys are not
    // left behind in existing installations. This also persists the new
    // connection-mode default for upgrades made before the selector existed.
    if (JSON.stringify(stored) !== JSON.stringify(normalized)) {
      await this.save(normalized).catch(() => undefined);
    }
    return normalized;
  }

  async save(config: AppConfig): Promise<AppConfig> {
    const normalized = normalizeConfig(config);
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
    return normalized;
  }
}
