const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const productName = context.packager.appInfo.productFilename;
  const infoPlist = path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Info.plist');
  for (const key of [
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
  ]) {
    try {
      execFileSync('/usr/bin/plutil', ['-remove', key, infoPlist]);
    } catch {
      // Electron versions differ; an absent key is already the desired state.
    }
  }
  execFileSync('/usr/bin/plutil', [
    '-replace', 'NSAppTransportSecurity.NSAllowsArbitraryLoads', '-bool', 'false', infoPlist,
  ]);
  execFileSync('/usr/bin/plutil', [
    '-replace', 'NSAppTransportSecurity.NSAllowsLocalNetworking', '-bool', 'true', infoPlist,
  ]);
};
