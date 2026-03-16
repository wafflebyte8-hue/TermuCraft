const state = {
  ws: null,
  reconnectTimer: null,
  bootstrapped: false,
  filter: 'all',
  logs: [],
  players: [],
  config: {},
  props: {},
  stats: { cpu: 0, ram: 0, diskUsed: 0, diskTotal: 0 },
  network: { lanIp: '', mcPort: '25565', panelPort: '8080' },
  download: null,
  selectedVersionType: 'paper',
  selectedFileKey: 'server.properties',
  selectedFileEditable: false,
  backups: [],
  managedFiles: [],
  folders: { plugins: [], mods: [], datapacks: [], logs: [] },
  admin: { whitelist: [], ops: [], bans: [] },
  validation: null,
  presets: {},
  integrity: {},
};

const AUTH_DISABLED = true;

async function api(path, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (init.body && typeof init.body !== 'string') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(init.body);
  }

  const response = await fetch(path, init);
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (response.status === 401) {
    showLogin(true, 'Authentication required');
    throw new Error(data.error || 'Authentication required');
  }
  if (!response.ok || data.error) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function $(id) {
  return document.getElementById(id);
}

function normalizeHandle(value) {
  return String(value || '').trim().toLowerCase();
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function parseMemoryToMB(value) {
  const match = String(value || '').trim().toUpperCase().match(/^(\d+(?:\.\d+)?)([KMGTP])?B?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2] || 'M';
  const mult = { K: 1 / 1024, M: 1, G: 1024, T: 1048576, P: 1073741824 }[unit] || 1;
  return amount * mult;
}

function getMemoryLimitMB() {
  return parseMemoryToMB($('sRam')?.value || state.config.memory || '');
}

function toast(message, type = 'ok') {
  const node = $('toast');
  node.textContent = message;
  node.className = `show ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.className = '';
  }, 2600);
}

function showShell(show) {
  const shell = $('appShell');
  if (!shell) return;
  shell.classList.toggle('app-shell-hidden', !show);
}

function disableAuthUI() {
  $('loginGate')?.setAttribute('hidden', '');
  $('logoutBtn')?.setAttribute('hidden', '');
  $('authPanel')?.setAttribute('hidden', '');
  $('authUser').textContent = 'local';
}

function showLogin(show, note = '') {
  if (AUTH_DISABLED) {
    disableAuthUI();
    showShell(true);
    return;
  }
  $('loginGate').classList.toggle('visible', show);
  $('loginNote').textContent = note;
  showShell(!show);
  if (show) {
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
  }
}

async function checkAuth() {
  if (AUTH_DISABLED) {
    disableAuthUI();
    showLogin(false);
    return true;
  }
  const status = await fetch('/api/auth/status').then((res) => res.json());
  const handle = status.handle || status.username || '';
  $('authUser').textContent = handle || 'guest';
  $('authUsername').value = handle;
  if (status.authenticated) {
    showLogin(false);
    if (status.bootstrap) {
      toast('Bootstrap credentials are still active. Change them in Settings.', 'info');
    }
    return true;
  }
  showLogin(true);
  return false;
}

async function login(event) {
  if (AUTH_DISABLED) {
    event.preventDefault();
    showLogin(false);
    return;
  }
  event.preventDefault();
  const handle = normalizeHandle($('loginUsername').value);
  const secret = $('loginPassword').value;
  try {
    const result = await api('/api/auth/login', { method: 'POST', body: { handle, secret } });
    const resolvedHandle = result.handle || result.username;
    $('authUser').textContent = resolvedHandle;
    $('authUsername').value = resolvedHandle;
    $('loginPassword').value = '';
    showLogin(false);
    await bootstrap();
  } catch (error) {
    $('loginNote').textContent = error.message;
    const card = $('loginForm');
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 500);
  }
}

async function logout() {
  if (AUTH_DISABLED) {
    toast('Auth is disabled in this build.', 'info');
    return;
  }
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // Ignore logout failures.
  }
  $('authUser').textContent = 'guest';
  showLogin(true, 'Logged out');
}

function connectSocket() {
  if (state.ws) return;
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${protocol}://${location.host}`);
  state.ws.onopen = () => setWsStatus(true);
  state.ws.onmessage = (event) => handleSocket(JSON.parse(event.data));
  state.ws.onclose = (event) => {
    state.ws = null;
    setWsStatus(false);
    if (event.code === 4001) {
      showLogin(true, 'Session expired');
      return;
    }
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => {
      if (!$('loginGate').classList.contains('visible')) connectSocket();
    }, 2000);
  };
}

function handleSocket(message) {
  if (message.type === 'history') {
    state.logs = message.logs || [];
    renderLogs();
    return;
  }
  if (message.type === 'log') {
    state.logs.push(message);
    if (state.logs.length > 3000) state.logs.shift();
    appendLog(message);
    return;
  }
  if (message.type === 'status') {
    applyStatus(message);
    return;
  }
  if (message.type === 'players') {
    state.players = message.players || [];
    renderPlayers();
    return;
  }
  if (message.type === 'uptime') {
    updateUptime(message.uptime);
    return;
  }
  if (message.type === 'config') {
    applyConfig(message.config);
    return;
  }
  if (message.type === 'stats') {
    state.stats = { ...state.stats, ...message };
    updateStats();
    return;
  }
  if (message.type === 'download') {
    state.download = message;
    renderDownload();
    return;
  }
  if (message.type === 'jarReady') {
    toast('Server software is ready.', 'ok');
    loadStatus();
  }
}

function applyStatus(status) {
  state.players = status.players || [];
  state.network = status.network || state.network;
  state.download = status.download || state.download;
  state.pendingRestart = status.pendingRestart || null;
  state.lastCrash = status.lastCrash || null;

  const running = !!status.running;
  const wasStopped = $('statusBadge').classList.contains('stopped');
  $('statusBadge').className = `status-badge ${running ? 'running' : 'stopped'}`;
  $('badgeTxt').textContent = running ? 'RUNNING' : 'STOPPED';
  if (running && wasStopped) {
    void $('statusBadge').offsetWidth;
    $('statusBadge').classList.add('burst');
    setTimeout(() => $('statusBadge').classList.remove('burst'), 600);
  }
  $('btnStart').disabled = running;
  $('btnStopTop').disabled = !running;
  $('btnRestart').disabled = !running;
  $('btnKillTop').disabled = !running;
  $('cmdi').disabled = !running;
  $('sendCmdBtn').disabled = !running;
  $('dStatus').textContent = running ? 'Currently running' : 'Not currently running';
  updateUptime(status.uptime);
  renderPlayers();
  renderHealth(status);
  applyConfig(status.config || state.config);
  applyNetwork(status.network || state.network);
}

