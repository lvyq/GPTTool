import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('desktop exposes only the remote-control product surface', async () => {
  const [html, renderer, main] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'renderer', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'renderer', 'renderer.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'src', 'desktop', 'main.ts'), 'utf8'),
  ]);

  assert.doesNotMatch(html, /data-page="proxy"|proxyAction|系统代理|网络代理/);
  assert.match(html, /data-mode="hybrid"/);
  assert.match(html, /data-mode="app-server"/);
  assert.match(html, /官方同步/);
  assert.match(html, /独立服务/);
  assert.match(html, />远程控制</);
  assert.match(html, />设置</);
  assert.doesNotMatch(html, /data-page="remote"|data-page-panel="remote"/);
  assert.match(html, /远程入口/);
  assert.match(html, /id="showPairingQr"/);
  assert.match(html, /id="openPortal"/);
  assert.match(html, /id="qrOpenLocal"/);
  assert.match(renderer, /当前电脑已绑定到账户/);
  assert.doesNotMatch(html, /id="showRemoteQr"/);
  assert.doesNotMatch(html, /id="relayUrl"/);
  assert.match(renderer, /远程控制未启动/);
  assert.match(html, /id="autoUpdate"/);
  assert.match(html, /id="updateAction"/);
  assert.match(html, /id="windowMinimize"/);
  assert.match(html, /id="windowMaximize"/);
  assert.match(html, /id="windowClose"/);
  assert.match(renderer, /toggleMaximizeWindow/);
  assert.match(main, /frame: false/);
  assert.match(main, /window:toggle-maximize/);
  assert.doesNotMatch(html, /允许局域网访问/);
  assert.match(main, /allowLan: false/);
  assert.match(main, /return status\.publicRemoteUrl/);
  assert.match(main, /GPTTOOL_UPDATE_MANIFEST_URL/);
  assert.doesNotMatch(main, /ebbbe\.com/);

  const trayMenu = main.slice(main.indexOf('function updateTrayMenu'), main.indexOf('function showWindow'));
  assert.doesNotMatch(trayMenu, /启动代理|停止代理|startProxy|stopProxy/);
  assert.match(trayMenu, /启动 Codex 控制/);
});

