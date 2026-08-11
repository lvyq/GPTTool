import { contextBridge, ipcRenderer } from 'electron';
import type { AppConfig } from '../config/app-config.ts';
import type { DesktopApi, DesktopStatus } from './contracts.ts';

const api: DesktopApi = {
  loadConfig: () => ipcRenderer.invoke('config:load') as Promise<AppConfig>,
  saveConfig: (config) => ipcRenderer.invoke('config:save', config) as Promise<AppConfig>,
  getStatus: () => ipcRenderer.invoke('service:status') as Promise<DesktopStatus>,
  startCodex: () => ipcRenderer.invoke('codex:start') as Promise<DesktopStatus>,
  stopCodex: () => ipcRenderer.invoke('codex:stop') as Promise<DesktopStatus>,
  inspectOfficialClient: () => ipcRenderer.invoke('codex:inspect-client') as ReturnType<DesktopApi['inspectOfficialClient']>,
  chooseFile: () => ipcRenderer.invoke('dialog:file') as Promise<string | undefined>,
  chooseDirectory: () => ipcRenderer.invoke('dialog:directory') as Promise<string | undefined>,
  openNotices: () => ipcRenderer.invoke('notices:open') as Promise<void>,
  getRemoteQrCode: () => ipcRenderer.invoke('remote:qr-code') as ReturnType<DesktopApi['getRemoteQrCode']>,
  getPairingQrCode: () => ipcRenderer.invoke('remote:pairing-qr-code') as ReturnType<DesktopApi['getPairingQrCode']>,
  openRemoteUrl: () => ipcRenderer.invoke('remote:open-url') as Promise<void>,
  openRelayPortal: () => ipcRenderer.invoke('remote:open-portal') as Promise<void>,
  getUpdateStatus: () => ipcRenderer.invoke('updates:status') as ReturnType<DesktopApi['getUpdateStatus']>,
  checkForUpdates: () => ipcRenderer.invoke('updates:check') as ReturnType<DesktopApi['checkForUpdates']>,
  downloadUpdate: () => ipcRenderer.invoke('updates:download') as ReturnType<DesktopApi['downloadUpdate']>,
  installUpdate: () => ipcRenderer.invoke('updates:install') as ReturnType<DesktopApi['installUpdate']>,
  minimizeWindow: () => ipcRenderer.invoke('window:minimize') as Promise<void>,
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize') as Promise<boolean>,
  closeWindow: () => ipcRenderer.invoke('window:close') as Promise<void>,
  onStatus(listener) {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopStatus) => listener(status);
    ipcRenderer.on('service:status-changed', handler);
    return () => ipcRenderer.off('service:status-changed', handler);
  },
  onUpdateStatus(listener) {
    const handler = (_event: Electron.IpcRendererEvent, status: import('./update-manager.ts').UpdateStatus) => listener(status);
    ipcRenderer.on('updates:status-changed', handler);
    return () => ipcRenderer.off('updates:status-changed', handler);
  },
};

contextBridge.exposeInMainWorld('asterGate', api);
