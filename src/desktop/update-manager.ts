import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'unsupported';

export interface UpdateArtifact {
  url: string;
  sha256: string;
  size: number;
}

export interface UpdateManifestPayload {
  schema: 1;
  version: string;
  publishedAt: string;
  notes: string[];
  artifacts: Partial<Record<NodeJS.Platform, UpdateArtifact>>;
}

export interface SignedUpdateEnvelope {
  payload: string;
  signature: string;
}

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  message: string;
  progress?: number;
  downloadedPath?: string;
  checkedAt?: string;
  releaseNotes?: string[];
}

export interface UpdateManagerOptions {
  currentVersion: string;
  platform: NodeJS.Platform;
  userDataDirectory: string;
  executablePath: string;
  manifestUrl: string;
  publicKey: string;
  autoUpdate: boolean;
  onStatus?: (status: UpdateStatus) => void;
  fetchImpl?: typeof fetch;
}

const CHECK_INTERVAL_MS = 4 * 60 * 60_000;
const STARTUP_DELAY_MS = 8_000;
export class UpdateManager {
  #status: UpdateStatus;
  #manifest?: UpdateManifestPayload;
  #artifact?: UpdateArtifact;
  #autoUpdate: boolean;
  #startupTimer?: NodeJS.Timeout;
  #interval?: NodeJS.Timeout;
  readonly #fetch: typeof fetch;

