import { contextBridge, ipcRenderer } from 'electron';
import type { CollectorApi } from './contracts.ts';

const api: CollectorApi = {
  inspect: () => ipcRenderer.invoke('collector:inspect') as ReturnType<CollectorApi['inspect']>,
  loadSettings: () => ipcRenderer.invoke('collector:settings:load') as ReturnType<CollectorApi['loadSettings']>,
  saveSettings: (input) => ipcRenderer.invoke('collector:settings:save', input) as ReturnType<CollectorApi['saveSettings']>,
  collect: (input) => ipcRenderer.invoke('collector:collect', input) as ReturnType<CollectorApi['collect']>,
  exportRules: (rules) => ipcRenderer.invoke('collector:export', rules) as ReturnType<CollectorApi['exportRules']>,
  importRules: () => ipcRenderer.invoke('collector:import') as ReturnType<CollectorApi['importRules']>,
  uploadRules: (rules) => ipcRenderer.invoke('collector:upload', rules) as ReturnType<CollectorApi['uploadRules']>,
};

contextBridge.exposeInMainWorld('cdpCollector', api);
