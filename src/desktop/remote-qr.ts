import QRCode from 'qrcode';

export interface RemoteQrCode {
  dataUrl: string;
  url: string;
}

export async function createRemoteQrCode(url: string): Promise<RemoteQrCode> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('远程 Web 地址无效');
  return createQrCode(parsed);
}

export async function createPairingQrCode(portalUrl: string, pairingCode: string): Promise<RemoteQrCode> {
  const parsed = new URL(portalUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('公网设备门户地址无效');
  const normalizedCode = pairingCode.trim().toUpperCase();
  if (!/^[0-9A-F]{8}$/.test(normalizedCode)) throw new Error('设备配对二维码无效');
  parsed.hash = new URLSearchParams({ pair: normalizedCode }).toString();
  return createQrCode(parsed);
}

async function createQrCode(parsed: URL): Promise<RemoteQrCode> {
  return {
    url: parsed.toString(),
    dataUrl: await QRCode.toDataURL(parsed.toString(), {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 300,
      color: { dark: '#07111d', light: '#ffffff' },
    }),
  };
}