function applyConfig(config) {
  if (!config) return;
  state.config = { ...state.config, ...config };
  $('sRam').value = state.config.memory || '';
  $('sJar').value = state.config.serverJar || '';
  $('sDir').value = state.config.serverDir || '';
  $('sJava').value = state.config.javaPath || '';
  $('authUsername').value = $('authUser').textContent === 'guest' ? (state.config.authUsername || '') : $('authUser').textContent;
  $('autoRestart').checked = !!state.config.autoRestart;
  $('autoRestartDelay').value = state.config.autoRestartDelaySec ?? 10;
  $('backupRetention').value = state.config.backupRetention ?? 5;
  $('schedBackup').value = state.config.scheduleBackupMinutes ?? 0;
  $('schedBroadcast').value = state.config.scheduleBroadcastMinutes ?? 0;
  $('schedMessage').value = state.config.scheduleBroadcastMessage || '';
  $('schedRestart').value = state.config.scheduleRestartTime || '';
  $('cfgType').textContent = state.config.serverType || '-';
  $('cfgVersion').textContent = state.config.serverVersion || '-';
  $('cfgJava').textContent = state.validation?.javaVersion || '-';
  $('ciType').textContent = state.config.serverType || '-';
  $('ciVer').textContent = state.config.serverVersion || '-';
  $('iJar').textContent = state.config.serverJar || '-';
  $('iDir').textContent = state.config.serverDir || '-';
  updateStats();
}

function applyNetwork(network) {
  if (!network) return;
  state.network = { ...state.network, ...network };
  const protocol = state.network.panelProtocol || 'http';
  const port = protocol === 'https'
    ? (state.network.panelSecurePort || state.network.panelPort || location.port || 8443)
    : (state.network.panelPort || location.port || 8080);
  $('serverAddr').textContent = `${state.network.lanIp || 'localhost'}:${port}`;
  $('ciIP').textContent = state.network.lanIp || location.hostname;
  $('ciPort').textContent = state.network.mcPort || '25565';
  $('panelLAN').textContent = `${protocol}://${state.network.lanIp || location.hostname}:${port}`;
  $('aLAN').textContent = `${state.network.lanIp || location.hostname}:${state.network.mcPort || '25565'}`;
}

function updateUptime(uptime) {
  $('tUp').textContent = uptime || '-';
  $('dUp').textContent = uptime || 'Offline';
  $('dUp').className = uptime ? 'stat-value' : 'stat-value dim';
}

function updateStats() {
  const cpu = Number(state.stats.cpu) || 0;
  const ramMB = Number(state.stats.ram) || 0;
  const ramLimitMB = getMemoryLimitMB();
  const ramPct = ramLimitMB > 0 ? Math.min((ramMB / ramLimitMB) * 100, 100) : 0;
  const diskUsed = Number(state.stats.diskUsed) || 0;
  const diskTotal = Number(state.stats.diskTotal) || 0;
  const diskPct = diskTotal > 0 ? Math.min((diskUsed / diskTotal) * 100, 100) : 0;
  const cpuColor = cpu > 70 ? 'var(--red)' : cpu > 40 ? 'var(--amber)' : 'var(--green)';
  const ramColor = ramPct > 80 ? 'var(--red)' : ramPct > 60 ? 'var(--amber)' : 'var(--green)';
  const diskColor = diskPct > 90 ? 'var(--red)' : diskPct > 75 ? 'var(--amber)' : 'var(--blue)';
  flashIfChanged('tCpu', `${cpu.toFixed(cpu % 1 ? 1 : 0)}%`);
  flashIfChanged('tRam', ramMB >= 1024 ? `${(ramMB / 1024).toFixed(1)}G` : `${Math.round(ramMB)}M`);
  $('dCpu').textContent = `${cpu.toFixed(cpu % 1 ? 1 : 0)}%`;
  $('dRam').textContent = ramMB >= 1024 ? `${(ramMB / 1024).toFixed(1)} GB` : `${Math.round(ramMB)} MB`;
  $('dDisk').textContent = fmtBytes(diskUsed);
  $('cpuSub').textContent = 'of 200% max';
  $('ramSub').textContent = ramLimitMB > 0 ? `of ${fmtBytes(ramLimitMB * 1024 * 1024)} (${ramPct.toFixed(1)}%)` : 'Memory limit unavailable';
  $('diskSub').textContent = diskTotal > 0 ? `of ${fmtBytes(diskTotal)} (${diskPct.toFixed(1)}%)` : 'Storage unavailable';
  $('cpuBar').style.width = `${Math.min(cpu / 2, 100)}%`;
  $('ramBar').style.width = `${ramPct}%`;
  $('diskBar').style.width = `${diskPct}%`;
  $('dCpu').style.color = cpuColor;
  $('dRam').style.color = ramColor;
  $('dDisk').style.color = diskColor;
  $('cpuBar').style.background = cpuColor;
  $('ramBar').style.background = ramColor;
  $('diskBar').style.background = diskColor;
}

function renderHealth(status = {}) {
  const pending = status.pendingRestart || state.pendingRestart;
  const lastCrash = status.lastCrash || state.lastCrash;
  $('healthCrash').textContent = lastCrash?.lastCrashAt
    ? `${lastCrash.lastCrashReason || 'Crash'} at ${lastCrash.lastCrashAt}`
    : 'No crash recorded';
  $('healthRestart').textContent = pending
    ? `${pending.reason} at ${pending.eta}`
    : 'No restart pending';
  $('healthBackups').textContent = `${status.backupCount ?? state.backups.length} backups`;
  $('healthChecksum').textContent = state.config.lastDownloadedChecksum
    ? `${state.config.lastDownloadedChecksumType || 'sha256'} ${state.config.lastDownloadedChecksum}`
    : 'No server jar checksum yet';
  $('jarChecksum').textContent = state.config.lastDownloadedChecksum
    ? `${state.config.lastDownloadedChecksumType || 'sha256'} ${state.config.lastDownloadedChecksum}`
    : 'No checksum recorded';
  $('iEx').textContent = status.jarExists ? 'Yes' : 'No';
}