  constructor(private readonly options: UpdateManagerOptions) {
    this.#autoUpdate = options.autoUpdate;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#status = {
      phase: 'idle',
      currentVersion: options.currentVersion,
      message: '尚未检查更新',
    };
  }

  get status(): UpdateStatus {
    return { ...this.#status, releaseNotes: [...(this.#status.releaseNotes ?? [])] };
  }

  start(): void {
    if (!this.#autoUpdate || this.#startupTimer) return;
    this.#startupTimer = setTimeout(() => {
      void this.check({ downloadWhenAvailable: true });
    }, STARTUP_DELAY_MS);
    this.#startupTimer.unref();
    this.#interval = setInterval(() => {
      if (this.#autoUpdate) void this.check({ downloadWhenAvailable: true });
    }, CHECK_INTERVAL_MS);
    this.#interval.unref();
  }

  stop(): void {
    if (this.#startupTimer) clearTimeout(this.#startupTimer);
    if (this.#interval) clearInterval(this.#interval);
    this.#startupTimer = undefined;
    this.#interval = undefined;
  }

  setAutoUpdate(enabled: boolean): void {
    this.#autoUpdate = enabled;
    if (enabled) this.start();
    else this.stop();
  }

  async check(options: { downloadWhenAvailable?: boolean } = {}): Promise<UpdateStatus> {
    if (['checking', 'downloading', 'installing'].includes(this.#status.phase)) return this.status;
    this.#setStatus({ ...this.#status, phase: 'checking', message: '正在检查更新…', progress: undefined });
    try {
      const trustedOrigin = new URL(assertUpdateUrl(this.options.manifestUrl)).origin;
      const manifestResponse = await this.#fetch(this.options.manifestUrl, {
        cache: 'no-store',
        headers: { Accept: 'application/json', 'User-Agent': `GPTTool/${this.options.currentVersion}` },
      });
      if (!manifestResponse.ok) throw new Error(`更新服务返回 HTTP ${manifestResponse.status}`);
      const envelope = await manifestResponse.json() as SignedUpdateEnvelope;
      const manifest = parseSignedUpdateManifest(envelope, this.options.publicKey, trustedOrigin);
      const artifact = manifest.artifacts[this.options.platform];
      const checkedAt = new Date().toISOString();
      this.#manifest = manifest;
      this.#artifact = artifact;
      if (!artifact) {
        this.#setStatus({
          phase: 'unsupported',
          currentVersion: this.options.currentVersion,
          latestVersion: manifest.version,
          checkedAt,
          releaseNotes: manifest.notes,
          message: '当前系统暂时没有可用安装包',
        });
        return this.status;
      }
      if (compareVersions(manifest.version, this.options.currentVersion) <= 0) {
        this.#setStatus({
          phase: 'up-to-date',
          currentVersion: this.options.currentVersion,
          latestVersion: manifest.version,
          checkedAt,
          releaseNotes: manifest.notes,
          message: '当前已是最新版本',
        });
        return this.status;
      }
      this.#setStatus({
        phase: 'available',
        currentVersion: this.options.currentVersion,
        latestVersion: manifest.version,
        checkedAt,
        releaseNotes: manifest.notes,
        message: `发现新版本 ${manifest.version}`,
      });
      if (options.downloadWhenAvailable || this.#autoUpdate) return this.download();
      return this.status;
    } catch (error) {
      this.#setStatus({
        ...this.#status,
        phase: 'error',
        progress: undefined,
        message: `检查更新失败：${formatError(error)}`,
      });
      return this.status;
    }
  }

  async download(): Promise<UpdateStatus> {
    if (this.#status.phase === 'downloaded' && this.#status.downloadedPath) {
      if (await access(this.#status.downloadedPath).then(() => true, () => false)) return this.status;
    }
    if (!this.#artifact || !this.#manifest) {
      const checked = await this.check();
      if (checked.phase !== 'available') return checked;
    }
    const artifact = this.#artifact;
    const manifest = this.#manifest;
    if (!artifact || !manifest) return this.status;

    this.#setStatus({ ...this.#status, phase: 'downloading', progress: 0, message: `正在下载 ${manifest.version}…` });
    const updateDirectory = path.join(this.options.userDataDirectory, 'updates');
    await mkdir(updateDirectory, { recursive: true });
    const extension = this.options.platform === 'darwin' ? '.dmg' : '.exe';
    const finalPath = path.join(updateDirectory, `GPTTool-${manifest.version}${extension}`);
    const temporaryPath = `${finalPath}.partial`;
    await rm(temporaryPath, { force: true });

    try {
      const response = await this.#fetch(assertUpdateUrl(artifact.url, new URL(this.options.manifestUrl).origin), {
        cache: 'no-store',
        headers: { 'User-Agent': `GPTTool/${this.options.currentVersion}` },
      });
      if (!response.ok || !response.body) throw new Error(`安装包下载失败（HTTP ${response.status}）`);
      const handle = await open(temporaryPath, 'w', 0o600);
      const hash = createHash('sha256');
      const reader = response.body.getReader();
      let received = 0;
      let lastProgressAt = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await handle.write(value);
          hash.update(value);
          received += value.byteLength;
          const now = Date.now();
          if (now - lastProgressAt >= 120 || received === artifact.size) {
            lastProgressAt = now;
            this.#setStatus({
              ...this.#status,
              phase: 'downloading',
              progress: Math.min(100, Math.round((received / artifact.size) * 100)),
              message: `正在下载 ${manifest.version}…`,
            });
          }
        }
      } finally {
        await handle.close();
      }
      if (received !== artifact.size) throw new Error('安装包大小与发布清单不一致');
      if (hash.digest('hex') !== artifact.sha256.toLowerCase()) throw new Error('安装包完整性校验失败');
      await rm(finalPath, { force: true });
      await rename(temporaryPath, finalPath);
      this.#setStatus({
        ...this.#status,
        phase: 'downloaded',
        progress: 100,
        downloadedPath: finalPath,
        message: `版本 ${manifest.version} 已下载，等待安装`,
      });
    } catch (error) {
      await rm(temporaryPath, { force: true });
      this.#setStatus({
        ...this.#status,
        phase: 'error',
        progress: undefined,
        message: `下载更新失败：${formatError(error)}`,
      });
    }
    return this.status;
  }

  async scheduleInstall(): Promise<UpdateStatus> {
    const downloadedPath = this.#status.downloadedPath;
    if (this.#status.phase !== 'downloaded' || !downloadedPath) throw new Error('请先下载更新');
    await access(downloadedPath);
    const info = await stat(downloadedPath);
    if (!info.isFile()) throw new Error('已下载的更新文件无效');

    const scriptsDirectory = path.join(this.options.userDataDirectory, 'updates');
    await mkdir(scriptsDirectory, { recursive: true });
    if (this.options.platform === 'darwin') {
      const appPath = findMacAppPath(this.options.executablePath);
      const scriptPath = path.join(scriptsDirectory, 'install-update.sh');
      await writeFile(scriptPath, macInstallerScript(), { mode: 0o700 });
      spawn('/bin/sh', [scriptPath, String(process.pid), downloadedPath, appPath], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else if (this.options.platform === 'win32') {
      const scriptPath = path.join(scriptsDirectory, 'install-update.cmd');
      await writeFile(scriptPath, windowsInstallerScript(), { mode: 0o600 });
      const command = `call "${scriptPath}" "${process.pid}" "${downloadedPath}"`;
      spawn('cmd.exe', ['/d', '/s', '/c', command], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      }).unref();
    } else {
      throw new Error('当前系统暂不支持自动安装');
    }
    this.#setStatus({ ...this.#status, phase: 'installing', message: '正在退出并安装更新…' });
    return this.status;
  }

  #setStatus(status: UpdateStatus): void {
    this.#status = status;
    this.options.onStatus?.(this.status);
  }
}

