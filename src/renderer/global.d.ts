import type { DesktopApi } from '../desktop/contracts.ts';

declare global {
  interface Window {
    asterGate: DesktopApi;
  }
}

export {};