function renderLogs() {
  $('console').innerHTML = '';
  state.logs.forEach((entry) => appendLog(entry, true));
}

function appendLog(entry, force = false) {
  if (!force && state.filter !== 'all' && entry.type !== state.filter) return;
  const row = document.createElement('div');
  row.className = `ll ${entry.type || 'log'}`;
  row.innerHTML = `<span class="lt">${esc(entry.time || '')}</span><span class="lm">${esc(entry.text || '')}</span>`;
  if (!force) {
    row.classList.add('new');
    setTimeout(() => row.classList.remove('new'), 700);
  }
  $('console').appendChild(row);
  if ($('autoScroll').checked) $('console').scrollTop = $('console').scrollHeight;
  if (!force) { updateMiniConsole(); updateJumpLatest(); }
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll('[data-filter]').forEach((node) => {
    node.classList.toggle('on', node.dataset.filter === filter);
  });
  renderLogs();
}

function renderPlayers() {
  const prev = parseInt($('tPl').textContent) || 0;
  const curr = state.players.length;
  $('tPl').textContent = String(curr);
  $('plCount').textContent = `${curr} online`;
  if (prev !== curr) {
    $('tPl').classList.remove('bounce');
    void $('tPl').offsetWidth;
    $('tPl').classList.add('bounce');
    setTimeout(() => $('tPl').classList.remove('bounce'), 500);
  }
  if (!state.players.length) {
    $('plList').innerHTML = '<div class="empty-state"><div class="es-icon">👥</div><div class="es-txt">No players online</div></div>';
    renderMiniPlayers();
    return;
  }
  $('plList').innerHTML = state.players.map((player) => `
    <div class="prow entering">
      <div class="pavatar">
        <img src="https://crafatar.com/avatars/${esc(player.name)}?size=34&overlay" alt="${esc(player.name)}" onerror="this.parentNode.innerHTML='&#x1F9D1;'" />
      </div>
      <div class="propinfo">
        <div class="propname">${esc(player.name)}</div>
        <div class="propkey">Online now</div>
      </div>
      <div class="pacts">
        <button class="abtn ghost sm" data-player-action="op" data-player-name="${esc(player.name)}">OP</button>
        <button class="abtn ghost sm" data-player-action="heal" data-player-name="${esc(player.name)}">Heal</button>
        <button class="abtn ghost sm" data-player-action="feed" data-player-name="${esc(player.name)}">Feed</button>
        <button class="abtn danger sm" data-player-action="kick" data-player-name="${esc(player.name)}">Kick</button>
        <button class="abtn danger sm" data-player-action="ban" data-player-name="${esc(player.name)}">Ban</button>
      </div>
    </div>
  `).join('');
  renderMiniPlayers();
}

function renderAdminList(type) {
  const targetId = type === 'whitelist' ? 'whitelistList' : type === 'ops' ? 'opsList' : 'bansList';
  const entries = state.admin[type] || [];
  if (!entries.length) {
    $(targetId).innerHTML = '<div class="empty">No entries</div>';
    return;
  }
  $(targetId).innerHTML = entries.map((entry) => `
    <div class="list-row">
      <div class="propinfo">
        <div class="propname">${esc(entry.name)}</div>
        <div class="propkey">${esc(entry.uuid || entry.reason || '')}</div>
      </div>
      <button class="abtn danger sm" data-admin-remove="${type}" data-admin-name="${esc(entry.name)}">Remove</button>
    </div>
  `).join('');
}

function renderBackups() {
  $('healthBackups').textContent = `${state.backups.length} backups`;
  $('backupMeta').textContent = `Retention: ${state.config.backupRetention ?? 5} backups. Scheduled backup every ${state.config.scheduleBackupMinutes || 0} minutes.`;
  if (!state.backups.length) {
    $('backupList').innerHTML = '<div class="empty">No backups yet</div>';
    return;
  }
  $('backupList').innerHTML = state.backups.map((backup) => `
    <div class="list-row">
      <div class="propinfo">
        <div class="propname">${esc(backup.label || backup.id)}</div>
        <div class="propkey">${esc(backup.createdAt)} | ${fmtBytes(backup.size)}</div>
      </div>
      <div class="filter-row">
        <button class="abtn ghost sm" data-restore-backup="${esc(backup.id)}">Restore</button>
        <button class="abtn danger sm" data-delete-backup="${esc(backup.id)}">Delete</button>
      </div>
    </div>
  `).join('');
  renderMiniBackups();
}

function renderFiles() {
  if (!state.managedFiles.length) {
    $('fileList').innerHTML = '<div class="empty">No managed files</div>';
  } else {
    $('fileList').innerHTML = state.managedFiles.map((file) => `
      <button class="file-item ${state.selectedFileKey === file.key ? 'active' : ''}" data-file-key="${esc(file.key)}">
        <span>${esc(file.label)}</span>
        <span class="propkey">${file.exists ? fmtBytes(file.size) : 'missing'}</span>
      </button>
    `).join('');
  }

  const renderFolderRows = (items, empty) => items.length
    ? items.map((item) => `<div class="list-row compact"><span>${esc(item.name)}</span><span class="propkey">${item.sha256 ? item.sha256.slice(0, 12) : fmtBytes(item.size)}</span></div>`).join('')
    : `<div class="empty">${empty}</div>`;

  $('pluginsFolderList').innerHTML = renderFolderRows(state.folders.plugins, 'No plugins');
  $('modsFolderList').innerHTML = renderFolderRows(state.folders.mods, 'No mods');
  $('extraFolderList').innerHTML = `
    <div class="propkey" style="margin-bottom: 8px">Datapacks</div>
    ${renderFolderRows(state.folders.datapacks, 'No datapacks')}
    <div class="propkey" style="margin: 12px 0 8px">Logs</div>
    ${renderFolderRows(state.folders.logs, 'No log files')}
  `;
}

