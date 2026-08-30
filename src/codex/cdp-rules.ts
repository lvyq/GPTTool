import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface CdpOperationRules {
  schemaVersion: 1;
  id: string;
  minOfficialVersion?: string;
  maxOfficialVersion?: string;
  exactOfficialVersion?: string;
  updatedAt: string;
  selectors: {
    composer: string;
    composerRootMarker: string;
    modelTrigger: string;
    profileTrigger: string;
    threadRow: string;
    threadTitleRow: string;
  };
  labels: {
    usage: string;
    queued: string[];
  };
  /** Optional app-server response mappings. Keeping these beside the CDP
   * selectors lets a cloud rule update adapt both compatibility channels
   * without requiring a desktop release. */
  appServer?: {
    threadListPaths?: string[];
    threadIdFields?: string[];
    threadTitleFields?: string[];
  };
  /** Optional diagnostics emitted by the private rule collector. */
  collector?: {
    capabilities?: Partial<Record<
      'runtime' | 'mainWindow' | 'documentReady' | 'composer' | 'threadRows' | 'modelControl' |
      'taskMetadata' | 'usageControl' | 'submitControl' | 'profileControl' | 'composerVisible',
      boolean
    >>;
    selectorMatches?: Partial<Record<keyof CdpOperationRules['selectors'] | 'submitControl', number>>;
  };
}

export const BUILTIN_CDP_RULES: CdpOperationRules = {
  schemaVersion: 1,
  id: 'builtin-2026-08',
  updatedAt: '2026-08-13T00:00:00.000Z',
  selectors: {
    composer: '[data-codex-composer="true"],textarea,[contenteditable="true"],[role="textbox"]',
    composerRootMarker: '[data-composer-navigation-target="add-context"]',
    modelTrigger: '[data-codex-intelligence-trigger="true"]',
    profileTrigger: 'button[aria-label="打开个人资料菜单"],button[aria-label*="profile" i]',
    threadRow: '[data-app-action-sidebar-thread-id]',
    threadTitleRow: '[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-title]',
  },
  labels: {
    usage: '剩余用量',
    queued: ['已排队', '待发送', '下一个', 'queued', 'next up'],
  },
};

export interface CdpRuleLoaderOptions {
  officialVersion?: string;
  endpoint?: string;
  cacheDirectory?: string;
  fetch?: typeof fetch;
}

export async function loadCdpRules(options: CdpRuleLoaderOptions): Promise<CdpOperationRules> {
  const cached = await readCachedRules(options.cacheDirectory, options.officialVersion);
  if (options.endpoint) {
    try {
      const url = new URL(options.endpoint);
      if (options.officialVersion) url.searchParams.set('version', options.officialVersion);
      url.searchParams.set('platform', process.platform);
      const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) {
        const candidate = validateRules(await response.json(), options.officialVersion);
        if (candidate) {
          await writeCachedRules(options.cacheDirectory, candidate).catch(() => undefined);
          return candidate;
        }
      }
    } catch {
      // A bad network response must never replace a working bundled adapter.
    }
  }
  return cached ?? BUILTIN_CDP_RULES;
}

export function validateRules(value: unknown, version?: string): CdpOperationRules | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const rules = value as CdpOperationRules;
  if (rules.schemaVersion !== 1 || typeof rules.id !== 'string' || !rules.id || !rules.selectors || !rules.labels) return undefined;
  const selectors = Object.values(rules.selectors);
  if (selectors.some((item) => typeof item !== 'string' || !item || item.length > 500 || /[{};]|javascript:/i.test(item))) return undefined;
  if (!Array.isArray(rules.labels.queued) || rules.labels.queued.some((item) => typeof item !== 'string' || item.length > 80)) return undefined;
  if (typeof rules.labels.usage !== 'string' || rules.labels.usage.length > 80) return undefined;
  if (rules.appServer) {
    const mappings = [
      { items: rules.appServer.threadListPaths, allowRoot: true },
      { items: rules.appServer.threadIdFields, allowRoot: false },
      { items: rules.appServer.threadTitleFields, allowRoot: false },
    ];
    if (mappings.some(({ items, allowRoot }) => items !== undefined && (
      !Array.isArray(items)
      || items.length > 20
      || items.some((item) => typeof item !== 'string'
        || (!allowRoot && !item)
        || item.length > 120
        || (item !== '' && !/^[A-Za-z0-9_.-]+$/.test(item)))
    ))) return undefined;
  }
  // A collector result is only publishable when it proved that the minimum
  // messaging surface exists. Older, manually-authored rule documents do not
  // contain collector diagnostics and remain backward compatible.
  if (rules.collector && !collectorSupportsMessaging(rules.collector)) return undefined;
  if (version && !matchesOfficialVersion(rules, version)) return undefined;
  return rules;
}

export function collectorSupportsMessaging(collector: NonNullable<CdpOperationRules['collector']>): boolean {
  const capabilities = collector.capabilities;
  if (!capabilities) return false;
  const required = ['runtime', 'mainWindow', 'documentReady', 'composer', 'submitControl', 'composerVisible'] as const;
  if (required.some((name) => capabilities[name] !== true)) return false;
  const matches = collector.selectorMatches;
  if (!matches) return false;
  return Number(matches.composer ?? 0) > 0 && Number(matches.submitControl ?? 0) > 0;
}

export function matchesOfficialVersion(rules: CdpOperationRules, version: string): boolean {
  if (rules.exactOfficialVersion && compareVersions(version, rules.exactOfficialVersion) !== 0) return false;
  if (rules.minOfficialVersion && compareVersions(version, rules.minOfficialVersion) < 0) return false;
  if (rules.maxOfficialVersion && compareVersions(version, rules.maxOfficialVersion) > 0) return false;
  return true;
}

function compareVersions(left: string, right: string): number {
  const a = String(left).split(/[^0-9]+/).filter(Boolean).map(Number);
  const b = String(right).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta) return delta > 0 ? 1 : -1;
  }
  return 0;
}

async function readCachedRules(directory?: string, version?: string): Promise<CdpOperationRules | undefined> {
  if (!directory) return undefined;
  for (const filename of ['cdp-rules.json', 'cdp-rules.last-good.json']) {
    try {
      const rules = validateRules(JSON.parse(await readFile(path.join(directory, filename), 'utf8')), version);
      if (rules) return rules;
    } catch {
      // Try the last-known-good adapter before falling back to bundled rules.
    }
  }
  return undefined;
}

async function writeCachedRules(directory: string | undefined, rules: CdpOperationRules): Promise<void> {
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const contents = JSON.stringify(rules, null, 2);
  await Promise.all([
    writeFile(path.join(directory, 'cdp-rules.json'), contents, { mode: 0o600 }),
    writeFile(path.join(directory, 'cdp-rules.last-good.json'), contents, { mode: 0o600 }),
  ]);
}
