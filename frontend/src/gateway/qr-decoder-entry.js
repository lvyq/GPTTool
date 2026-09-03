import jsQR from 'jsqr';

globalThis.GPTToolQrDecoder = Object.freeze({
  decode(imageData) {
    const result = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'attemptBoth',
    });
    return result?.data || '';
  },
});