function renderDownload() {
  if (!state.download) return;
  $('dlProg').classList.add('vis');
  const total = Number(state.download.total) || 0;
  const progress = Number(state.download.progress) || 0;
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  $('dlName').textContent = state.download.name || 'Downloading...';
  $('dlPct').textContent = `${state.download.done ? 100 : pct}%`;
  $('pbf').style.width = `${state.download.done ? 100 : pct}%`;
  $('pbf').className = `pbfill${state.download.error ? ' err' : state.download.done ? ' done' : ' loading'}`;
  $('dlSub').textContent = state.download.error
    ? `Error: ${state.download.error}`
    : state.download.done
      ? `Complete${state.download.checksum ? ` | sha256 ${state.download.checksum}` : ''}`
      : `${fmtBytes(progress)} / ${fmtBytes(total)}`;
}

function renderValidation() {
  if (!state.validation) return;
  $('valJava').textContent = state.validation.javaVersion || '-';
  $('valNode').textContent = state.validation.nodeVersion || '-';
  $('valRam').textContent = `${state.validation.totalRamMB || 0} MB`;
  $('cfgJava').textContent = state.validation.javaVersion || '-';
  $('validationSummary').innerHTML = `
    <div class="list-row compact"><span>Suggested RAM</span><span>${state.validation.suggestedRamMB || 0} MB</span></div>
    <div class="list-row compact"><span>Configured RAM</span><span>${state.validation.configuredRamMB || 0} MB</span></div>
    <div class="list-row compact"><span>Backups</span><span>${state.validation.backupCount || 0}</span></div>
    <div class="list-row compact"><span>Last crash</span><span>${state.validation.lastCrash?.lastCrashAt || 'none'}</span></div>
  `;
  $('validationList').innerHTML = (state.validation.checks || []).map((check) => `
    <div class="list-row">
      <div class="propinfo">
        <div class="propname">${esc(check.label)}</div>
        <div class="propkey">${esc(check.detail)}</div>
      </div>
      <span class="check-pill ${check.ok ? 'ok' : 'bad'}">${check.ok ? 'OK' : 'WARN'}</span>
    </div>
  `).join('');
}

function renderPresets() {
  const entries = Object.entries(state.presets || {});
  if (!entries.length) {
    $('presetList').innerHTML = '<div class="empty">No presets available</div>';
    return;
  }
  $('presetList').innerHTML = entries.map(([key, preset]) => `
    <div class="list-row">
      <div class="propinfo">
        <div class="propname">${esc(preset.label)}</div>
        <div class="propkey">${esc(preset.description)} | ${esc(preset.memory)}</div>
      </div>
      <button class="abtn ${state.config.preset === key ? 'primary' : 'ghost'} sm" data-preset="${esc(key)}">${state.config.preset === key ? 'Applied' : 'Apply'}</button>
    </div>
  `).join('');
}

function setTab(name) {
  document.querySelectorAll('.tnav').forEach((node) => {
    node.classList.toggle('active', node.dataset.tabTarget === name);
  });
  document.querySelectorAll('.tab').forEach((node) => {
    node.classList.toggle('active', node.id === `tab-${name}`);
  });
  const activeBtn = document.querySelector(`.tnav[data-tab-target="${name}"]`);
  const ind = $('tabIndicator');
  if (activeBtn && ind) {
    ind.style.left = activeBtn.offsetLeft + 'px';
    ind.style.top = activeBtn.offsetTop + 'px';
    ind.style.width = activeBtn.offsetWidth + 'px';
    ind.style.height = activeBtn.offsetHeight + 'px';
  }
}

async function sendCommand(command) {
  if (!command.trim()) return;
  await api('/api/command', { method: 'POST', body: { command } });
}

async function serverAction(action) {
  const result = await api(`/api/${action}`, { method: 'POST' });
  toast(result.ok ? `${action} requested` : 'Done', 'ok');
}

async function saveSettings() {
  const config = await api('/api/config', {
    method: 'POST',
    body: {
      memory: $('sRam').value.trim(),
      serverJar: $('sJar').value.trim(),
      serverDir: $('sDir').value.trim(),
      javaPath: $('sJava').value.trim(),
      autoRestart: $('autoRestart').checked,
      autoRestartDelaySec: $('autoRestartDelay').value.trim(),
      backupRetention: $('backupRetention').value.trim(),
      scheduleBackupMinutes: $('schedBackup').value.trim(),
      scheduleBroadcastMinutes: $('schedBroadcast').value.trim(),
      scheduleBroadcastMessage: $('schedMessage').value,
      scheduleRestartTime: $('schedRestart').value.trim(),
    },
  });
  applyConfig(config.config);
  renderBackups();
  toast('Settings saved', 'ok');
  showBtnSuccess($('saveSettingsBtn'));
}

async function saveAuth() {
  if (AUTH_DISABLED) {
    toast('Panel auth is disabled for now.', 'info');
    return;
  }
  const handle = normalizeHandle($('authUsername').value);
  const currentSecret = $('authCurrentPassword').value;
  const nextSecret = $('authNewPassword').value;
  const result = await api('/api/auth/change', {
    method: 'POST',
    body: { handle, currentSecret, nextSecret },
  });
  $('authUser').textContent = result.handle || result.username;
  $('authCurrentPassword').value = '';
  $('authNewPassword').value = '';
  toast('Identity updated', 'ok');
  showBtnSuccess($('saveAuthBtn'));
}

async function loadStatus() {
  const status = await api('/api/status');
  applyStatus(status);
}

async function loadValidation() {
  state.validation = await api('/api/validation');
  renderValidation();
}

async function loadIntegrity() {
  state.integrity = await api('/api/integrity');
}

async function loadBackups() {
  const data = await api('/api/backups');
  state.backups = data.backups || [];
  renderBackups();
}

async function loadFiles() {
  const data = await api('/api/files');
  state.managedFiles = data.files || [];
  state.folders = data.directories || state.folders;
  renderFiles();
  if (state.managedFiles.some((file) => file.key === state.selectedFileKey)) {
    await openManagedFile(state.selectedFileKey);
  } else if (state.managedFiles[0]) {
    await openManagedFile(state.managedFiles[0].key);
  }
}

