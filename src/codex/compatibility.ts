export type CompatibilityState = 'unknown' | 'checking' | 'compatible' | 'degraded' | 'incompatible';
export type CompatibilityMode = 'unknown' | 'full' | 'backward-compatible' | 'limited' | 'blocked';
export type OfficialVersionRelation = 'older' | 'same' | 'newer' | 'unknown';

// Diagnostic reference for this GPTTool release. Capability probes, rather
// than this number, decide whether remote control is allowed.
export const TESTED_OFFICIAL_APP_VERSION = '26.803.41515';

export interface CompatibilityFeature {
  id: string;
  label: string;
  required: boolean;
  available: boolean;
  detail?: string;
}

export interface OfficialCompatibilityReport {
  state: CompatibilityState;
  mode: CompatibilityMode;
  checkedAt?: string;
  officialAppVersion?: string;
  testedOfficialAppVersion?: string;
  officialVersionRelation?: OfficialVersionRelation;
  runtimeVersion?: string;
  features: CompatibilityFeature[];
  message: string;
}

export function summarizeCompatibility(
  features: CompatibilityFeature[],
  versions: {
    officialAppVersion?: string;
    runtimeVersion?: string;
    testedOfficialAppVersion?: string;
  } = {},
): OfficialCompatibilityReport {
  const missingRequired = features.filter((feature) => feature.required && !feature.available);
  const missingOptional = features.filter((feature) => !feature.required && !feature.available);
  const state: CompatibilityState = missingRequired.length
    ? 'incompatible'
    : missingOptional.length
      ? 'degraded'
      : 'compatible';
  const testedOfficialAppVersion = versions.testedOfficialAppVersion ?? TESTED_OFFICIAL_APP_VERSION;
  const officialVersionRelation = compareOfficialVersions(versions.officialAppVersion, testedOfficialAppVersion);
  const mode: CompatibilityMode = state === 'incompatible'
    ? 'blocked'
    : state === 'degraded'
      ? officialVersionRelation === 'older' ? 'backward-compatible' : 'limited'
      : 'full';
  const versionLabel = versions.officialAppVersion ? `ChatGPT ${versions.officialAppVersion}` : '当前 ChatGPT';
  const message = state === 'incompatible'
    ? `${versionLabel} 与当前 GPTTool 不兼容：${missingRequired.map((feature) => feature.label).join('、')}不可用。已阻止远程控制，请更新 GPTTool。`
    : state === 'degraded'
      ? mode === 'backward-compatible'
        ? `${versionLabel} 低于 GPTTool 完整验证版本 ${testedOfficialAppVersion}，已启用向下兼容模式：远程控制和消息发送可用；${missingOptional.map((feature) => feature.label).join('、')}暂不可用。`
        : `${versionLabel} 核心远程控制和消息发送可用；${missingOptional.map((feature) => feature.label).join('、')}暂不可用。`
      : `${versionLabel} 已通过 GPTTool 兼容性检查`;
  return {
    state,
    mode,
    checkedAt: new Date().toISOString(),
    ...versions,
    testedOfficialAppVersion,
    officialVersionRelation,
    features,
    message,
  };
}

export function compareOfficialVersions(actual?: string, tested?: string): OfficialVersionRelation {
  const left = numericVersion(actual);
  const right = numericVersion(tested);
  if (!left || !right) return 'unknown';
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta < 0) return 'older';
    if (delta > 0) return 'newer';
  }
  return 'same';
}

function numericVersion(value?: string): number[] | undefined {
  const match = value?.match(/\d+(?:\.\d+)+/);
  return match?.[0].split('.').map(Number);
}

export function compatibilityError(report: OfficialCompatibilityReport): Error {
  const error = new Error(report.message);
  Object.assign(error, { code: 'OFFICIAL_CLIENT_INCOMPATIBLE', compatibility: report });
  return error;
}