export function parseSignedUpdateManifest(
  envelope: SignedUpdateEnvelope,
  publicKeyBase64: string,
  trustedOrigin?: string,
): UpdateManifestPayload {
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
    throw new Error('更新清单格式无效');
  }
  const payload = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  if (!verify(null, payload, publicKey, signature)) throw new Error('更新清单签名无效');
  const manifest = JSON.parse(payload.toString('utf8')) as UpdateManifestPayload;
  if (manifest.schema !== 1 || !isVersion(manifest.version) || !Array.isArray(manifest.notes)) {
    throw new Error('更新清单内容无效');
  }
  for (const artifact of Object.values(manifest.artifacts ?? {})) {
    if (!artifact || !/^[a-f0-9]{64}$/i.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
      throw new Error('更新安装包信息无效');
    }
    assertUpdateUrl(artifact.url, trustedOrigin);
  }
  return manifest;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function parseVersion(version: string): [number, number, number] {
  if (!isVersion(version)) throw new Error(`版本号无效：${version}`);
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return [major, minor, patch];
}

function isVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(String(value));
}

function assertUpdateUrl(value: string, trustedOrigin?: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || (trustedOrigin && url.origin !== trustedOrigin)) {
    throw new Error('更新地址不受信任');
  }
  return url.toString();
}

function findMacAppPath(executablePath: string): string {
  const marker = '.app/';
  const index = executablePath.indexOf(marker);
  if (index < 1) throw new Error('无法定位当前 GPTTool 应用');
  const appPath = executablePath.slice(0, index + 4);
  if (!path.isAbsolute(appPath) || path.basename(appPath) !== 'GPTTool.app') throw new Error('当前应用路径不受支持');
  return appPath;
}

function macInstallerScript(): string {
  return `#!/bin/sh
set -eu
APP_PID="$1"
DMG_PATH="$2"
APP_TARGET="$3"
MOUNT_DIR="$(mktemp -d /tmp/gpttool-update.XXXXXX)"
STAGE_PATH="\${APP_TARGET}.updating"
OLD_PATH="\${APP_TARGET}.previous"
cleanup() {
  /usr/bin/hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
  /bin/rm -rf "$MOUNT_DIR" "$STAGE_PATH"
}
trap cleanup EXIT
while /bin/kill -0 "$APP_PID" >/dev/null 2>&1; do /bin/sleep 1; done
/usr/bin/hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_DIR" -nobrowse -readonly -quiet
SOURCE_PATH="$MOUNT_DIR/GPTTool.app"
test -d "$SOURCE_PATH"
/bin/rm -rf "$STAGE_PATH" "$OLD_PATH"
/usr/bin/ditto "$SOURCE_PATH" "$STAGE_PATH"
test -x "$STAGE_PATH/Contents/MacOS/GPTTool"
/bin/mv "$APP_TARGET" "$OLD_PATH"
/bin/mv "$STAGE_PATH" "$APP_TARGET"
/usr/bin/open "$APP_TARGET"
/bin/rm -rf "$OLD_PATH"
`;
}

function windowsInstallerScript(): string {
  return `@echo off
setlocal
set APP_PID=%~1
set INSTALLER=%~2
:wait
tasklist /FI "PID eq %APP_PID%" 2>NUL | find "%APP_PID%" >NUL
if not errorlevel 1 (
  timeout /T 1 /NOBREAK >NUL
  goto wait
)
start "" /WAIT "%INSTALLER%" /S
del "%~f0"
`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