async function openManagedFile(key) {
  const result = await api(`/api/files/read?key=${encodeURIComponent(key)}`);
  state.selectedFileKey = result.key;
  state.selectedFileEditable = !!result.editable;
  $('fileTitle').textContent = result.label;
  $('fileChecksum').textContent = result.sha256 ? `Checksum: ${result.sha256}` : 'Checksum: -';
  $('fileEditor').value = result.content || '';
  $('fileEditor').disabled = !result.editable;
  $('saveFileBtn').disabled = !result.editable;
  renderFiles();
  setTimeout(() => {
    const af = document.querySelector('.file-item.active');
    if (af) { af.classList.add('flash'); setTimeout(() => af.classList.remove('flash'), 350); }
  }, 0);
}

async function loadAdminLists() {
  const [whitelist, ops, bans] = await Promise.all([
    api('/api/admin/whitelist'),
    api('/api/admin/ops'),
    api('/api/admin/bans'),
  ]);
  state.admin.whitelist = whitelist.entries || [];
  state.admin.ops = ops.entries || [];
  state.admin.bans = bans.entries || [];
  renderAdminList('whitelist');
  renderAdminList('ops');
  renderAdminList('bans');
}

async function loadMods() {
  const data = await api('/api/mods');
  const mods = data.mods || [];
  $('modCount').textContent = `${mods.length} mods`;
  $('modList').innerHTML = mods.length
    ? mods.map((item) => `<div class="list-row"><div class="propinfo"><div class="propname">${esc(item.name)}</div><div class="propkey">${fmtBytes(item.size)}${item.sha256 ? ` | ${item.sha256.slice(0, 12)}` : ''}</div></div><button class="abtn danger sm" data-delete-mod="${esc(item.name)}">Delete</button></div>`).join('')
    : '<div class="empty">No mods</div>';
}

async function loadPlugins() {
  const data = await api('/api/plugins');
  const plugins = data.plugins || [];
  $('plgCount').textContent = `${plugins.length} plugins`;
  $('plgList').innerHTML = plugins.length
    ? plugins.map((item) => `<div class="list-row"><div class="propinfo"><div class="propname">${esc(item.name)}</div><div class="propkey">${fmtBytes(item.size)}${item.sha256 ? ` | ${item.sha256.slice(0, 12)}` : ''}</div></div><button class="abtn danger sm" data-delete-plugin="${esc(item.name)}">Delete</button></div>`).join('')
    : '<div class="empty">No plugins</div>';
}

async function loadVersionList() {
  const data = await api(`/api/versions/${state.selectedVersionType}`);
  $('verSel').innerHTML = (data.versions || []).slice(0, 100).map((version) => `<option>${esc(version)}</option>`).join('');
}

async function loadProperties() {
  state.props = await api('/api/properties');
  $('motdInput').value = state.props.motd || state.config.motd || '';
  $('motdPreview').textContent = state.props.motd || state.config.motd || '';
  renderProperties(state.props, $('psrch').value.trim());
}

