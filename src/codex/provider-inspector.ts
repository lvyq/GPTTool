import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type CodexProviderMode = 'official' | 'external-responses' | 'translation-required';

export interface CodexProviderStatus {
  id: string;
  name: string;
  model: string;
  baseUrl?: string;
  wireApi: string;
  mode: CodexProviderMode;
  external: boolean;
  officialUsageApplies: boolean;
  message: string;
}

export async function inspectCodexProvider(homeDirectory: string): Promise<CodexProviderStatus> {
  const configPath = path.join(homeDirectory, '.codex', 'config.toml');
  let source = '';
  try {
    source = await readFile(configPath, 'utf8');
  } catch {
    return officialProvider();
  }
  return inspectCodexProviderConfig(source);
}

export function inspectCodexProviderConfig(source: string): CodexProviderStatus {
  const root = parseRootValues(source);
  const id = root.model_provider || 'openai';
  const model = root.model || '';
  const provider = parseProviderValues(source, id);
  const name = provider.name || (id === 'openai' ? 'OpenAI' : id);
  const baseUrl = id === 'openai' ? root.openai_base_url : provider.base_url;
  const wireApi = provider.wire_api || 'responses';
  const external = id !== 'openai' || Boolean(baseUrl && !isOfficialOpenAiUrl(baseUrl));
  if (!external) return officialProvider(model);

  const directChatCompletionsProvider = isKnownChatCompletionsOnlyEndpoint(baseUrl);
  const responsesCompatible = wireApi === 'responses' && !directChatCompletionsProvider;
  if (!responsesCompatible) {
    return {
      id, name, model, baseUrl, wireApi,
      mode: 'translation-required',
      external: true,
      officialUsageApplies: false,
      message: `${name} 当前地址不能直接接收 Codex Responses 请求，需要先经过兼容路由转换`,
    };
  }
  return {
    id, name, model, baseUrl, wireApi,
    mode: 'external-responses',
    external: true,
    officialUsageApplies: false,
    message: `正在使用第三方模型服务 ${name}，任务由该服务计费和限额`,
  };
}

function officialProvider(model = ''): CodexProviderStatus {
  return {
    id: 'openai',
    name: 'OpenAI',
    model,
    wireApi: 'responses',
    mode: 'official',
    external: false,
    officialUsageApplies: true,
    message: '正在使用 OpenAI 官方模型服务',
  };
}

function parseRootValues(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('[')) break;
    const entry = parseEntry(trimmed);
    if (entry) result[entry[0]] = entry[1];
  }
  return result;
}

function parseProviderValues(source: string, providerId: string): Record<string, string> {
  const result: Record<string, string> = {};
  const expectedSection = `model_providers.${providerId}`;
  let active = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (!trimmed) continue;
    const section = trimmed.match(/^\[\s*([^\]]+)\s*\]$/)?.[1]?.trim();
    if (section) {
      active = section === expectedSection;
      continue;
    }
    if (!active) continue;
    const entry = parseEntry(trimmed);
    if (entry) result[entry[0]] = entry[1];
  }
  return result;
}

function parseEntry(value: string): [string, string] | undefined {
  const match = value.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
  if (!match) return undefined;
  const parsed = parseString(match[2]!.trim());
  return parsed === undefined ? undefined : [match[1]!, parsed];
}

function parseString(value: string): string | undefined {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return /^[A-Za-z0-9_.:/-]+$/.test(value) ? value : undefined;
}

function stripComment(value: string): string {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '#') return value.slice(0, index);
  }
  return value;
}

function isOfficialOpenAiUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'api.openai.com' || hostname === 'chatgpt.com' || hostname.endsWith('.openai.com');
  } catch {
    return false;
  }
}

function isKnownChatCompletionsOnlyEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'api.kimi.com' || hostname.endsWith('.moonshot.cn') || hostname.endsWith('.moonshot.ai');
  } catch {
    return false;
  }
}
