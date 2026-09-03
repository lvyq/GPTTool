(() => {
  const $ = (id) => document.getElementById(id);
  const loginView = $('loginView'); const devicesView = $('devicesView'); const message = $('message'); const deviceList = $('deviceList');
  let refreshTimer;
  let pendingPairingCode = pairingCodeFromHash();
  let pendingRemoval;
  let scannerStream;
  let scannerFrame;
  let scannerBusy = false;
  let lastScannerDecodeAt = 0;
  let messageTimer;

  $('showLogin').addEventListener('click', () => setAuthMode('login'));
  $('showRegister').addEventListener('click', () => setAuthMode('register'));
  $('loginToRegister').addEventListener('click', () => setAuthMode('register'));
  $('registerToLogin').addEventListener('click', () => setAuthMode('login'));
  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await action(async () => {
      await api('api/login', { method: 'POST', body: { username: $('loginUsername').value, password: $('loginPassword').value } });
      $('loginPassword').value = ''; await loadSession();
    }, event.submitter);
  });
  $('registerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await action(async () => {
      if ($('registerPassword').value !== $('confirmPassword').value) throw new Error('两次输入的密码不一致');
      await api('api/register', {
        method: 'POST',
        body: {
          username: $('registerUsername').value,
          password: $('registerPassword').value,
          confirmPassword: $('confirmPassword').value,
          website: $('website').value,
        },
      });
      event.target.reset();
      await loadSession();
      showMessage('账号创建成功');
    }, event.submitter);
  });
  $('passwordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await action(async () => { await api('api/password', { method: 'POST', body: { currentPassword: $('currentPassword').value, nextPassword: $('nextPassword').value } }); event.target.reset(); $('accountDialog').close(); showMessage('密码已更新'); }, event.submitter);
  });
  $('showAccountSettings').addEventListener('click', () => $('accountDialog').showModal());
  $('closeAccountSettings').addEventListener('click', () => $('accountDialog').close());
  $('accountDialog').addEventListener('click', (event) => { if (event.target === $('accountDialog')) $('accountDialog').close(); });
  $('cancelRemoveDevice').addEventListener('click', closeRemoveDevice);
  $('cancelRemoveDeviceTop').addEventListener('click', closeRemoveDevice);
  $('removeDeviceDialog').addEventListener('click', (event) => { if (event.target === $('removeDeviceDialog')) closeRemoveDevice(); });
  $('startQrScanner').addEventListener('click', () => void openQrScanner());
  $('closeQrScanner').addEventListener('click', closeQrScanner);
  $('qrScannerDialog').addEventListener('click', (event) => { if (event.target === $('qrScannerDialog')) closeQrScanner(); });
  $('qrScannerDialog').addEventListener('close', stopQrScanner);
  $('qrImagePicker').addEventListener('change', (event) => void scanQrImage(event.target.files?.[0]));
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopQrScanner(); });
  $('confirmRemoveDevice').addEventListener('click', () => action(async () => {
    if (!pendingRemoval) return;
    const device = pendingRemoval;
    closeRemoveDevice();
    await api(`api/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
    await loadDevices();
    showMessage(`已移除 ${device.name}`);
  }));
  $('logout').addEventListener('click', () => action(async () => { await api('api/logout', { method: 'POST', body: {} }); await loadSession(); }));

  $('pairingNotice').classList.toggle('hidden', !pendingPairingCode);
  void action(loadSession);

  async function loadSession() {
    clearInterval(refreshTimer);
    const session = await api('api/session');
    $('showRegister').classList.toggle('hidden', session.registrationOpen === false);
    $('loginToRegister').classList.toggle('hidden', session.registrationOpen === false);
    $('systemAnnouncement').textContent = session.announcement || '';
    $('systemAnnouncement').classList.toggle('hidden', !session.announcement);
    if (session.registrationOpen === false && !$('registerForm').classList.contains('hidden')) setAuthMode('login');
    loginView.classList.toggle('hidden', session.authenticated);
    devicesView.classList.toggle('hidden', !session.authenticated);
    if (!session.authenticated) {
      setAuthMode('login');
      return;
    }
    $('welcome').textContent = `${session.user.username} 的设备`;
    let pairingError;
    if (pendingPairingCode) {
      const code = pendingPairingCode;
      pendingPairingCode = '';
      clearPairingFragment();
      try {
        await api('api/pair/claim', { method: 'POST', body: { code } });
        showMessage('设备已通过二维码绑定');
      } catch (error) {
        pairingError = error;
      }
    }
    await loadDevices(); refreshTimer = setInterval(() => void loadDevices(), 5000);
    if (pairingError) throw pairingError;
  }

  async function loadDevices() {
    const result = await api('api/devices');
    $('deviceCount').textContent = `${result.devices.length} 台`;
    deviceList.replaceChildren();
    if (!result.devices.length) { const empty = document.createElement('article'); empty.className = 'card empty'; empty.textContent = '还没有设备，请使用手机相机扫描电脑端显示的配对二维码。'; deviceList.append(empty); return; }
    for (const device of result.devices) {
      const card = document.createElement('article'); card.className = 'device-card';
      const info = document.createElement('div'); info.className = 'device-info';
      const glyph = document.createElement('div'); glyph.className = 'device-glyph'; glyph.setAttribute('aria-hidden', 'true'); glyph.textContent = '▱';
      const copy = document.createElement('div'); copy.className = 'device-copy';
      const title = document.createElement('h3'); title.textContent = device.name;
      const ready = device.online && device.serviceState === 'running';
      const starting = device.online && device.serviceState === 'starting';
      const status = document.createElement('p'); status.className = device.online ? 'online' : 'offline';
      const dot = document.createElement('span'); dot.className = 'status-dot'; dot.setAttribute('aria-hidden', 'true');
      status.append(dot, document.createTextNode(!device.online ? '离线' : ready ? '在线 · 可以远程控制' : starting ? '正在启动远程控制…' : device.serviceState === 'failed' ? `启动失败 · ${device.message || '请在电脑端检查'}` : '在线待机 · 可远程启动'));
      copy.append(title, status); info.append(glyph, copy);
      const actions = document.createElement('div'); actions.className = 'actions';
      const open = document.createElement(ready ? 'a' : 'button'); open.className = 'primary';
      if (ready) { open.textContent = '打开 →'; open.href = `device/${encodeURIComponent(device.id)}/`; }
      else if (!device.online) { open.textContent = '当前离线'; open.disabled = true; }
      else {
        open.type = 'button'; open.textContent = starting ? '启动中…' : '启动控制'; open.disabled = starting;
        open.addEventListener('click', () => void startRemoteControl(device, open));
      }
      const revoke = document.createElement('button'); revoke.className = 'danger'; revoke.type = 'button'; revoke.textContent = `移除 ${device.name}`; revoke.setAttribute('aria-label', `移除设备 ${device.name}`); revoke.title = '移除设备'; revoke.addEventListener('click', () => openRemoveDevice(device));
      actions.append(open, revoke); card.append(info, actions); deviceList.append(card);
    }
  }

  async function startRemoteControl(device, button) {
    await action(async () => {
      button.disabled = true; button.textContent = '启动中…';
      await api(`api/devices/${encodeURIComponent(device.id)}/start`, { method: 'POST', body: {} });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const result = await api('api/devices');
        const current = result.devices.find((item) => item.id === device.id);
        if (!current?.online) throw new Error('电脑连接已断开');
        if (current.serviceState === 'failed') throw new Error(current.message || '远程控制启动失败');
        if (current.serviceState === 'running') { location.href = `device/${encodeURIComponent(device.id)}/`; return; }
      }
      throw new Error('启动等待超时，请检查电脑端状态');
    });
  }

  async function claimPairingCode(code, successMessage) {
    await api('api/pair/claim', { method: 'POST', body: { code } });
    await loadDevices();
    showMessage(successMessage);
  }

  async function openQrScanner() {
    const dialog = $('qrScannerDialog');
    scannerBusy = false;
    $('qrScannerStatus').textContent = '正在启动相机…';
    if (!dialog.open) dialog.showModal();
    stopQrScanner();
    if (!navigator.mediaDevices?.getUserMedia) {
      $('qrScannerStatus').textContent = '当前浏览器无法直接打开相机，请从相册选择二维码';
      return;
    }
    try {
      scannerStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } },
      });
      const video = $('qrScannerVideo');
      video.srcObject = scannerStream;
      await video.play();
      $('qrScannerStatus').textContent = '请将电脑端显示的二维码放入框内';
      scannerFrame = requestAnimationFrame(scanCameraFrame);
    } catch (error) {
      console.warn('Unable to start QR camera', error);
      $('qrScannerStatus').textContent = '无法使用相机，请允许相机权限或从相册选择二维码';
      stopQrScanner();
    }
  }

  function closeQrScanner() {
    stopQrScanner();
    if ($('qrScannerDialog').open) $('qrScannerDialog').close();
    $('qrImagePicker').value = '';
  }

  function stopQrScanner() {
    if (scannerFrame) cancelAnimationFrame(scannerFrame);
    scannerFrame = undefined;
    for (const track of scannerStream?.getTracks?.() || []) track.stop();
    scannerStream = undefined;
    const video = $('qrScannerVideo');
    if (video) video.srcObject = null;
  }

  function scanCameraFrame() {
    const video = $('qrScannerVideo');
    if (!scannerStream || scannerBusy || !$('qrScannerDialog').open) return;
    const now = performance.now();
    if (now - lastScannerDecodeAt < 90) {
      scannerFrame = requestAnimationFrame(scanCameraFrame);
      return;
    }
    lastScannerDecodeAt = now;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth && video.videoHeight) {
      const value = decodeQrSource(video, video.videoWidth, video.videoHeight);
      if (value) {
        void handleScannedValue(value);
        return;
      }
    }
    scannerFrame = requestAnimationFrame(scanCameraFrame);
  }

  async function scanQrImage(file) {
    if (!file) return;
    scannerBusy = true;
    stopQrScanner();
    $('qrScannerStatus').textContent = '正在识别二维码…';
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    try {
      const loaded = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('无法读取所选图片'));
      });
      image.src = objectUrl;
      await loaded;
      const value = decodeQrSource(image, image.naturalWidth, image.naturalHeight);
      if (!value) {
        scannerBusy = false;
        $('qrScannerStatus').textContent = '没有识别到配对二维码，请换一张更清晰的图片';
        return;
      }
      scannerBusy = false;
      await handleScannedValue(value);
    } catch (error) {
      scannerBusy = false;
      $('qrScannerStatus').textContent = error.message || '二维码识别失败';
    } finally {
      URL.revokeObjectURL(objectUrl);
      $('qrImagePicker').value = '';
    }
  }

  function decodeQrSource(source, width, height) {
    const decoder = globalThis.GPTToolQrDecoder;
    if (!decoder?.decode || !width || !height) return '';
    const canvas = $('qrScannerCanvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const shorterSide = Math.min(width, height);
    const centerSize = Math.round(shorterSide * .86);
    const attempts = [
      { x: Math.round((width - centerSize) / 2), y: Math.round((height - centerSize) / 2), width: centerSize, height: centerSize },
      { x: 0, y: 0, width, height },
    ];
    for (const crop of attempts) {
      const maxSide = 1024;
      const scale = Math.min(1, maxSide / Math.max(crop.width, crop.height));
      canvas.width = Math.max(1, Math.round(crop.width * scale));
      canvas.height = Math.max(1, Math.round(crop.height * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
      const value = decoder.decode(context.getImageData(0, 0, canvas.width, canvas.height));
      if (value) return value;
    }
    return '';
  }

  async function handleScannedValue(value) {
    if (scannerBusy) return;
    const code = pairingCodeFromScannedValue(value);
    if (!code) {
      $('qrScannerStatus').textContent = '这不是 GPTTool 设备配对二维码';
      scannerFrame = requestAnimationFrame(scanCameraFrame);
      return;
    }
    scannerBusy = true;
    stopQrScanner();
    $('qrScannerStatus').textContent = '已识别，正在绑定设备…';
    try {
      await claimPairingCode(code, '设备已通过二维码绑定');
      closeQrScanner();
    } catch (error) {
      scannerBusy = false;
      $('qrScannerStatus').textContent = error.message || '设备绑定失败';
      showMessage(error.message || String(error), true);
    }
  }

  async function api(relative, options = {}) {
    const response = await fetch(relative, { method: options.method || 'GET', headers: options.body ? { 'Content-Type': 'application/json' } : undefined, body: options.body ? JSON.stringify(options.body) : undefined });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value;
  }
  async function action(callback, trigger) {
    const originalLabel = trigger?.textContent;
    if (trigger) {
      trigger.disabled = true;
      trigger.classList.add('is-busy');
      trigger.setAttribute('aria-busy', 'true');
      trigger.textContent = '处理中…';
    }
    try {
      showMessage('');
      await callback();
    } catch (error) {
      showMessage(error.message || String(error), true);
    } finally {
      if (trigger?.isConnected) {
        trigger.disabled = false;
        trigger.classList.remove('is-busy');
        trigger.removeAttribute('aria-busy');
        trigger.textContent = originalLabel;
      }
    }
  }
  function showMessage(value, error = false) {
    clearTimeout(messageTimer);
    messageTimer = undefined;
    message.textContent = value;
    message.className = value ? (error ? 'error' : 'success') : '';
    if (!value) return;
    messageTimer = setTimeout(() => {
      if (message.textContent !== value) return;
      message.textContent = '';
      message.className = '';
      messageTimer = undefined;
    }, error ? 6_000 : 2_800);
  }
  function setAuthMode(mode) {
    const registering = mode === 'register';
    $('loginForm').classList.toggle('hidden', registering);
    $('registerForm').classList.toggle('hidden', !registering);
    $('showLogin').classList.toggle('active', !registering);
    $('showRegister').classList.toggle('active', registering);
    $('showLogin').setAttribute('aria-selected', String(!registering));
    $('showRegister').setAttribute('aria-selected', String(registering));
    $('authEyebrow').textContent = registering ? '创建账号' : '账号登录';
    $('authTitle').textContent = registering ? '开始使用 GPTTool' : '欢迎回来';
    $('authDescription').textContent = registering ? '注册后即可绑定并远程访问自己的设备。' : '登录后仅显示绑定到当前账号的设备。';
    showMessage('');
    requestAnimationFrame(() => (registering ? $('registerUsername') : $('loginUsername')).focus());
  }
  function openRemoveDevice(device) {
    pendingRemoval = device;
    $('removeDeviceTitle').textContent = `移除“${device.name}”？`;
    $('removeDeviceDialog').showModal();
  }
  function closeRemoveDevice() {
    pendingRemoval = undefined;
    if ($('removeDeviceDialog').open) $('removeDeviceDialog').close();
  }
  function pairingCodeFromHash() {
    const code = new URLSearchParams(location.hash.slice(1)).get('pair')?.trim().toUpperCase() || '';
    return /^[0-9A-F]{8}$/.test(code) ? code : '';
  }
  function pairingCodeFromScannedValue(value) {
    const direct = String(value || '').trim().toUpperCase();
    if (/^[0-9A-F]{8}$/.test(direct)) return direct;
    try {
      const target = new URL(String(value || '').trim());
      if (target.origin !== location.origin) return '';
      const code = new URLSearchParams(target.hash.slice(1)).get('pair')?.trim().toUpperCase() || '';
      return /^[0-9A-F]{8}$/.test(code) ? code : '';
    } catch {
      return '';
    }
  }
  function clearPairingFragment() {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    $('pairingNotice').classList.add('hidden');
  }
})();
