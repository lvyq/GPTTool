import type { AppConfig } from '../config/app-config.ts';
import type { ServiceState } from '../app/orchestrator.ts';
import type { OfficialClientStatus } from '../codex/official-client-probe.ts';
import type { RemoteQrCode } from './remote-qr.ts';
import type { UpdateStatus } from './update-manager.ts';
import type { OfficialCompatibilityReport } from '../codex/compatibility.ts';

export interface DesktopStatus {
  codexState: ServiceState;
  connectionMode: AppConfig['codexConnectionMode'];
  message: string;
  remoteUrls: string[];
  officialClient: OfficialClientStatus;
  publicRemoteUrl?: string;
  relayPairingCode?: string;
  relayPortalUrl?: string;
  compatibility?: OfficialCompatibilityReport;
}

export interface DesktopApi {
  loadConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<AppConfig>;
  getStatus(): Promise<DesktopStatus>;
  startCodex(): Promise<DesktopStatus>;
  stopCodex(): Promise<DesktopStatus>;
  inspectOfficialClient(): Promise<OfficialClientStatus>;
  chooseFile(): Promise<string | undefined>;
  chooseDirectory(): Promise<string | undefined>;
  openNotices(): Promise<void>;
  getRemoteQrCode(): Promise<RemoteQrCode>;
  getPairingQrCode(): Promise<RemoteQrCode>;
  openRemoteUrl(): Promise<void>;
  openRelayPortal(): Promise<void>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<UpdateStatus>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
}
