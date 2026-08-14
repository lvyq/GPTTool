import type { CdpOperationRules } from '../codex/cdp-rules.ts';
import type { OfficialClientStatus } from '../codex/official-client-probe.ts';

export interface CollectorSettingsView {
  uploadEndpoint: string;
  platform: string;
  priority: number;
  autoUpload: boolean;
  tokenConfigured: boolean;
}

export interface CollectorSettingsInput extends Omit<CollectorSettingsView, 'tokenConfigured'> {
  uploadToken?: string;
  clearToken?: boolean;
}

export interface CollectionResult {
  rules: CdpOperationRules;
  uploaded: boolean;
  uploadMessage?: string;
}

export interface CollectorApi {
  inspect(): Promise<OfficialClientStatus>;
  loadSettings(): Promise<CollectorSettingsView>;
  saveSettings(input: CollectorSettingsInput): Promise<CollectorSettingsView>;
  collect(input: { consent: boolean; restartClient: boolean }): Promise<CollectionResult>;
  exportRules(rules: CdpOperationRules): Promise<string | undefined>;
  importRules(): Promise<CdpOperationRules | undefined>;
  uploadRules(rules: CdpOperationRules): Promise<{ ok: true; id: string }>;
}

declare global {
  interface Window { cdpCollector: CollectorApi }
}