test('desktop and web surfaces share the black white and green design system', async () => {
  const [desktopCss, remoteCss, gatewayCss] = await Promise.all([
    readFile(path.join(projectDirectory, 'src', 'renderer', 'styles.css'), 'utf8'),
    readFile(path.join(projectDirectory, 'frontend', 'src', 'remote', 'remote.css'), 'utf8'),
    readFile(path.join(projectDirectory, 'frontend', 'src', 'gateway', 'gateway.css'), 'utf8'),
  ]);

  assert.match(desktopCss, /--green:#42df98/);
  for (const css of [remoteCss, gatewayCss]) {
    assert.match(css, /GPTTool mono-green/);
    assert.match(css, /#070807/);
    assert.match(css, /#41df91/);
    assert.match(css, /#fff/);
  }
  assert.match(remoteCss, /--brand-green:\s*#41df91/);
  assert.match(remoteCss, /\.process-group\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;/);
  assert.match(gatewayCss, /--green:\s*#41df91/);
});

test('mobile Web surfaces keep a fixed page scale while preserving normal panning', async () => {
  const [remoteHtml, remoteCss, gatewayHtml, gatewayCss, adminHtml] = await Promise.all([
    readFile(path.join(projectDirectory, 'frontend', 'src', 'remote', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'frontend', 'src', 'remote', 'remote.css'), 'utf8'),
    readFile(path.join(projectDirectory, 'frontend', 'src', 'gateway', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'frontend', 'src', 'gateway', 'gateway.css'), 'utf8'),
    readFile(path.join(projectDirectory, 'frontend', 'src', 'admin', 'index.html'), 'utf8'),
  ]);

  for (const html of [remoteHtml, gatewayHtml, adminHtml]) {
    assert.match(html, /maximum-scale=1/);
    assert.match(html, /user-scalable=no/);
  }
  assert.match(remoteCss, /touch-action:\s*pan-x pan-y/);
  assert.match(gatewayCss, /touch-action:\s*pan-x pan-y/);
});

test('administrator console ships a matching direct-login shell and script', async () => {
  const [adminHtml, adminScript, relaySource] = await Promise.all([
    readFile(path.join(projectDirectory, 'frontend', 'src', 'admin', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'frontend', 'src', 'admin', 'admin.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'backend', 'src', 'server.mjs'), 'utf8'),
  ]);

  assert.match(adminHtml, /id="adminLogin"/);
  assert.match(adminHtml, /id="adminLoginForm"/);
  assert.match(adminHtml, /id="adminUsername"/);
  assert.match(adminHtml, /id="adminPassword"/);
  assert.match(adminHtml, /id="adminApp"/);
  assert.match(adminScript, /\$\('#adminLoginForm'\)\.addEventListener/);
  assert.match(adminScript, /enterAdmin\(\)\.catch\(\(\)=>showAdminLogin\(\)\)/);
  assert.match(relaySource, /administration shell publicly/);
  assert.match(relaySource, /requestUrl\.pathname\.startsWith\('\/api\/admin\/'\)/);
});

test('device portal supports private in-page QR pairing without a header divider', async () => {
  const [gatewayHtml, gatewayScript, gatewayCss, relaySource] = await Promise.all([
    readFile(path.join(projectDirectory, 'frontend', 'src', 'gateway', 'index.html'), 'utf8'),
    readFile(path.join(projectDirectory, 'frontend', 'src', 'gateway', 'gateway.js'), 'utf8'),
    readFile(path.join(projectDirectory, 'frontend', 'src', 'gateway', 'gateway.css'), 'utf8'),
    readFile(path.join(projectDirectory, 'backend', 'src', 'server.mjs'), 'utf8'),
  ]);

  assert.match(gatewayHtml, /class="pairing-kicker">添加设备<[\s\S]*<h3>连接新电脑<\/h3>/);
  assert.match(gatewayHtml, /id="startQrScanner"[\s\S]*打开相机扫码/);
  assert.match(gatewayHtml, /class="scan-icon"[\s\S]*<svg[\s\S]*<circle/);
  assert.doesNotMatch(gatewayHtml, /class="section-icon pairing-icon"/);
  assert.match(gatewayHtml, /电脑显示二维码[\s\S]*手机扫码[\s\S]*自动绑定/);
  assert.doesNotMatch(gatewayHtml, /备用方式|8 位配对码|id="pairForm"|id="pairCode"/);
  assert.match(gatewayHtml, /id="qrScannerVideo" playsinline muted/);
  assert.match(gatewayHtml, /id="qrImagePicker"[\s\S]*accept="image\/\*"/);
  assert.match(gatewayHtml, /src="qr-decoder\.js/);
  assert.match(gatewayScript, /navigator\.mediaDevices\?\.getUserMedia/);
  assert.match(gatewayScript, /facingMode:\s*\{\s*ideal:\s*'environment'/);
  assert.match(gatewayScript, /centerSize = Math\.round\(shorterSide \* \.86\)/);
  assert.match(gatewayScript, /target\.origin !== location\.origin/);
  assert.match(gatewayCss, /\.app-header\s*\{\s*border-bottom:\s*0 !important;/);
  assert.ok(gatewayHtml.indexOf('class="device-section"') < gatewayHtml.indexOf('class="surface pairing"'));
  assert.match(gatewayCss, /Refined workspace dashboard/);
  assert.match(gatewayCss, /height:\s*100dvh/);
  assert.match(gatewayCss, /grid-template-rows:\s*auto auto auto auto auto/);
  assert.match(gatewayCss, /\.scanner-viewport\s*\{[\s\S]*?aspect-ratio:\s*1;/);
  assert.match(gatewayScript, /messageTimer = setTimeout[\s\S]*?2_800/);
  assert.match(gatewayScript, /在线待机 · 可远程启动/);
  assert.match(gatewayScript, /api\/devices\/\$\{encodeURIComponent\(device\.id\)\}\/start/);
  assert.match(relaySource, /type: 'device\.command', command: 'start'/);
  assert.match(gatewayCss, /#devicesView \.dashboard-grid\s*\{[\s\S]*grid-template-columns: minmax\(0, 1\.42fr\)/);
  assert.match(relaySource, /'\/qr-decoder\.js'/);
});

test('official-client attachment delivery targets the live composer and confirms the new attachment chip', async () => {
  const source = await readFile(path.join(projectDirectory, 'src', 'codex', 'cdp-client.ts'), 'utf8');
  assert.match(source, /reactProps\?\.onDrop/);
  assert.match(source, /closest\('\[data-codex-composer-root\]'\)/);
  assert.match(source, /baselineCounts/);
  assert.doesNotMatch(source, /data-composer-attachments-row/);
});

test('public Web UI can be versioned and deployed without rebuilding desktop installers', async () => {
  const [packageSource, webVersionSource, relaySource, deployScript] = await Promise.all([
    readFile(path.join(projectDirectory, 'package.json'), 'utf8'),
    readFile(path.join(projectDirectory, 'frontend', 'src', 'remote', 'web-version.json'), 'utf8'),
    readFile(path.join(projectDirectory, 'backend', 'src', 'server.mjs'), 'utf8'),
    readFile(path.join(projectDirectory, 'scripts', 'deploy-web-ui.mjs'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageSource);
  const webVersion = JSON.parse(webVersionSource);

  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(webVersion.clientProtocol, 1);
  assert.notEqual(webVersion.version, packageJson.version);
  assert.equal(packageJson.scripts['build:web'], 'node scripts/build-web-ui.mjs');
  assert.equal(packageJson.scripts['deploy:web'], 'node scripts/deploy-web-ui.mjs');
  assert.match(relaySource, /web-version\.json/);
  assert.doesNotMatch(deployScript, /electron-builder|npm run pack/);
});