function renderProperties(data, search = '') {
  const groups = {};
  Object.entries(PMETA).forEach(([key, meta]) => {
    const value = data[key] ?? (meta.t === 'bool' ? 'false' : '');
    if (search && !key.includes(search.toLowerCase()) && !meta.l.toLowerCase().includes(search.toLowerCase())) return;
    groups[meta.g] = groups[meta.g] || [];
    groups[meta.g].push({ key, meta, value });
  });

  const other = Object.entries(data)
    .filter(([key]) => !PMETA[key] && (!search || key.includes(search.toLowerCase())))
    .map(([key, value]) => ({ key, value }));

  let html = '';
  Object.entries(groups).forEach(([group, props]) => {
    html += `<div class="pgrp"><div class="pgtitle">${esc(group)}</div>`;
    props.forEach(({ key, meta, value }) => {
      let input = '';
      if (meta.t === 'bool') {
        input = `<select class="pinput pnarrow" data-key="${esc(key)}"><option value="true" ${value === 'true' ? 'selected' : ''}>true</option><option value="false" ${value !== 'true' ? 'selected' : ''}>false</option></select>`;
      } else if (meta.t === 'sel') {
        input = `<select class="pinput" data-key="${esc(key)}">${meta.o.map((option) => `<option ${value === option ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select>`;
      } else {
        input = `<input class="pinput" data-key="${esc(key)}" type="${meta.t || 'text'}" value="${esc(value)}" />`;
      }
      html += `<div class="proprow"><div class="propinfo"><div class="propname">${esc(meta.l)}</div><div class="propkey">${esc(key)}</div></div>${input}</div>`;
    });
    html += '</div>';
  });

  if (other.length) {
    html += '<div class="pgrp"><div class="pgtitle">Other</div>';
    other.forEach(({ key, value }) => {
      html += `<div class="proprow"><div class="propinfo"><div class="propname">${esc(key)}</div></div><input class="pinput" data-key="${esc(key)}" value="${esc(value)}" /></div>`;
    });
    html += '</div>';
  }

  $('propsBox').innerHTML = html || '<div class="empty">No properties found</div>';
}

async function saveProperties() {
  const payload = {};
  document.querySelectorAll('[data-key]').forEach((node) => {
    payload[node.dataset.key] = node.value;
  });
  await api('/api/properties', { method: 'POST', body: payload });
  toast('Properties saved. Restart if needed.', 'ok');
}

async function saveMotd() {
  await api('/api/properties', { method: 'POST', body: { motd: $('motdInput').value } });
  $('motdPreview').textContent = $('motdInput').value || '';
  toast('MOTD saved', 'ok');
  showBtnSuccess($('saveMotdBtn'));
}

async function createBackup() {
  await api('/api/backups/create', { method: 'POST', body: { label: $('backupLabel').value.trim() } });
  $('backupLabel').value = '';
  await loadBackups();
  toast('Backup created', 'ok');
  const firstRow = $('backupList').querySelector('.list-row');
  if (firstRow) {
    firstRow.classList.add('new-row');
    setTimeout(() => firstRow.classList.remove('new-row'), 900);
  }
  renderMiniBackups();
}

async function restoreBackup(id) {
  await api(`/api/backups/${encodeURIComponent(id)}/restore`, { method: 'POST' });
  await Promise.all([loadBackups(), loadFiles(), loadProperties(), loadStatus()]);
  toast('Backup restored', 'ok');
}

async function deleteBackup(id) {
  await api(`/api/backups/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await loadBackups();
  toast('Backup deleted', 'ok');
}

async function addAdmin(type) {
  const map = { whitelist: 'whitelistName', ops: 'opName', bans: 'banName' };
  const input = $(map[type]);
  const name = input.value.trim();
  if (!name) throw new Error('Enter a username');
  const body = type === 'bans' ? { name, reason: 'Banned by admin' } : { name };
  await api(`/api/admin/${type}`, { method: 'POST', body });
  input.value = '';
  await loadAdminLists();
  toast('Entry added', 'ok');
}

async function removeAdmin(type, name) {
  await api(`/api/admin/${type}/${encodeURIComponent(name)}`, { method: 'DELETE' });
  await loadAdminLists();
  toast('Entry removed', 'ok');
}

async function uploadJar(kind) {
  const fileInput = kind === 'mods' ? $('modFile') : $('plgFile');
  const label = kind === 'mods' ? $('modUploadStatus') : $('plgUploadStatus');
  if (!fileInput.files[0]) throw new Error('Select a file first');
  const file = fileInput.files[0];
  label.textContent = 'Reading file...';
  const reader = new FileReader();
  await new Promise((resolve, reject) => {
    reader.onload = () => resolve();
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  label.textContent = `Uploading ${file.name}...`;
  const data = String(reader.result).split(',')[1];
  await api(`/api/${kind}/upload`, { method: 'POST', body: { filename: file.name, data } });
  label.textContent = 'Upload complete';
  fileInput.value = '';
  if (kind === 'mods') {
    $('modFileName').textContent = 'No file selected';
    $('uploadModBtn').disabled = true;
    await loadMods();
  } else {
    $('plgFileName').textContent = 'No file selected';
    $('uploadPlgBtn').disabled = true;
    await loadPlugins();
  }
  await loadFiles();
}

async function bootstrap() {
  if (!state.bootstrapped) {
    connectSocket();
    state.bootstrapped = true;
  } else if (!state.ws) {
    connectSocket();
  }

  await Promise.all([
    loadStatus(),
    loadValidation(),
    loadIntegrity(),
    loadBackups(),
    loadFiles(),
    loadAdminLists(),
    loadMods(),
    loadPlugins(),
    loadVersionList(),
    loadProperties(),
    api('/api/presets').then((data) => { state.presets = data.presets || {}; renderPresets(); }),
  ]);
}

function openPrompt(title, body, label, value = '') {
  return new Promise((resolve) => {
    $('modalTitle').textContent = title;
    $('modalBody').textContent = body;
    $('modalInputs').innerHTML = `<div class="minput"><label>${esc(label)}</label><input class="inp" id="modalInput" value="${esc(value)}" /></div>`;
    $('modal').classList.add('open');
    const cleanup = (result) => {
      $('modal').classList.remove('open');
      $('modalConfirmBtn').onclick = null;
      $('modalCancelBtn').onclick = null;
      resolve(result);
    };
    $('modalConfirmBtn').onclick = () => cleanup($('modalInput').value);
    $('modalCancelBtn').onclick = () => cleanup(null);
  });
}

function bindEvents() {
  $('loginForm').addEventListener('submit', login);
  $('logoutBtn').addEventListener('click', logout);
  $('btnStart').addEventListener('click', () => serverAction('start').catch((error) => toast(error.message, 'err')));
  $('btnStopTop').addEventListener('click', () => serverAction('stop').catch((error) => toast(error.message, 'err')));
  $('btnRestart').addEventListener('click', () => serverAction('restart').catch((error) => toast(error.message, 'err')));
  $('btnKillTop').addEventListener('click', () => serverAction('kill').catch((error) => toast(error.message, 'err')));
  $('sendCmdBtn').addEventListener('click', () => sendCommand($('cmdi').value).then(() => { $('cmdi').value = ''; }).catch((error) => toast(error.message, 'err')));
  $('cmdi').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('sendCmdBtn').click();
  });
  $('clearConsoleBtn').addEventListener('click', () => { state.logs = []; renderLogs(); });
  document.querySelectorAll('[data-tab-target]').forEach((node) => node.addEventListener('click', () => setTab(node.dataset.tabTarget)));
  document.querySelectorAll('[data-filter]').forEach((node) => node.addEventListener('click', () => setFilter(node.dataset.filter)));
  document.querySelectorAll('[data-command]').forEach((node) => node.addEventListener('click', (e) => {
    const b = e.currentTarget;
    b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
    setTimeout(() => b.classList.remove('flash'), 400);
    sendCommand(node.dataset.command).catch((error) => toast(error.message, 'err'));
  }));
  $('broadcastBtn').addEventListener('click', async () => {
    const value = await openPrompt('Broadcast', 'Send a message to all players.', 'Message');
    if (value) sendCommand(`say ${value}`).catch((error) => toast(error.message, 'err'));
  });
  $('saveSettingsBtn').addEventListener('click', () => saveSettings().catch((error) => toast(error.message, 'err')));
  $('saveAuthBtn').addEventListener('click', () => saveAuth().catch((error) => toast(error.message, 'err')));
  $('saveMotdBtn').addEventListener('click', () => saveMotd().catch((error) => toast(error.message, 'err')));
  $('savePropsBtn').addEventListener('click', () => saveProperties().catch((error) => toast(error.message, 'err')));
  $('createBackupBtn').addEventListener('click', () => createBackup().catch((error) => toast(error.message, 'err')));
  $('saveFileBtn').addEventListener('click', async () => {
    await api('/api/files/write', { method: 'POST', body: { key: state.selectedFileKey, content: $('fileEditor').value } });
    await loadFiles();
    toast('File saved', 'ok');
  });
  $('downloadBtn').addEventListener('click', async () => {
    const version = $('verSel').value;
    const request = async (force = false) => {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: state.selectedVersionType, version, force }),
      });
      const data = await response.json();
      if (response.status === 401) {
        showLogin(true, 'Authentication required');
        throw new Error('Authentication required');
      }
      if (data.needsConfirm) {
        const confirmed = window.confirm(data.error);
        if (confirmed) {
          await request(true);
        }
        return;
      }
      if (!response.ok || data.error) {
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      toast('Download started', 'ok');
    };
    await request(false);
  });
  $('installCrossplayBtn').addEventListener('click', async () => {
    const response = await fetch('/api/crossplay/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    if (response.status === 401) {
      showLogin(true, 'Authentication required');
      throw new Error('Authentication required');
    }
    if (!response.ok || data.error) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    await Promise.all([loadPlugins(), loadFiles()]);
    toast('Crossplay plugin install started', 'ok');
  });
  $('reloadModsBtn').addEventListener('click', () => loadMods().catch((error) => toast(error.message, 'err')));
  $('reloadPluginsBtn').addEventListener('click', () => loadPlugins().catch((error) => toast(error.message, 'err')));
  $('refreshPlayersBtn').addEventListener('click', () => api('/api/list', { method: 'POST' }).catch((error) => toast(error.message, 'err')));
  $('pickModBtn').addEventListener('click', () => $('modFile').click());
  $('pickPlgBtn').addEventListener('click', () => $('plgFile').click());
  $('modFile').addEventListener('change', () => {
    $('modFileName').textContent = $('modFile').files[0]?.name || 'No file selected';
    $('uploadModBtn').disabled = !$('modFile').files[0];
  });
  $('plgFile').addEventListener('change', () => {
    $('plgFileName').textContent = $('plgFile').files[0]?.name || 'No file selected';
    $('uploadPlgBtn').disabled = !$('plgFile').files[0];
  });
  $('uploadModBtn').addEventListener('click', () => uploadJar('mods').catch((error) => toast(error.message, 'err')));
  $('uploadPlgBtn').addEventListener('click', () => uploadJar('plugins').catch((error) => toast(error.message, 'err')));
  $('addWhitelistBtn').addEventListener('click', () => addAdmin('whitelist').catch((error) => toast(error.message, 'err')));
  $('addOpBtn').addEventListener('click', () => addAdmin('ops').catch((error) => toast(error.message, 'err')));
  $('addBanBtn').addEventListener('click', () => addAdmin('bans').catch((error) => toast(error.message, 'err')));
  $('psrch').addEventListener('input', () => renderProperties(state.props, $('psrch').value.trim()));
  // ripple on all buttons
  document.querySelectorAll('.hbtn, .abtn').forEach(addRipple);
  // console scroll → jump pill
  $('console').addEventListener('scroll', updateJumpLatest);
  if ($('jumpLatest')) {
    $('jumpLatest').addEventListener('click', () => {
      $('console').scrollTop = $('console').scrollHeight;
      $('jumpLatest').classList.remove('visible');
      $('autoScroll').checked = true;
    });
  }
  document.body.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-player-action],[data-admin-remove],[data-restore-backup],[data-delete-backup],[data-file-key],[data-delete-mod],[data-delete-plugin],[data-preset],[data-version-type]');
    if (!target) return;
    try {
      if (target.dataset.playerAction) {
        const action = target.dataset.playerAction;
        const name = target.dataset.playerName;
        const extra = action === 'kick' || action === 'ban'
          ? await openPrompt(action === 'kick' ? 'Kick Player' : 'Ban Player', `Enter a reason for ${name}.`, 'Reason', action === 'kick' ? 'Kicked by admin' : 'Banned by admin')
          : null;
        if (extra === null && (action === 'kick' || action === 'ban')) return;
        await api(`/api/player/${action}`, { method: 'POST', body: { name, extra } });
        toast(`${action} sent`, 'ok');
      } else if (target.dataset.adminRemove) {
        await removeAdmin(target.dataset.adminRemove, target.dataset.adminName);
      } else if (target.dataset.restoreBackup) {
        await restoreBackup(target.dataset.restoreBackup);
      } else if (target.dataset.deleteBackup) {
        const dRow = target.closest('.list-row');
        if (dRow) { dRow.classList.add('removing'); await new Promise(r => setTimeout(r, 240)); }
        await deleteBackup(target.dataset.deleteBackup);
      } else if (target.dataset.fileKey) {
        await openManagedFile(target.dataset.fileKey);
      } else if (target.dataset.deleteMod) {
        await api(`/api/mods/${encodeURIComponent(target.dataset.deleteMod)}`, { method: 'DELETE' });
        await Promise.all([loadMods(), loadFiles()]);
      } else if (target.dataset.deletePlugin) {
        await api(`/api/plugins/${encodeURIComponent(target.dataset.deletePlugin)}`, { method: 'DELETE' });
        await Promise.all([loadPlugins(), loadFiles()]);
      } else if (target.dataset.preset) {
        await api(`/api/presets/${target.dataset.preset}`, { method: 'POST' });
        await Promise.all([loadStatus(), loadProperties(), api('/api/presets').then((data) => { state.presets = data.presets || {}; renderPresets(); })]);
        toast('Preset applied', 'ok');
        const pr = $('presetList').querySelector('.abtn.primary');
        if (pr) { const row = pr.closest('.list-row'); if (row) { row.classList.add('new-row'); setTimeout(() => row.classList.remove('new-row'), 900); } }
      } else if (target.dataset.versionType) {
        state.selectedVersionType = target.dataset.versionType;
        document.querySelectorAll('[data-version-type]').forEach((node) => node.classList.toggle('active', node.dataset.versionType === state.selectedVersionType));
        await loadVersionList();
      }
    } catch (error) {
      toast(error.message, 'err');
    }
  });
}

