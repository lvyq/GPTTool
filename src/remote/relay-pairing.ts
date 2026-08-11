import { randomBytes, randomUUID } from 'node:crypto';

export interface RelayIdentity {
  deviceId: string;
  deviceToken: string;
  pairingCode: string;
  expiresAt: number;
  portalUrl: string;
}

export async function createRelayPairing(options: {
  relayUrl: string;
  deviceName: string;
  deviceId?: string;
  deviceToken?: string;
  fetchImpl?: typeof fetch;
}): Promise<RelayIdentity> {
  const deviceId = options.deviceId || randomUUID();
  const deviceToken = options.deviceToken || randomBytes(32).toString('base64url');
  const portalUrl = relayPortalUrl(options.relayUrl);
  const endpoint = new URL('api/pair/start', portalUrl);
  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, secret: deviceToken, name: options.deviceName || '我的电脑' }),
  });
  const result = await response.json() as { code?: string; expiresAt?: number; error?: string };
  if (!response.ok || !result.code || !result.expiresAt) throw new Error(result.error || `设备配对请求失败（HTTP ${response.status}）`);
  return { deviceId, deviceToken, pairingCode: result.code, expiresAt: result.expiresAt, portalUrl };
}

export function relayPortalUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/agent\/?$/, '');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.search = '';
  url.hash = '';
  return url.href;
}