const PMETA = {
  'max-players': { l: 'Max Players', g: 'General', t: 'number' },
  gamemode: { l: 'Default Gamemode', g: 'General', t: 'sel', o: ['survival', 'creative', 'adventure', 'spectator'] },
  difficulty: { l: 'Difficulty', g: 'General', t: 'sel', o: ['peaceful', 'easy', 'normal', 'hard'] },
  'level-name': { l: 'World Name', g: 'General' },
  'level-type': { l: 'World Type', g: 'General', t: 'sel', o: ['minecraft:default', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified'] },
  'level-seed': { l: 'Seed', g: 'General' },
  'server-port': { l: 'Port', g: 'Network', t: 'number' },
  'online-mode': { l: 'Online Mode', g: 'Network', t: 'bool' },
  'white-list': { l: 'Whitelist', g: 'Network', t: 'bool' },
  'view-distance': { l: 'View Distance', g: 'Performance', t: 'number' },
  'simulation-distance': { l: 'Simulation Distance', g: 'Performance', t: 'number' },
  'max-tick-time': { l: 'Max Tick Time (ms)', g: 'Performance', t: 'number' },
  'network-compression-threshold': { l: 'Compression Threshold', g: 'Performance', t: 'number' },
  pvp: { l: 'PvP', g: 'World', t: 'bool' },
  'spawn-monsters': { l: 'Spawn Monsters', g: 'World', t: 'bool' },
  'spawn-animals': { l: 'Spawn Animals', g: 'World', t: 'bool' },
  'spawn-npcs': { l: 'Spawn Villagers', g: 'World', t: 'bool' },
  'allow-nether': { l: 'Allow Nether', g: 'World', t: 'bool' },
  'allow-flight': { l: 'Allow Flight', g: 'World', t: 'bool' },
  'generate-structures': { l: 'Generate Structures', g: 'World', t: 'bool' },
  'spawn-protection': { l: 'Spawn Protection', g: 'World', t: 'number' },
  'enable-command-block': { l: 'Command Blocks', g: 'World', t: 'bool' },
  'force-gamemode': { l: 'Force Gamemode', g: 'Rules', t: 'bool' },
  hardcore: { l: 'Hardcore', g: 'Rules', t: 'bool' },
  'enable-rcon': { l: 'RCON', g: 'Advanced', t: 'bool' },
  'rcon.port': { l: 'RCON Port', g: 'Advanced', t: 'number' },
  'enable-query': { l: 'Query', g: 'Advanced', t: 'bool' },
};


// ── UI Animation & Helper Functions ──────────────────────────────

function flashIfChanged(id, newVal) {
  const el = $(id);
  if (!el) return;
  if (el.textContent !== newVal) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 500);
  }
  el.textContent = newVal;
}

function showBtnSuccess(btn) {
  if (!btn) return;
  const orig = btn.innerHTML;
  btn.innerHTML = '✓ Saved';
  btn.classList.add('success');
  setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('success'); }, 1800);
}

function addRipple(btn) {
  btn.addEventListener('click', function(e) {
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;
    const r = document.createElement('span');
    r.className = 'ripple';
    r.style.cssText = 'width:' + size + 'px;height:' + size + 'px;left:' + x + 'px;top:' + y + 'px';
    btn.appendChild(r);
    setTimeout(() => r.remove(), 550);
  });
}

function updateJumpLatest() {
  const cons = $('console');
  const btn = $('jumpLatest');
  if (!cons || !btn) return;
  const atBottom = cons.scrollHeight - cons.scrollTop - cons.clientHeight < 80;
  btn.classList.toggle('visible', !atBottom && state.logs.length > 0);
}

function setWsStatus(connected) {
  const banner = $('wsBanner');
  if (banner) banner.classList.toggle('visible', !connected);
}

function updateMiniConsole() {
  const feed = $('miniConsole');
  if (!feed) return;
  const recent = state.logs.filter(e => e.type !== 'tick').slice(-8);
  if (!recent.length) { feed.innerHTML = '<div class="empty-mini">No output yet</div>'; return; }
  feed.innerHTML = recent.map(e =>
    '<div class="mcl ' + (e.type || 'log') + '"><span class="lt">' + esc(e.time || '') + '</span><span class="lm">' + esc(e.text || '') + '</span></div>'
  ).join('');
}

function renderMiniPlayers() {
  const el = $('miniPlayers');
  const sub = $('miniPlayerSub');
  if (!el) return;
  if (sub) sub.textContent = state.players.length + ' online';
  if (!state.players.length) { el.innerHTML = '<div class="empty-mini">No players online</div>'; return; }
  el.innerHTML = state.players.slice(0, 5).map(function(player) {
    return '<div class="mini-player-row"><div class="mini-avatar"><img src="https://crafatar.com/avatars/' + esc(player.name) + '?size=24&overlay" onerror="this.parentNode.innerHTML=\'&#x1F9D1;\'" /></div><span class="mini-player-name">' + esc(player.name) + '</span></div>';
  }).join('');
}

function renderMiniBackups() {
  const el = $('miniBackups');
  if (!el) return;
  if (!state.backups.length) { el.innerHTML = '<div class="empty-mini">No backups yet</div>'; return; }
  el.innerHTML = state.backups.slice(0, 3).map(function(b) {
    return '<div class="mini-backup-row"><span class="mini-backup-icon">💾</span><span class="mini-backup-name">' + esc(b.label || b.id) + '</span><span class="mini-backup-time">' + esc(b.createdAt || '') + '</span></div>';
  }).join('');
}

function initTabIndicator() {
  const active = document.querySelector('.tnav.active');
  const ind = $('tabIndicator');
  if (active && ind) {
    ind.style.left = active.offsetLeft + 'px';
    ind.style.top = active.offsetTop + 'px';
    ind.style.width = active.offsetWidth + 'px';
    ind.style.height = active.offsetHeight + 'px';
  }
}

function syncInterfaceCopy() {
  const dashLinks = document.querySelectorAll('#tab-dash .panel-link');
  if (dashLinks[0]) dashLinks[0].textContent = 'Open Stream ->';
  if (dashLinks[1]) dashLinks[1].textContent = 'View Crew ->';
  if (dashLinks[2]) dashLinks[2].textContent = 'Open Vault ->';
  const jump = $('jumpLatest');
  if (jump) jump.textContent = 'Jump to latest';
}

document.addEventListener('DOMContentLoaded', async () => {
  disableAuthUI();
  bindEvents();
  syncInterfaceCopy();
  initTabIndicator();
  updateMiniConsole();
  renderMiniPlayers();
  renderMiniBackups();
  window.addEventListener('resize', initTabIndicator);
  const authenticated = await checkAuth();
  if (authenticated) {
    bootstrap().catch((error) => toast(error.message, 'err'));
  }
});
