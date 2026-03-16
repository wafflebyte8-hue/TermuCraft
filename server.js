#!/usr/bin/env node
/**
 * TermuCraft - full Minecraft server panel backend for Termux.
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn, spawnSync, execFileSync } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let pidusage;
try {
  pidusage = require('pidusage');
} catch {
  pidusage = null;
}

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const UI_DIR = path.join(HOME, 'TermuCraft');
const STATIC_DIR = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : __dirname;
const CONFIG_FILE = path.join(UI_DIR, 'config.json');
const ACCESS_FILE = path.join(UI_DIR, 'identity.json');
const INTEGRITY_FILE = path.join(UI_DIR, 'integrity.json');
const BACKUP_DIR = path.join(UI_DIR, 'backups');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_HISTORY_LIMIT = 3000;
const AUTH_FEATURE_ENABLED = false;

const CONFIG_DEFAULTS = {
  serverJar: process.env.MC_JAR || 'server.jar',
  serverDir: process.env.MC_DIR || path.join(HOME, 'minecraft'),
  memory: process.env.MC_RAM || '1G',
  javaPath: process.env.JAVA || 'java',
  uiPort: Number.parseInt(process.env.UI_PORT || '8080', 10) || 8080,
  httpsEnabled: false,
  httpsPort: Number.parseInt(process.env.HTTPS_PORT || '8443', 10) || 8443,
  httpsCertPath: path.join(UI_DIR, 'certs', 'cert.pem'),
  httpsKeyPath: path.join(UI_DIR, 'certs', 'key.pem'),
  serverType: '',
  serverVersion: '',
  preset: 'balanced',
  autoRestart: true,
  autoRestartDelaySec: 10,
  backupRetention: 5,
  scheduleBackupMinutes: 0,
  scheduleBroadcastMinutes: 0,
  scheduleBroadcastMessage: 'Scheduled notice from TermuCraft.',
  scheduleRestartTime: '',
  motd: 'A TermuCraft Minecraft Server',
  lastDownloadedChecksum: '',
  lastDownloadedChecksumType: '',
};

const PRESETS = {
  battery: {
    label: 'Battery Saver',
    memory: '768M',
    description: 'Lower draw distance and tighter limits for weaker phones.',
    properties: {
      'view-distance': '4',
      'simulation-distance': '4',
      'max-players': '4',
      'network-compression-threshold': '128',
      'spawn-protection': '8',
    },
  },
  balanced: {
    label: 'Balanced',
    memory: '1G',
    description: 'Reasonable defaults for most 4 GB phones.',
    properties: {
      'view-distance': '6',
      'simulation-distance': '6',
      'max-players': '8',
      'network-compression-threshold': '256',
      'spawn-protection': '8',
    },
  },
  capacity: {
    label: 'Max Players',
    memory: '1536M',
    description: 'Higher RAM and view distance when the device can handle it.',
    properties: {
      'view-distance': '8',
      'simulation-distance': '8',
      'max-players': '14',
      'network-compression-threshold': '384',
      'spawn-protection': '16',
    },
  },
};

const MANAGED_TEXT_FILES = [
  { key: 'server.properties', label: 'server.properties', editable: true, resolve: () => path.join(CONFIG.serverDir, 'server.properties') },
  { key: 'eula.txt', label: 'eula.txt', editable: true, resolve: () => path.join(CONFIG.serverDir, 'eula.txt') },
  { key: 'ops.json', label: 'ops.json', editable: true, resolve: () => path.join(CONFIG.serverDir, 'ops.json') },
  { key: 'whitelist.json', label: 'whitelist.json', editable: true, resolve: () => path.join(CONFIG.serverDir, 'whitelist.json') },
  { key: 'banned-players.json', label: 'banned-players.json', editable: true, resolve: () => path.join(CONFIG.serverDir, 'banned-players.json') },
  { key: 'banned-ips.json', label: 'banned-ips.json', editable: true, resolve: () => path.join(CONFIG.serverDir, 'banned-ips.json') },
  { key: 'latest.log', label: 'logs/latest.log', editable: false, resolve: () => path.join(CONFIG.serverDir, 'logs', 'latest.log') },
  { key: 'crash.log', label: 'crash.log', editable: false, resolve: () => path.join(CONFIG.serverDir, 'crash.log') },
];

const app = express();

let CONFIG = loadConfig();
let ACCESS = loadAccess();
let INTEGRITY = loadIntegrity();
let sessions = new Map();
let mcProcess = null;
let logHistory = [];
let onlinePlayers = {};
let startTime = null;
let downloadState = null;
let systemStats = { cpu: 0, ram: 0, diskUsed: 0, diskTotal: 0 };
let restartTimer = null;
let pendingRestart = null;
let expectedExit = false;
let restartRequested = false;
let crashState = {
  lastCrashAt: null,
  lastCrashReason: '',
  lastCrashCode: null,
  lastCrashSignal: null,
};
let schedulerState = {
  lastBackupAt: 0,
  lastBroadcastAt: 0,
  lastRestartSlot: '',
};
let server;
let wss;

const VERBOSE = process.env.MC_VERBOSE === '1';
const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  amber: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
};

function verbosePrint(text, type) {
  if (!VERBOSE) {
    return;
  }
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const color = type === 'warn'
    ? ANSI.amber
    : type === 'error'
      ? ANSI.red
      : type === 'system'
        ? ANSI.green
        : type === 'cmd'
          ? ANSI.blue
          : ANSI.reset;
  process.stdout.write(`${ANSI.dim}${time}${ANSI.reset} ${color}${text}${ANSI.reset}\n`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile(filePath, defaults) {
  try {
    if (!fs.existsSync(filePath)) {
      return defaults;
    }
    return { ...defaults, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch {
    return defaults;
  }
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

const ACCESS_PBKDF2_DIGEST = 'sha512';
const ACCESS_PBKDF2_ROUNDS = 210000;
const ACCESS_PBKDF2_BYTES = 48;

function normalizeHandle(value) {
  return String(value || '').trim().toLowerCase();
}

function createSecretEnvelope(password) {
  const salt = crypto.randomBytes(24);
  const verifier = crypto.pbkdf2Sync(
    String(password || ''),
    salt,
    ACCESS_PBKDF2_ROUNDS,
    ACCESS_PBKDF2_BYTES,
    ACCESS_PBKDF2_DIGEST,
  );
  return {
    scheme: 'pbkdf2-sha512',
    rounds: ACCESS_PBKDF2_ROUNDS,
    bytes: ACCESS_PBKDF2_BYTES,
    digest: ACCESS_PBKDF2_DIGEST,
    salt: salt.toString('base64'),
    verifier: verifier.toString('base64'),
  };
}

function buildAccessRecord(handle = 'admin', password = 'changeme', bootstrap = true) {
  const normalizedHandle = normalizeHandle(handle) || 'admin';
  const now = new Date().toISOString();
  return {
    version: 1,
    authRequired: AUTH_FEATURE_ENABLED,
    profile: {
      handle: normalizedHandle,
      createdAt: now,
      updatedAt: now,
    },
    secret: createSecretEnvelope(password),
    flags: {
      bootstrap: !!bootstrap,
    },
    updatedAt: now,
  };
}

function buildOpenAccessRecord() {
  const now = new Date().toISOString();
  return {
    version: 1,
    authRequired: false,
    profile: {
      handle: 'local',
      createdAt: now,
      updatedAt: now,
    },
    secret: null,
    flags: {
      bootstrap: false,
    },
    updatedAt: now,
  };
}

function loadConfig() {
  return readJsonFile(CONFIG_FILE, CONFIG_DEFAULTS);
}

function saveConfig() {
  writeJsonFile(CONFIG_FILE, CONFIG);
}

function loadAccess() {
  if (!AUTH_FEATURE_ENABLED) {
    return buildOpenAccessRecord();
  }
  const current = readJsonFile(ACCESS_FILE, null);
  if (
    current
    && current.secret
    && current.secret.salt
    && current.secret.verifier
  ) {
    const handle = normalizeHandle(current.profile?.handle || current.username || 'admin') || 'admin';
    return {
      version: Number(current.version || 1) || 1,
      authRequired: AUTH_FEATURE_ENABLED ? current.authRequired !== false : false,
      profile: {
        handle,
        createdAt: current.profile?.createdAt || current.updatedAt || new Date().toISOString(),
        updatedAt: current.profile?.updatedAt || current.updatedAt || new Date().toISOString(),
      },
      secret: {
        scheme: current.secret.scheme || 'pbkdf2-sha512',
        rounds: Number(current.secret.rounds || ACCESS_PBKDF2_ROUNDS) || ACCESS_PBKDF2_ROUNDS,
        bytes: Number(current.secret.bytes || ACCESS_PBKDF2_BYTES) || ACCESS_PBKDF2_BYTES,
        digest: current.secret.digest || ACCESS_PBKDF2_DIGEST,
        salt: current.secret.salt,
        verifier: current.secret.verifier,
      },
      flags: {
        bootstrap: AUTH_FEATURE_ENABLED ? !!current.flags?.bootstrap : false,
      },
      updatedAt: current.updatedAt || new Date().toISOString(),
    };
  }
  const bootstrap = buildAccessRecord();
  writeJsonFile(ACCESS_FILE, bootstrap);
  return bootstrap;
}

function saveAccess() {
  if (!AUTH_FEATURE_ENABLED) {
    return;
  }
  writeJsonFile(ACCESS_FILE, ACCESS);
}

function loadIntegrity() {
  return readJsonFile(INTEGRITY_FILE, { records: {} });
}

function saveIntegrity() {
  writeJsonFile(INTEGRITY_FILE, INTEGRITY);
}

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((accumulator, part) => {
    const [key, ...rest] = part.trim().split('=');
    if (key) {
      accumulator[key] = decodeURIComponent(rest.join('=') || '');
    }
    return accumulator;
  }, {});
}

function createSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, {
    username,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

function pruneSessions() {
  const now = Date.now();
  sessions.forEach((value, key) => {
    if (!value || value.expiresAt <= now) {
      sessions.delete(key);
    }
  });
}

function getSessionFromRequest(req) {
  pruneSessions();
  const token = parseCookies(req.headers.cookie || '').termucraft_session;
  if (!token) {
    return null;
  }
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `termucraft_session=${token}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; Path=/; HttpOnly; SameSite=Strict`,
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'termucraft_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict');
}

function requireAuth(req, res, next) {
  if (!ACCESS.authRequired) {
    next();
    return;
  }
  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  req.session = session;
  next();
}

function verifyAccess(handle, password) {
  if (!AUTH_FEATURE_ENABLED) {
    return true;
  }
  ACCESS = loadAccess();
  if (normalizeHandle(handle) !== ACCESS.profile.handle) {
    return false;
  }
  const stored = Buffer.from(ACCESS.secret.verifier, 'base64');
  const derived = crypto.pbkdf2Sync(
    String(password || ''),
    Buffer.from(ACCESS.secret.salt, 'base64'),
    ACCESS.secret.rounds,
    ACCESS.secret.bytes,
    ACCESS.secret.digest,
  );
  if (stored.length !== derived.length) {
    return false;
  }
  return crypto.timingSafeEqual(stored, derived);
}

function setAccess(handle, password, bootstrap = false) {
  if (!AUTH_FEATURE_ENABLED) {
    ACCESS = buildOpenAccessRecord();
    return;
  }
  const existingCreatedAt = ACCESS?.profile?.createdAt || new Date().toISOString();
  ACCESS = buildAccessRecord(handle, password, bootstrap);
  ACCESS.profile.createdAt = existingCreatedAt;
  ACCESS.profile.updatedAt = new Date().toISOString();
  ACCESS.updatedAt = ACCESS.profile.updatedAt;
  saveAccess();
}

function commandExists(command) {
  try {
    execFileSync('which', [command], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function broadcast(message) {
  if (!wss || !wss.clients) {
    return;
  }
  const payload = JSON.stringify(message);
  wss.clients.forEach((socket) => {
    if (socket.readyState === 1) {
      socket.send(payload);
    }
  });
}

function shaForFile(filePath, algorithm = 'sha256') {
  const hash = crypto.createHash(algorithm);
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function updateIntegrityRecord(filePath, metadata = {}) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const record = {
    sha256: shaForFile(filePath, 'sha256'),
    size: fs.statSync(filePath).size,
    updatedAt: new Date().toISOString(),
    path: filePath,
    ...metadata,
  };
  INTEGRITY.records[filePath] = record;
  saveIntegrity();
  return record;
}

function getIntegrityRecord(filePath) {
  return INTEGRITY.records[filePath] || null;
}

function readProperties() {
  const filePath = path.join(CONFIG.serverDir, 'server.properties');
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const props = {};
  fs.readFileSync(filePath, 'utf8').split('\n').forEach((line) => {
    if (!line || line.startsWith('#') || !line.includes('=')) {
      return;
    }
    const [key, ...rest] = line.split('=');
    props[key.trim()] = rest.join('=').trim();
  });
  return props;
}

function writeProperties(props) {
  const filePath = path.join(CONFIG.serverDir, 'server.properties');
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const written = new Set();
  const updated = existing.split('\n').map((line) => {
    if (!line || line.startsWith('#') || !line.includes('=')) {
      return line;
    }
    const key = line.split('=')[0].trim();
    if (Object.prototype.hasOwnProperty.call(props, key)) {
      written.add(key);
      return `${key}=${props[key]}`;
    }
    return line;
  });
  Object.entries(props).forEach(([key, value]) => {
    if (!written.has(key)) {
      updated.push(`${key}=${value}`);
    }
  });
  ensureDir(CONFIG.serverDir);
  fs.writeFileSync(filePath, updated.join('\n').replace(/\n{3,}/g, '\n\n'));
  updateIntegrityRecord(filePath, { label: 'server.properties' });
}

let prevCpu = null;
let rootAccess = null;
let clockTicks = null;
let prevRootProcess = null;

function hasRootAccess() {
  if (rootAccess != null) {
    return rootAccess;
  }
  try {
    const uid = execFileSync('su', ['-c', 'id -u'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    rootAccess = uid === '0';
  } catch {
    rootAccess = false;
  }
  return rootAccess;
}

function getClockTicksPerSecond() {
  if (clockTicks != null) {
    return clockTicks;
  }
  try {
    const value = Number(execFileSync('getconf', ['CLK_TCK'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    clockTicks = Number.isFinite(value) && value > 0 ? value : 100;
  } catch {
    clockTicks = 100;
  }
  return clockTicks;
}

function readRootFile(filePath) {
  return execFileSync('su', ['-c', `cat ${filePath}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function readRootProcessStats(pid) {
  try {
    const statText = readRootFile(`/proc/${pid}/stat`).trim();
    const statusText = readRootFile(`/proc/${pid}/status`);
    const uptimeText = readRootFile('/proc/uptime').trim();
    const statFields = statText.slice(statText.lastIndexOf(')') + 2).split(/\s+/);
    const totalTicks = Number(statFields[11] || 0) + Number(statFields[12] || 0);
    const uptimeSeconds = Number(uptimeText.split(/\s+/)[0] || 0);
    const rssMatch = statusText.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    const ram = rssMatch ? Number(rssMatch[1]) / 1024 : 0;
    let cpu = 0;
    if (prevRootProcess && prevRootProcess.pid === pid) {
      const deltaTicks = totalTicks - prevRootProcess.totalTicks;
      const deltaUptime = uptimeSeconds - prevRootProcess.uptimeSeconds;
      if (deltaTicks >= 0 && deltaUptime > 0) {
        cpu = (deltaTicks / getClockTicksPerSecond() / deltaUptime) * 100;
      }
    }
    prevRootProcess = { pid, totalTicks, uptimeSeconds };
    return {
      cpu: Math.max(0, Math.round(cpu * 10) / 10),
      ram: Math.max(0, Math.round(ram * 10) / 10),
    };
  } catch {
    prevRootProcess = null;
    return null;
  }
}

function readCpuTimes() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const parts = stat.trim().split(/\s+/);
    if (parts[0] === 'cpu' && parts.length >= 5) {
      const values = parts.slice(1).map((value) => Number.parseInt(value, 10)).filter(Number.isFinite);
      const idle = (values[3] || 0) + (values[4] || 0);
      const total = values.reduce((sum, value) => sum + value, 0);
      if (total > 0) {
        return { idle, total };
      }
    }
  } catch {
    // Ignore and fall back to os.cpus().
  }

  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  cpus.forEach((cpu) => {
    Object.values(cpu.times).forEach((value) => {
      total += value;
    });
    idle += cpu.times.idle;
  });
  return { idle, total };
}

function resolveStatsPath(targetPath) {
  let current = path.resolve(targetPath || __dirname);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return __dirname;
    }
    current = parent;
  }
  return current;
}

function updateDiskStats() {
  try {
    const statPath = resolveStatsPath(CONFIG.serverDir);
    const stats = fs.statfsSync(statPath);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const total = Number(stats.blocks || 0) * blockSize;
    const free = Number((stats.bavail ?? stats.bfree) || 0) * blockSize;
    systemStats = {
      ...systemStats,
      diskUsed: Math.max(total - free, 0),
      diskTotal: total,
    };
  } catch {
    systemStats = { ...systemStats, diskUsed: 0, diskTotal: 0 };
  }
}

function updateSystemStatsFallback() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const { idle, total } = readCpuTimes();
  let cpuUsage = 0;
  if (prevCpu) {
    const idleDelta = idle - prevCpu.idle;
    const totalDelta = total - prevCpu.total;
    cpuUsage = totalDelta > 0 ? 100 * (1 - (idleDelta / totalDelta)) : 0;
  }
  prevCpu = { idle, total };
  if (cpuUsage < 0) {
    cpuUsage = 0;
  }
  if (cpuUsage > 100) {
    cpuUsage = 100;
  }
  systemStats = {
    ...systemStats,
    cpu: Math.round(cpuUsage * 10) / 10,
    ram: Math.round((totalMem - freeMem) / 1024 / 1024),
  };
}

function updateSystemStats() {
  updateDiskStats();
  if (mcProcess && mcProcess.pid && hasRootAccess()) {
    const rootStats = readRootProcessStats(mcProcess.pid);
    if (rootStats) {
      systemStats = { ...systemStats, ...rootStats };
      broadcast({ type: 'stats', ...systemStats });
      return;
    }
  }

  if (mcProcess && mcProcess.pid && pidusage) {
    pidusage(mcProcess.pid, (error, stats) => {
      if (!error && stats) {
        systemStats = {
          ...systemStats,
          cpu: Number(stats.cpu.toFixed(1)),
          ram: Number((stats.memory / 1024 / 1024).toFixed(1)),
        };
      } else {
        updateSystemStatsFallback();
      }
      broadcast({ type: 'stats', ...systemStats });
    });
  } else if (mcProcess && mcProcess.pid) {
    updateSystemStatsFallback();
    broadcast({ type: 'stats', ...systemStats });
  } else {
    systemStats = { ...systemStats, cpu: 0, ram: 0 };
    prevRootProcess = null;
    broadcast({ type: 'stats', ...systemStats });
  }
}

function getUptime() {
  if (!startTime) {
    return null;
  }
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function getServerPort() {
  const props = readProperties();
  return props['server-port'] || '25565';
}

function hasHttpsConfig() {
  return !!(CONFIG.httpsEnabled
    && CONFIG.httpsKeyPath
    && CONFIG.httpsCertPath
    && fs.existsSync(CONFIG.httpsKeyPath)
    && fs.existsSync(CONFIG.httpsCertPath));
}

function getNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  Object.values(interfaces).forEach((items) => {
    (items || []).forEach((item) => {
      if (!item || item.internal || item.family !== 'IPv4') {
        return;
      }
      addresses.push(item.address);
    });
  });
  const lanIp = addresses.find((ip) => (
    ip.startsWith('192.168.')
    || ip.startsWith('10.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  )) || addresses[0] || '127.0.0.1';
  return {
    lanIp,
    addresses,
    mcPort: getServerPort(),
    panelPort: CONFIG.uiPort,
    panelSecurePort: hasHttpsConfig() ? CONFIG.httpsPort : null,
    panelProtocol: hasHttpsConfig() ? 'https' : 'http',
  };
}

function addLog(rawText, type = 'log') {
  const text = String(rawText || '').replace(/\r/g, '').trim();
  if (!text) {
    return;
  }

  verbosePrint(text, type);

  const joinMatch = text.match(/:\s+(\w+) joined the game/);
  const leaveMatch = text.match(/:\s+(\w+) left the game/);
  const listMatch = text.match(/There are \d+ of a max of \d+ players online:(.*)/);

  if (joinMatch) {
    onlinePlayers[joinMatch[1]] = { name: joinMatch[1], joined: Date.now() };
    broadcast({ type: 'players', players: Object.values(onlinePlayers) });
  }
  if (leaveMatch) {
    delete onlinePlayers[leaveMatch[1]];
    broadcast({ type: 'players', players: Object.values(onlinePlayers) });
  }
  if (listMatch) {
    const names = listMatch[1].split(',').map((value) => value.trim()).filter(Boolean);
    onlinePlayers = {};
    names.forEach((name) => {
      onlinePlayers[name] = { name, joined: Date.now() };
    });
    broadcast({ type: 'players', players: Object.values(onlinePlayers) });
  }

  const entry = {
    text,
    type,
    time: new Date().toLocaleTimeString('en-US', { hour12: false }),
  };
  logHistory.push(entry);
  if (logHistory.length > LOG_HISTORY_LIMIT) {
    logHistory.shift();
  }
  broadcast({ type: 'log', ...entry });
}

function appendCrashLog(reason, code, signal) {
  const crashLogPath = path.join(CONFIG.serverDir, 'crash.log');
  ensureDir(path.dirname(crashLogPath));
  const now = new Date().toISOString();
  const tail = logHistory.slice(-100)
    .map((entry) => `[${entry.time}] [${entry.type}] ${entry.text}`)
    .join('\n');
  const block = [
    '============================================================',
    `Timestamp: ${now}`,
    `Reason: ${reason}`,
    `Exit code: ${code == null ? 'n/a' : code}`,
    `Signal: ${signal || 'n/a'}`,
    '',
    'Recent log tail:',
    tail || '(no recent log lines)',
    '',
  ].join('\n');
  fs.appendFileSync(crashLogPath, `${block}\n`);
  updateIntegrityRecord(crashLogPath, { label: 'crash.log' });
  crashState = {
    lastCrashAt: now,
    lastCrashReason: reason,
    lastCrashCode: code == null ? null : code,
    lastCrashSignal: signal || null,
  };
}

function buildStatusPayload() {
  return {
    running: !!mcProcess,
    config: CONFIG,
    uptime: getUptime(),
    players: Object.values(onlinePlayers),
    jarExists: fs.existsSync(path.join(CONFIG.serverDir, CONFIG.serverJar)),
    download: downloadState,
    network: getNetworkInfo(),
    pendingRestart,
    lastCrash: crashState,
    backupCount: listBackups().length,
  };
}

function getManagedFileSpec(key) {
  return MANAGED_TEXT_FILES.find((spec) => spec.key === key) || null;
}

function toManagedFileInfo(spec) {
  const filePath = spec.resolve();
  const exists = fs.existsSync(filePath);
  const stat = exists ? fs.statSync(filePath) : null;
  const integrity = exists ? getIntegrityRecord(filePath) : null;
  return {
    key: spec.key,
    label: spec.label,
    editable: spec.editable,
    exists,
    size: stat ? stat.size : 0,
    sha256: integrity ? integrity.sha256 : null,
    updatedAt: integrity ? integrity.updatedAt : (stat ? stat.mtime.toISOString() : null),
  };
}

function getWorldDir() {
  const props = readProperties();
  const worldName = props['level-name'] || 'world';
  return path.join(CONFIG.serverDir, worldName);
}

function listSimpleDir(dirPath, allowExtensions = null) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs.readdirSync(dirPath)
    .filter((name) => {
      if (!allowExtensions) {
        return true;
      }
      return allowExtensions.some((ext) => name.endsWith(ext));
    })
    .map((name) => {
      const fullPath = path.join(dirPath, name);
      const stat = fs.statSync(fullPath);
      const integrity = getIntegrityRecord(fullPath);
      return {
        name,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        sha256: integrity ? integrity.sha256 : null,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getManagedFilesOverview() {
  return {
    files: MANAGED_TEXT_FILES.map(toManagedFileInfo),
    directories: {
      plugins: listSimpleDir(path.join(CONFIG.serverDir, 'plugins'), ['.jar']),
      mods: listSimpleDir(path.join(CONFIG.serverDir, 'mods'), ['.jar']),
      datapacks: listSimpleDir(path.join(getWorldDir(), 'datapacks')),
      logs: listSimpleDir(path.join(CONFIG.serverDir, 'logs'), ['.log', '.gz']),
    },
  };
}

function directorySize(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return 0;
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    return stat.size;
  }
  return fs.readdirSync(dirPath).reduce((sum, name) => sum + directorySize(path.join(dirPath, name)), 0);
}

function createBackup(label = 'manual backup') {
  if (!fs.existsSync(CONFIG.serverDir)) {
    throw new Error('Server directory does not exist yet');
  }
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(BACKUP_DIR, id);
  const targetDir = path.join(backupRoot, 'server');
  ensureDir(backupRoot);

  if (mcProcess && mcProcess.stdin.writable) {
    try {
      mcProcess.stdin.write('save-all flush\n');
      addLog('> save-all flush', 'cmd');
    } catch {
      // Ignore best-effort save flush failures.
    }
  }

  fs.cpSync(CONFIG.serverDir, targetDir, { recursive: true, force: true });
  const meta = {
    id,
    label,
    createdAt: new Date().toISOString(),
    serverDir: CONFIG.serverDir,
    serverType: CONFIG.serverType || '',
    serverVersion: CONFIG.serverVersion || '',
    size: directorySize(targetDir),
  };
  fs.writeFileSync(path.join(backupRoot, 'meta.json'), JSON.stringify(meta, null, 2));
  pruneBackups();
  return meta;
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) {
    return [];
  }
  return fs.readdirSync(BACKUP_DIR)
    .map((id) => {
      const metaPath = path.join(BACKUP_DIR, id, 'meta.json');
      if (!fs.existsSync(metaPath)) {
        return null;
      }
      try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function pruneBackups() {
  const retention = Math.max(1, Number.parseInt(CONFIG.backupRetention, 10) || 5);
  const backups = listBackups();
  backups.slice(retention).forEach((backup) => {
    fs.rmSync(path.join(BACKUP_DIR, backup.id), { recursive: true, force: true });
  });
}

function restoreBackup(id) {
  const sourceDir = path.join(BACKUP_DIR, id, 'server');
  if (!fs.existsSync(sourceDir)) {
    throw new Error('Backup not found');
  }
  if (mcProcess) {
    throw new Error('Stop the server before restoring a backup');
  }
  const preRestore = fs.existsSync(CONFIG.serverDir) ? createBackup(`pre-restore ${id}`) : null;
  fs.rmSync(CONFIG.serverDir, { recursive: true, force: true });
  ensureDir(CONFIG.serverDir);
  fs.cpSync(sourceDir, CONFIG.serverDir, { recursive: true, force: true });
  MANAGED_TEXT_FILES.forEach((spec) => {
    const filePath = spec.resolve();
    if (fs.existsSync(filePath)) {
      updateIntegrityRecord(filePath, { label: spec.label });
    }
  });
  return { restoredId: id, preRestoreBackupId: preRestore ? preRestore.id : null };
}

function deleteBackup(id) {
  const backupPath = path.join(BACKUP_DIR, id);
  if (!fs.existsSync(backupPath)) {
    throw new Error('Backup not found');
  }
  fs.rmSync(backupPath, { recursive: true, force: true });
}

function readJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonArray(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  updateIntegrityRecord(filePath, { label: path.basename(filePath) });
}

function getAdminFilePath(type) {
  const map = {
    whitelist: path.join(CONFIG.serverDir, 'whitelist.json'),
    ops: path.join(CONFIG.serverDir, 'ops.json'),
    bans: path.join(CONFIG.serverDir, 'banned-players.json'),
  };
  return map[type] || null;
}

function readAdminList(type) {
  const filePath = getAdminFilePath(type);
  if (!filePath) {
    throw new Error('Unknown admin list');
  }
  return readJsonArray(filePath).sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

async function httpsGetRaw(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) {
      reject(new Error('Too many redirects'));
      return;
    }
    const mod = url.startsWith('https:') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'TermuCraft/0.1 (termux-panel)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsGetRaw(res.headers.location, depth + 1).then(resolve).catch(reject);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve(body);
      });
    }).on('error', reject);
  });
}

async function httpsGet(url) {
  const body = await httpsGetRaw(url);
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function parseXmlVersions(xmlText) {
  return [...String(xmlText).matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]);
}

async function resolveMinecraftProfile(name) {
  const raw = await httpsGet(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
  if (!raw || !raw.id || !raw.name) {
    throw new Error('Could not resolve that Minecraft username');
  }
  return {
    uuid: raw.id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
    name: raw.name,
  };
}

async function addAdminEntry(type, payload) {
  const filePath = getAdminFilePath(type);
  const username = String(payload.name || '').trim();
  if (!filePath || !username) {
    throw new Error('Missing username');
  }

  const list = readJsonArray(filePath);
  if (list.some((entry) => String(entry.name || '').toLowerCase() === username.toLowerCase())) {
    throw new Error('Player is already in that list');
  }

  const profile = await resolveMinecraftProfile(username);
  let entry;

  if (type === 'ops') {
    entry = {
      uuid: profile.uuid,
      name: profile.name,
      level: Number.parseInt(payload.level, 10) || 4,
      bypassesPlayerLimit: !!payload.bypassesPlayerLimit,
    };
    if (mcProcess) {
      mcProcess.stdin.write(`op ${profile.name}\n`);
      addLog(`> op ${profile.name}`, 'cmd');
    }
  } else if (type === 'whitelist') {
    entry = {
      uuid: profile.uuid,
      name: profile.name,
    };
    if (mcProcess) {
      mcProcess.stdin.write(`whitelist add ${profile.name}\n`);
      addLog(`> whitelist add ${profile.name}`, 'cmd');
    }
  } else if (type === 'bans') {
    entry = {
      uuid: profile.uuid,
      name: profile.name,
      created: new Date().toISOString(),
      source: ACCESS.profile.handle || 'termucraft',
      expires: 'forever',
      reason: String(payload.reason || 'Banned by admin'),
    };
    if (mcProcess) {
      mcProcess.stdin.write(`ban ${profile.name} ${entry.reason}\n`);
      addLog(`> ban ${profile.name} ${entry.reason}`, 'cmd');
    }
  } else {
    throw new Error('Unknown admin list');
  }

  list.push(entry);
  writeJsonArray(filePath, list);
  return entry;
}

function removeAdminEntry(type, name) {
  const filePath = getAdminFilePath(type);
  const username = String(name || '').trim();
  if (!filePath || !username) {
    throw new Error('Missing username');
  }

  const list = readJsonArray(filePath);
  const filtered = list.filter((entry) => String(entry.name || '').toLowerCase() !== username.toLowerCase());
  if (filtered.length === list.length) {
    throw new Error('Player not found');
  }

  if (mcProcess) {
    if (type === 'ops') {
      mcProcess.stdin.write(`deop ${username}\n`);
      addLog(`> deop ${username}`, 'cmd');
    } else if (type === 'whitelist') {
      mcProcess.stdin.write(`whitelist remove ${username}\n`);
      addLog(`> whitelist remove ${username}`, 'cmd');
    } else if (type === 'bans') {
      mcProcess.stdin.write(`pardon ${username}\n`);
      addLog(`> pardon ${username}`, 'cmd');
    }
  }

  writeJsonArray(filePath, filtered);
}

function validateScheduleTime(value) {
  return value === '' || /^\d{2}:\d{2}$/.test(value);
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error('Unknown preset');
  }
  CONFIG.preset = name;
  CONFIG.memory = preset.memory;
  saveConfig();
  writeProperties(preset.properties);
  broadcast({ type: 'config', config: CONFIG });
  return {
    preset: name,
    config: CONFIG,
    properties: readProperties(),
  };
}

function getJavaVersion() {
  const result = spawnSync(CONFIG.javaPath || 'java', ['-version'], { encoding: 'utf8' });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split('\n')[0].trim();
  return output || 'Unavailable';
}

function collectValidation() {
  const totalRamMB = Math.round(os.totalmem() / 1024 / 1024);
  const memoryMatch = String(CONFIG.memory || '').trim().toUpperCase().match(/^(\d+(?:\.\d+)?)([MG])$/);
  const configuredRamMB = memoryMatch
    ? Number(memoryMatch[1]) * (memoryMatch[2] === 'G' ? 1024 : 1)
    : 0;
  const checks = [
    {
      label: 'Termux environment',
      ok: fs.existsSync('/data/data/com.termux'),
      detail: fs.existsSync('/data/data/com.termux') ? 'Detected' : 'Not running inside Termux',
    },
    {
      label: 'Java runtime',
      ok: getJavaVersion() !== 'Unavailable',
      detail: getJavaVersion(),
    },
    {
      label: 'Node.js runtime',
      ok: true,
      detail: process.version,
    },
    {
      label: 'Server directory',
      ok: fs.existsSync(CONFIG.serverDir),
      detail: CONFIG.serverDir,
    },
    {
      label: 'Server JAR',
      ok: fs.existsSync(path.join(CONFIG.serverDir, CONFIG.serverJar)),
      detail: path.join(CONFIG.serverDir, CONFIG.serverJar),
    },
      {
        label: 'Panel auth',
        ok: true,
        detail: ACCESS.authRequired ? (ACCESS.flags?.bootstrap ? 'Bootstrap credentials still active' : `Configured for ${ACCESS.profile.handle}`) : 'Disabled in this build',
      },
    {
      label: 'Wake lock command',
      ok: commandExists('termux-wake-lock'),
      detail: commandExists('termux-wake-lock') ? 'Available' : 'Install Termux:API for wake lock support',
    },
    {
      label: 'tmux',
      ok: commandExists('tmux'),
      detail: commandExists('tmux') ? 'Available' : 'Install tmux for background sessions',
    },
    {
      label: 'Checksums manifest',
      ok: fs.existsSync(path.join(UI_DIR, '.checksums')),
      detail: fs.existsSync(path.join(UI_DIR, '.checksums')) ? 'Installer checksum file present' : 'No checksum manifest found',
    },
  ];

  return {
    javaVersion: getJavaVersion(),
    nodeVersion: process.version,
    totalRamMB,
    configuredRamMB,
    suggestedRamMB: Math.max(512, Math.floor(totalRamMB / 2 / 512) * 512),
    network: getNetworkInfo(),
    backupCount: listBackups().length,
    authBootstrap: !!ACCESS.flags?.bootstrap,
    checks,
    lastCrash: crashState,
  };
}

function attachMcProcess(processHandle) {
  mcProcess = processHandle;
  mcProcess.stdout.on('data', (chunk) => {
    String(chunk).split('\n').forEach((line) => addLog(line, 'log'));
  });
  mcProcess.stderr.on('data', (chunk) => {
    String(chunk).split('\n').forEach((line) => addLog(line, 'warn'));
  });
  mcProcess.on('error', (error) => {
    addLog(`Process error: ${error.message}`, 'error');
  });
  mcProcess.on('exit', (code, signal) => {
    const manualRestart = restartRequested;
    const expected = expectedExit;
    const crashed = !expected && !manualRestart;
    if (crashed) {
      const reason = signal ? `Unexpected signal ${signal}` : `Unexpected exit ${code ?? 'unknown'}`;
      appendCrashLog(reason, code, signal);
      addLog(`--- Crash detected: ${reason} ---`, 'error');
    } else {
      addLog(`--- Server stopped (exit ${code ?? signal ?? 'unknown'}) ---`, 'system');
    }
    if (pidusage) {
      try {
        pidusage.clear();
      } catch {
        // Ignore cleanup errors.
      }
    }
    mcProcess = null;
    onlinePlayers = {};
    startTime = null;
    expectedExit = false;
    restartRequested = false;
    updateSystemStats();
    broadcast({ type: 'status', ...buildStatusPayload() });

    if (manualRestart) {
      scheduleRestart(1, 'manual restart');
      return;
    }
    if (crashed && CONFIG.autoRestart) {
      scheduleRestart(Math.max(1, Number.parseInt(CONFIG.autoRestartDelaySec, 10) || 10), 'crash recovery');
    }
  });
}

function ensureJarExists() {
  const jarPath = path.join(CONFIG.serverDir, CONFIG.serverJar);
  if (!fs.existsSync(jarPath)) {
    throw new Error(`${CONFIG.serverJar} not found in ${CONFIG.serverDir}`);
  }
  return jarPath;
}

function startServer(reason = 'manual') {
  if (mcProcess) {
    throw new Error('Server is already running');
  }
  ensureDir(CONFIG.serverDir);
  ensureJarExists();
  const eulaPath = path.join(CONFIG.serverDir, 'eula.txt');
  if (!fs.existsSync(eulaPath)) {
    fs.writeFileSync(eulaPath, 'eula=true\n');
  }

  const launchArgs = [
    `-Xmx${CONFIG.memory}`,
    `-Xms${CONFIG.memory}`,
    '-jar',
    CONFIG.serverJar,
  ];
  if (CONFIG.serverType !== 'nukkit') {
    launchArgs.push('nogui');
  }

  const child = spawn(CONFIG.javaPath, launchArgs, {
    cwd: CONFIG.serverDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  pendingRestart = null;
  clearTimeout(restartTimer);
  restartTimer = null;
  startTime = Date.now();
  expectedExit = false;
  restartRequested = false;
  attachMcProcess(child);
  addLog(`--- Starting ${CONFIG.serverJar} (${CONFIG.memory} RAM, ${reason}) ---`, 'system');
  broadcast({ type: 'status', ...buildStatusPayload() });
}

function stopServer() {
  if (!mcProcess) {
    throw new Error('Server is not running');
  }
  expectedExit = true;
  mcProcess.stdin.write('stop\n');
  addLog('--- Stop command sent ---', 'system');
}

function forceKillServer() {
  if (!mcProcess) {
    throw new Error('Server is not running');
  }
  expectedExit = true;
  mcProcess.kill('SIGKILL');
  addLog('--- Force killed ---', 'error');
}

function scheduleRestart(delaySec, reason) {
  clearTimeout(restartTimer);
  const safeDelay = Math.max(1, Number.parseInt(delaySec, 10) || 1);
  pendingRestart = {
    reason,
    eta: new Date(Date.now() + safeDelay * 1000).toISOString(),
    delaySec: safeDelay,
  };
  broadcast({ type: 'status', ...buildStatusPayload() });
  restartTimer = setTimeout(() => {
    pendingRestart = null;
    try {
      startServer(reason);
    } catch (error) {
      addLog(`Auto-restart failed: ${error.message}`, 'error');
      appendCrashLog(`Auto-restart failed: ${error.message}`, null, null);
      broadcast({ type: 'status', ...buildStatusPayload() });
    }
  }, safeDelay * 1000);
}

function runLoggedProcess(command, args, cwd, failureLabel) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd });
    proc.stdout.on('data', (chunk) => {
      String(chunk).split('\n').forEach((line) => {
        if (line.trim()) {
          addLog(line.trim(), 'system');
        }
      });
    });
    proc.stderr.on('data', (chunk) => {
      String(chunk).split('\n').forEach((line) => {
        if (line.trim()) {
          addLog(line.trim(), 'warn');
        }
      });
    });
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${failureLabel} exited with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

function downloadFileWithProgress(url, outPath) {
  return new Promise((resolve, reject) => {
    const doGet = (currentUrl, depth = 0) => {
      if (depth > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      const mod = currentUrl.startsWith('https:') ? https : http;
      mod.get(currentUrl, { headers: { 'User-Agent': 'TermuCraft/0.1' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          doGet(response.headers.location, depth + 1);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        ensureDir(path.dirname(outPath));
        downloadState.total = Number.parseInt(response.headers['content-length'] || '0', 10) || 0;
        let received = 0;
        const out = fs.createWriteStream(outPath);
        response.on('data', (chunk) => {
          received += chunk.length;
          downloadState.progress = received;
          broadcast({ type: 'download', ...downloadState });
        });
        response.pipe(out);
        out.on('finish', () => {
          out.close(() => resolve());
        });
        out.on('error', reject);
        response.on('error', reject);
      }).on('error', reject);
    };
    doGet(url);
  });
}

async function verifyDownloadedFile(filePath, expected) {
  if (!expected || !expected.algorithm || !expected.value) {
    const record = updateIntegrityRecord(filePath, { source: 'download' });
    return { verified: false, ...record };
  }
  const actual = shaForFile(filePath, expected.algorithm);
  if (actual !== String(expected.value).toLowerCase()) {
    throw new Error(`Checksum mismatch for ${path.basename(filePath)}`);
  }
  const record = updateIntegrityRecord(filePath, {
    source: 'download',
    verifiedBy: expected.algorithm,
  });
  return {
    verified: true,
    algorithm: expected.algorithm,
    expected: expected.value,
    actual,
    ...record,
  };
}

async function fetchPaperDownload(version) {
  const builds = await httpsGet(`https://api.papermc.io/v2/projects/paper/versions/${version}`);
  const build = Math.max(...builds.builds);
  const detail = await httpsGet(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${build}`);
  const download = detail.downloads?.application;
  return {
    url: `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${build}/downloads/${download.name}`,
    checksum: download?.sha256 ? { algorithm: 'sha256', value: String(download.sha256).toLowerCase() } : null,
  };
}

async function fetchPurpurDownload(version) {
  const builds = await httpsGet(`https://api.purpurmc.org/v2/purpur/${version}`);
  const build = Math.max(...(builds.builds || []));
  if (!Number.isFinite(build)) {
    throw new Error('No Purpur build found for that version');
  }
  return {
    url: `https://api.purpurmc.org/v2/purpur/${version}/${build}/download`,
    checksum: null,
  };
}

async function fetchGitHubReleases(repo) {
  const releases = await httpsGet(`https://api.github.com/repos/${repo}/releases?per_page=25`);
  if (!Array.isArray(releases)) {
    throw new Error('Unexpected GitHub releases response');
  }
  return releases.filter((release) => !release.draft && !release.prerelease);
}

async function fetchNukkitDownload(version) {
  const releases = await fetchGitHubReleases('CloudburstMC/Nukkit');
  const release = releases.find((entry) => String(entry.tag_name || '').replace(/^v/i, '') === String(version).replace(/^v/i, ''));
  if (!release) {
    throw new Error('Nukkit version not found');
  }
  const asset = (release.assets || []).find((item) => /\.jar$/i.test(String(item.name || '')));
  if (!asset?.browser_download_url) {
    throw new Error('No downloadable Nukkit jar found for that release');
  }
  return {
    url: asset.browser_download_url,
    checksum: null,
    version: String(release.tag_name || version).replace(/^v/i, ''),
  };
}

function supportsPluginCrossplay(type) {
  return ['paper', 'purpur'].includes(String(type || '').toLowerCase());
}

async function installCrossplayPlugins() {
  if (!supportsPluginCrossplay(CONFIG.serverType)) {
    throw new Error('Crossplay install currently requires a Paper or Purpur server');
  }
  ensureDir(path.join(CONFIG.serverDir, 'plugins'));
  const targets = [
    {
      name: 'Geyser',
      url: 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot',
      fileName: 'Geyser-Spigot.jar',
    },
    {
      name: 'Floodgate',
      url: 'https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot',
      fileName: 'floodgate-spigot.jar',
    },
  ];

  downloadState = { name: 'Crossplay plugins', progress: 0, total: targets.length, done: false, error: null };
  broadcast({ type: 'download', ...downloadState });

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    const outPath = path.join(CONFIG.serverDir, 'plugins', target.fileName);
    addLog(`--- Downloading ${target.name} ---`, 'system');
    downloadState.name = `${target.name} plugin`;
    downloadState.progress = i;
    broadcast({ type: 'download', ...downloadState });
    await downloadFileWithProgress(target.url, outPath);
    updateIntegrityRecord(outPath, { source: 'crossplay install', package: target.name.toLowerCase() });
  }

  downloadState.progress = targets.length;
  downloadState.done = true;
  downloadState.name = 'Crossplay plugins ready';
  broadcast({ type: 'download', ...downloadState });
  addLog('--- Crossplay plugins installed: Geyser + Floodgate ---', 'system');
}

async function performServerDownload(type, version) {
  ensureDir(CONFIG.serverDir);
  const outPath = path.join(CONFIG.serverDir, 'server.jar');
  let downloadUrl = '';
  let expectedChecksum = null;

  if (type === 'paper') {
    const info = await fetchPaperDownload(version);
    downloadUrl = info.url;
    expectedChecksum = info.checksum;
  } else if (type === 'purpur') {
    const info = await fetchPurpurDownload(version);
    downloadUrl = info.url;
    expectedChecksum = info.checksum;
  } else if (type === 'vanilla') {
    const manifest = await httpsGet('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    const selected = manifest.versions.find((entry) => entry.id === version);
    if (!selected) {
      throw new Error('Version not found');
    }
    const details = await httpsGet(selected.url);
    downloadUrl = details.downloads.server.url;
    expectedChecksum = details.downloads.server.sha1
      ? { algorithm: 'sha1', value: String(details.downloads.server.sha1).toLowerCase() }
      : null;
  } else if (type === 'nukkit') {
    const info = await fetchNukkitDownload(version);
    downloadUrl = info.url;
    expectedChecksum = info.checksum;
    version = info.version;
  } else {
    throw new Error('Unsupported server type');
  }

  downloadState = { name: `${type}-${version}.jar`, progress: 0, total: 0, done: false, error: null };
  broadcast({ type: 'download', ...downloadState });
  await downloadFileWithProgress(downloadUrl, outPath);
  const integrity = await verifyDownloadedFile(outPath, expectedChecksum);
  CONFIG.serverJar = 'server.jar';
  CONFIG.serverType = type;
  CONFIG.serverVersion = version;
  CONFIG.lastDownloadedChecksum = integrity.sha256 || '';
  CONFIG.lastDownloadedChecksumType = 'sha256';
  saveConfig();
  fs.writeFileSync(path.join(CONFIG.serverDir, 'eula.txt'), 'eula=true\n');
  downloadState.done = true;
  downloadState.checksum = integrity.sha256 || null;
  broadcast({ type: 'download', ...downloadState });
  broadcast({ type: 'config', config: CONFIG });
  broadcast({ type: 'jarReady' });
}

async function performInstallerDownload(type, version) {
  ensureDir(CONFIG.serverDir);

  if (type === 'fabric') {
    const loaders = await httpsGet('https://meta.fabricmc.net/v2/versions/loader');
    const installers = await httpsGet('https://meta.fabricmc.net/v2/versions/installer');
    const loaderVer = loaders[0].version;
    const installerVer = installers[0].version;
    const installerUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${installerVer}/fabric-installer-${installerVer}.jar`;
    const installerPath = path.join(CONFIG.serverDir, `fabric-installer-${installerVer}.jar`);

    addLog('--- Downloading Fabric installer ---', 'system');
    downloadState = { name: `fabric-${version} installer`, progress: 0, total: 0, done: false, error: null };
    broadcast({ type: 'download', ...downloadState });
    await downloadFileWithProgress(installerUrl, installerPath);
    await verifyDownloadedFile(installerPath, null);

    addLog('--- Running Fabric installer ---', 'system');
    downloadState.name = `fabric-${version} (installing)`;
    broadcast({ type: 'download', ...downloadState });
    await runLoggedProcess(
      CONFIG.javaPath,
      ['-jar', installerPath, 'server', '-mcversion', version, '-loader', loaderVer, '-downloadMinecraft'],
      CONFIG.serverDir,
      'Fabric installer',
    );
    try {
      fs.unlinkSync(installerPath);
    } catch {
      // Ignore cleanup errors.
    }
    const launchJar = path.join(CONFIG.serverDir, 'fabric-server-launch.jar');
    if (!fs.existsSync(launchJar)) {
      throw new Error('Fabric installer finished but fabric-server-launch.jar is missing');
    }
    const integrity = updateIntegrityRecord(launchJar, { source: 'fabric installer' });
    CONFIG.serverJar = 'fabric-server-launch.jar';
    CONFIG.serverType = 'fabric';
    CONFIG.serverVersion = version;
    CONFIG.lastDownloadedChecksum = integrity ? integrity.sha256 : '';
    CONFIG.lastDownloadedChecksumType = 'sha256';
    saveConfig();
    fs.writeFileSync(path.join(CONFIG.serverDir, 'eula.txt'), 'eula=true\n');
    downloadState.done = true;
    downloadState.checksum = integrity ? integrity.sha256 : null;
    broadcast({ type: 'download', ...downloadState });
    broadcast({ type: 'config', config: CONFIG });
    broadcast({ type: 'jarReady' });
    return;
  }

  if (type === 'quilt') {
    const installers = await httpsGet('https://meta.quiltmc.org/v3/versions/installer');
    const loaders = await httpsGet('https://meta.quiltmc.org/v3/versions/loader');
    const installer = installers[0];
    const loader = loaders.find((item) => !/(alpha|beta)/i.test(item.version)) || loaders[0];
    const installerPath = path.join(CONFIG.serverDir, `quilt-installer-${installer.version}.jar`);

    addLog('--- Downloading Quilt installer ---', 'system');
    downloadState = { name: `quilt-${version} installer`, progress: 0, total: 0, done: false, error: null };
    broadcast({ type: 'download', ...downloadState });
    await downloadFileWithProgress(installer.url, installerPath);
    await verifyDownloadedFile(installerPath, null);

    addLog('--- Running Quilt installer ---', 'system');
    downloadState.name = `quilt-${version} (installing)`;
    broadcast({ type: 'download', ...downloadState });
    await runLoggedProcess(
      CONFIG.javaPath,
      ['-jar', installerPath, 'install', 'server', version, loader.version, '--install-dir=.', '--download-server'],
      CONFIG.serverDir,
      'Quilt installer',
    );
    try {
      fs.unlinkSync(installerPath);
    } catch {
      // Ignore cleanup errors.
    }
    const launchJar = path.join(CONFIG.serverDir, 'quilt-server-launch.jar');
    if (!fs.existsSync(launchJar)) {
      throw new Error('Quilt installer finished but quilt-server-launch.jar is missing');
    }
    const integrity = updateIntegrityRecord(launchJar, { source: 'quilt installer' });
    CONFIG.serverJar = 'quilt-server-launch.jar';
    CONFIG.serverType = 'quilt';
    CONFIG.serverVersion = version;
    CONFIG.lastDownloadedChecksum = integrity ? integrity.sha256 : '';
    CONFIG.lastDownloadedChecksumType = 'sha256';
    saveConfig();
    fs.writeFileSync(path.join(CONFIG.serverDir, 'eula.txt'), 'eula=true\n');
    downloadState.done = true;
    downloadState.checksum = integrity ? integrity.sha256 : null;
    broadcast({ type: 'download', ...downloadState });
    broadcast({ type: 'config', config: CONFIG });
    broadcast({ type: 'jarReady' });
    return;
  }

  if (type === 'forge') {
    const mcMatch = String(version).match(/^([0-9.]+)/);
    const forgeMatch = String(version).match(/- ([0-9.]+)/);
    if (!mcMatch || !forgeMatch) {
      throw new Error('Could not parse Forge version');
    }
    const mcVersion = mcMatch[1];
    const forgeVersion = forgeMatch[1];
    const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/forge-${mcVersion}-${forgeVersion}-installer.jar`;
    const installerPath = path.join(CONFIG.serverDir, `forge-${mcVersion}-${forgeVersion}-installer.jar`);

    addLog(`--- Downloading Forge ${mcVersion}-${forgeVersion} installer ---`, 'system');
    downloadState = { name: `forge-${mcVersion}-${forgeVersion} installer`, progress: 0, total: 0, done: false, error: null };
    broadcast({ type: 'download', ...downloadState });
    await downloadFileWithProgress(installerUrl, installerPath);
    await verifyDownloadedFile(installerPath, null);

    addLog('--- Running Forge installer ---', 'system');
    downloadState.name = `forge-${mcVersion}-${forgeVersion} (installing)`;
    broadcast({ type: 'download', ...downloadState });
    await runLoggedProcess(
      CONFIG.javaPath,
      ['-jar', installerPath, '--installServer'],
      CONFIG.serverDir,
      'Forge installer',
    );
    try {
      fs.unlinkSync(installerPath);
    } catch {
      // Ignore cleanup errors.
    }
    const shimJar = `forge-${mcVersion}-${forgeVersion}-shim.jar`;
    const plainJar = `forge-${mcVersion}-${forgeVersion}.jar`;
    const chosenJar = fs.existsSync(path.join(CONFIG.serverDir, shimJar))
      ? shimJar
      : (fs.existsSync(path.join(CONFIG.serverDir, plainJar)) ? plainJar : null);
    if (!chosenJar) {
      throw new Error('Forge installed but no starter jar was detected');
    }
    const integrity = updateIntegrityRecord(path.join(CONFIG.serverDir, chosenJar), { source: 'forge installer' });
    CONFIG.serverJar = chosenJar;
    CONFIG.serverType = 'forge';
    CONFIG.serverVersion = `${mcVersion}-${forgeVersion}`;
    CONFIG.lastDownloadedChecksum = integrity ? integrity.sha256 : '';
    CONFIG.lastDownloadedChecksumType = 'sha256';
    saveConfig();
    fs.writeFileSync(path.join(CONFIG.serverDir, 'eula.txt'), 'eula=true\n');
    downloadState.done = true;
    downloadState.checksum = integrity ? integrity.sha256 : null;
    broadcast({ type: 'download', ...downloadState });
    broadcast({ type: 'config', config: CONFIG });
    broadcast({ type: 'jarReady' });
    return;
  }

  if (type === 'neoforge') {
    const installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
    const installerPath = path.join(CONFIG.serverDir, `neoforge-${version}-installer.jar`);

    addLog(`--- Downloading NeoForge ${version} installer ---`, 'system');
    downloadState = { name: `neoforge-${version} installer`, progress: 0, total: 0, done: false, error: null };
    broadcast({ type: 'download', ...downloadState });
    await downloadFileWithProgress(installerUrl, installerPath);
    await verifyDownloadedFile(installerPath, null);

    addLog('--- Running NeoForge installer ---', 'system');
    downloadState.name = `neoforge-${version} (installing)`;
    broadcast({ type: 'download', ...downloadState });
    await runLoggedProcess(
      CONFIG.javaPath,
      ['-jar', installerPath, '--installServer', '.', '--serverJar'],
      CONFIG.serverDir,
      'NeoForge installer',
    );
    try {
      fs.unlinkSync(installerPath);
    } catch {
      // Ignore cleanup errors.
    }
    const starterJar = ['server.jar', `neoforge-${version}-server.jar`]
      .find((name) => fs.existsSync(path.join(CONFIG.serverDir, name)));
    if (!starterJar) {
      throw new Error('NeoForge installed but no starter jar was found');
    }
    const integrity = updateIntegrityRecord(path.join(CONFIG.serverDir, starterJar), { source: 'neoforge installer' });
    CONFIG.serverJar = starterJar;
    CONFIG.serverType = 'neoforge';
    CONFIG.serverVersion = version;
    CONFIG.lastDownloadedChecksum = integrity ? integrity.sha256 : '';
    CONFIG.lastDownloadedChecksumType = 'sha256';
    saveConfig();
    fs.writeFileSync(path.join(CONFIG.serverDir, 'eula.txt'), 'eula=true\n');
    downloadState.done = true;
    downloadState.checksum = integrity ? integrity.sha256 : null;
    broadcast({ type: 'download', ...downloadState });
    broadcast({ type: 'config', config: CONFIG });
    broadcast({ type: 'jarReady' });
    return;
  }

  throw new Error('Unsupported installer type');
}

async function handleServerDownload(type, version) {
  if (downloadState && !downloadState.done && !downloadState.error) {
    throw new Error('A download is already in progress');
  }

  if (fs.existsSync(CONFIG.serverDir)) {
    try {
      const backup = createBackup(`pre-update ${type} ${version}`);
      addLog(`--- Pre-update backup created (${backup.id}) ---`, 'system');
    } catch (error) {
      addLog(`Backup before update failed: ${error.message}`, 'warn');
    }
  }

  if (type === 'paper' || type === 'purpur' || type === 'vanilla' || type === 'nukkit') {
    await performServerDownload(type, version);
    return;
  }
  await performInstallerDownload(type, version);
}

function sanitizeUploadName(name) {
  const clean = path.basename(String(name || ''));
  if (!clean.endsWith('.jar')) {
    throw new Error('Only .jar files are allowed');
  }
  return clean;
}

function saveUploadedJar(dirName, filename, data) {
  const targetDir = path.join(CONFIG.serverDir, dirName);
  ensureDir(targetDir);
  const safeName = sanitizeUploadName(filename);
  const targetPath = path.join(targetDir, safeName);
  if (fs.existsSync(targetPath)) {
    throw new Error('File already exists');
  }
  fs.writeFileSync(targetPath, Buffer.from(data, 'base64'));
  const integrity = updateIntegrityRecord(targetPath, { source: 'upload' });
  return {
    ok: true,
    name: safeName,
    sha256: integrity ? integrity.sha256 : null,
  };
}

function maybeRunScheduledTasks() {
  const now = new Date();
  const nowMs = now.getTime();

  const backupMinutes = Number.parseInt(CONFIG.scheduleBackupMinutes, 10) || 0;
  if (backupMinutes > 0 && nowMs - schedulerState.lastBackupAt >= backupMinutes * 60 * 1000) {
    schedulerState.lastBackupAt = nowMs;
    try {
      const backup = createBackup('scheduled backup');
      addLog(`--- Scheduled backup created (${backup.id}) ---`, 'system');
      broadcast({ type: 'status', ...buildStatusPayload() });
    } catch (error) {
      addLog(`Scheduled backup failed: ${error.message}`, 'warn');
    }
  }

  const broadcastMinutes = Number.parseInt(CONFIG.scheduleBroadcastMinutes, 10) || 0;
  const broadcastMessage = String(CONFIG.scheduleBroadcastMessage || '').trim();
  if (broadcastMinutes > 0 && broadcastMessage && mcProcess && nowMs - schedulerState.lastBroadcastAt >= broadcastMinutes * 60 * 1000) {
    schedulerState.lastBroadcastAt = nowMs;
    mcProcess.stdin.write(`say ${broadcastMessage}\n`);
    addLog(`> say ${broadcastMessage}`, 'cmd');
  }

  if (CONFIG.scheduleRestartTime && validateScheduleTime(CONFIG.scheduleRestartTime)) {
    const slot = `${now.toISOString().slice(0, 10)} ${CONFIG.scheduleRestartTime}`;
    const localTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (localTime === CONFIG.scheduleRestartTime && schedulerState.lastRestartSlot !== slot) {
      schedulerState.lastRestartSlot = slot;
      if (mcProcess) {
        addLog('--- Scheduled restart triggered ---', 'system');
        restartRequested = true;
        expectedExit = true;
        mcProcess.stdin.write('stop\n');
      }
    }
  }
}

app.use(express.json({ limit: '700mb' }));

app.use((error, req, res, next) => {
  if (!error) {
    next();
    return;
  }
  if (error.type === 'entity.too.large') {
    res.status(413).json({ error: 'Upload too large for server limit' });
    return;
  }
  res.status(400).json({ error: error.message || 'Bad request' });
});

app.get('/api/auth/status', (req, res) => {
  const session = getSessionFromRequest(req);
  res.json({
    authenticated: true,
    username: ACCESS.profile.handle,
    handle: ACCESS.profile.handle,
    authRequired: false,
    bootstrap: false,
  });
});

app.post('/api/auth/login', (req, res) => {
  if (!AUTH_FEATURE_ENABLED) {
    res.json({ ok: true, disabled: true, username: ACCESS.profile.handle, handle: ACCESS.profile.handle, bootstrap: false });
    return;
  }
  const handle = String(req.body?.handle || req.body?.username || '').trim();
  const secret = String(req.body?.secret || req.body?.password || '');
  if (!verifyAccess(handle, secret)) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }
  const token = createSession(ACCESS.profile.handle);
  setSessionCookie(res, token);
  res.json({ ok: true, username: ACCESS.profile.handle, handle: ACCESS.profile.handle, bootstrap: !!ACCESS.flags?.bootstrap });
});

app.post('/api/auth/logout', (req, res) => {
  if (!AUTH_FEATURE_ENABLED) {
    res.json({ ok: true, disabled: true });
    return;
  }
  const session = getSessionFromRequest(req);
  if (session) {
    sessions.delete(session.token);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/change', requireAuth, (req, res) => {
  if (!AUTH_FEATURE_ENABLED) {
    res.json({ ok: true, disabled: true, username: ACCESS.profile.handle, handle: ACCESS.profile.handle });
    return;
  }
  const currentSecret = String(req.body?.currentSecret || req.body?.currentPassword || '');
  const handle = String(req.body?.handle || req.body?.username || '').trim();
  const nextSecret = String(req.body?.nextSecret || req.body?.newPassword || '');
  if (!verifyAccess(ACCESS.profile.handle, currentSecret)) {
    res.status(400).json({ error: 'Current password is incorrect' });
    return;
  }
  if (!handle) {
    res.status(400).json({ error: 'Username is required' });
    return;
  }
  if (nextSecret.length < 4) {
    res.status(400).json({ error: 'New password must be at least 4 characters' });
    return;
  }
  setAccess(handle, nextSecret, false);
  const token = createSession(ACCESS.profile.handle);
  setSessionCookie(res, token);
  res.json({ ok: true, username: ACCESS.profile.handle, handle: ACCESS.profile.handle });
});

app.use('/api', requireAuth);

app.get('/api/status', (req, res) => {
  res.json(buildStatusPayload());
});

app.post('/api/start', (req, res) => {
  try {
    startServer('manual start');
    res.json({ ok: true });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.post('/api/stop', (req, res) => {
  try {
    stopServer();
    res.json({ ok: true });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.post('/api/restart', (req, res) => {
  try {
    ensureJarExists();
    if (!mcProcess) {
      throw new Error('Server is not running');
    }
    restartRequested = true;
    expectedExit = true;
    mcProcess.stdin.write('stop\n');
    addLog('--- Restart command sent ---', 'system');
    res.json({ ok: true });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.post('/api/kill', (req, res) => {
  try {
    forceKillServer();
    res.json({ ok: true });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.post('/api/command', (req, res) => {
  const command = String(req.body?.command || '').trim();
  if (!command) {
    res.json({ error: 'Command is empty' });
    return;
  }
  if (!mcProcess) {
    res.json({ error: 'Server is not running' });
    return;
  }
  mcProcess.stdin.write(`${command}\n`);
  addLog(`> ${command}`, 'cmd');
  res.json({ ok: true });
});

app.post('/api/player/:action', (req, res) => {
  if (!mcProcess) {
    res.json({ error: 'Server is not running' });
    return;
  }
  const name = String(req.body?.name || '').trim();
  const extra = String(req.body?.extra || '').trim();
  const map = {
    kick: `kick ${name} ${extra || 'Kicked by admin'}`,
    ban: `ban ${name} ${extra || 'Banned by admin'}`,
    unban: `pardon ${name}`,
    op: `op ${name}`,
    deop: `deop ${name}`,
    survival: `gamemode survival ${name}`,
    creative: `gamemode creative ${name}`,
    spectator: `gamemode spectator ${name}`,
    adventure: `gamemode adventure ${name}`,
    tp: extra ? `tp ${name} ${extra}` : null,
    heal: `effect give ${name} minecraft:instant_health 1 255`,
    feed: `effect give ${name} minecraft:saturation 1 255`,
    kill: `kill ${name}`,
  };
  const command = map[req.params.action];
  if (!command) {
    res.json({ error: 'Unknown player action' });
    return;
  }
  mcProcess.stdin.write(`${command}\n`);
  addLog(`> ${command}`, 'cmd');
  res.json({ ok: true });
});

app.post('/api/list', (req, res) => {
  if (mcProcess) {
    mcProcess.stdin.write('list\n');
  }
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  res.json(CONFIG);
});

app.post('/api/config', (req, res) => {
  const nextConfig = { ...CONFIG };
  if (req.body?.memory) {
    nextConfig.memory = String(req.body.memory).trim().toUpperCase();
  }
  if (req.body?.serverDir) {
    nextConfig.serverDir = path.resolve(String(req.body.serverDir));
  }
  if (req.body?.serverJar) {
    nextConfig.serverJar = path.basename(String(req.body.serverJar));
  }
  if (req.body?.javaPath) {
    nextConfig.javaPath = String(req.body.javaPath).trim();
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'httpsEnabled')) {
    nextConfig.httpsEnabled = !!req.body.httpsEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'httpsPort')) {
    nextConfig.httpsPort = Math.max(1, Number.parseInt(req.body.httpsPort, 10) || 8443);
  }
  if (req.body?.httpsCertPath) {
    nextConfig.httpsCertPath = path.resolve(String(req.body.httpsCertPath).trim());
  }
  if (req.body?.httpsKeyPath) {
    nextConfig.httpsKeyPath = path.resolve(String(req.body.httpsKeyPath).trim());
  }
  if (req.body?.preset && PRESETS[req.body.preset]) {
    nextConfig.preset = req.body.preset;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'autoRestart')) {
    nextConfig.autoRestart = !!req.body.autoRestart;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'autoRestartDelaySec')) {
    nextConfig.autoRestartDelaySec = Math.max(1, Number.parseInt(req.body.autoRestartDelaySec, 10) || 10);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'backupRetention')) {
    nextConfig.backupRetention = Math.max(1, Number.parseInt(req.body.backupRetention, 10) || 5);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'scheduleBackupMinutes')) {
    nextConfig.scheduleBackupMinutes = Math.max(0, Number.parseInt(req.body.scheduleBackupMinutes, 10) || 0);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'scheduleBroadcastMinutes')) {
    nextConfig.scheduleBroadcastMinutes = Math.max(0, Number.parseInt(req.body.scheduleBroadcastMinutes, 10) || 0);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'scheduleBroadcastMessage')) {
    nextConfig.scheduleBroadcastMessage = String(req.body.scheduleBroadcastMessage || '');
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'scheduleRestartTime')) {
    const value = String(req.body.scheduleRestartTime || '').trim();
    if (!validateScheduleTime(value)) {
      res.status(400).json({ error: 'Restart time must be HH:MM or empty' });
      return;
    }
    nextConfig.scheduleRestartTime = value;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'motd')) {
    nextConfig.motd = String(req.body.motd || '');
  }
  CONFIG = nextConfig;
  saveConfig();
  updateSystemStats();
  broadcast({ type: 'config', config: CONFIG });
  res.json({ ok: true, config: CONFIG });
});

app.get('/api/presets', (req, res) => {
  res.json({ presets: PRESETS, current: CONFIG.preset });
});

app.post('/api/presets/:name', (req, res) => {
  try {
    const result = applyPreset(req.params.name);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/api/properties', (req, res) => {
  const props = readProperties();
  if (!props.motd && CONFIG.motd) {
    props.motd = CONFIG.motd;
  }
  res.json(props);
});

app.post('/api/properties', (req, res) => {
  try {
    const props = { ...req.body };
    if (Object.prototype.hasOwnProperty.call(props, 'motd')) {
      CONFIG.motd = String(props.motd || '');
      saveConfig();
    }
    writeProperties(props);
    res.json({ ok: true });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/api/backups', (req, res) => {
  res.json({ backups: listBackups() });
});

app.post('/api/backups/create', (req, res) => {
  try {
    const backup = createBackup(String(req.body?.label || '').trim() || 'manual backup');
    res.json({ ok: true, backup });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.post('/api/backups/:id/restore', (req, res) => {
  try {
    const result = restoreBackup(req.params.id);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.delete('/api/backups/:id', (req, res) => {
  try {
    deleteBackup(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/api/files', (req, res) => {
  res.json(getManagedFilesOverview());
});

app.get('/api/files/read', (req, res) => {
  const spec = getManagedFileSpec(String(req.query.key || ''));
  if (!spec) {
    res.status(404).json({ error: 'Unknown file' });
    return;
  }
  const filePath = spec.resolve();
  if (!fs.existsSync(filePath)) {
    res.json({
      key: spec.key,
      label: spec.label,
      editable: spec.editable,
      exists: false,
      content: '',
      sha256: null,
    });
    return;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const integrity = updateIntegrityRecord(filePath, { label: spec.label });
  res.json({
    key: spec.key,
    label: spec.label,
    editable: spec.editable,
    exists: true,
    content,
    sha256: integrity ? integrity.sha256 : null,
  });
});

app.post('/api/files/write', (req, res) => {
  const spec = getManagedFileSpec(String(req.body?.key || ''));
  if (!spec || !spec.editable) {
    res.json({ error: 'That file cannot be edited here' });
    return;
  }
  try {
    const filePath = spec.resolve();
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, String(req.body?.content || ''));
    const integrity = updateIntegrityRecord(filePath, { label: spec.label });
    res.json({ ok: true, sha256: integrity ? integrity.sha256 : null });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/api/admin/:type', (req, res) => {
  try {
    res.json({ entries: readAdminList(req.params.type) });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.post('/api/admin/:type', async (req, res) => {
  try {
    const entry = await addAdminEntry(req.params.type, req.body || {});
    res.json({ ok: true, entry });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.delete('/api/admin/:type/:name', (req, res) => {
  try {
    removeAdminEntry(req.params.type, decodeURIComponent(req.params.name));
    res.json({ ok: true });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/api/plugins', (req, res) => {
  res.json({ plugins: listSimpleDir(path.join(CONFIG.serverDir, 'plugins'), ['.jar']) });
});

app.get('/api/mods', (req, res) => {
  res.json({ mods: listSimpleDir(path.join(CONFIG.serverDir, 'mods'), ['.jar']) });
});

app.post('/api/mods/upload', (req, res) => {
  try {
    res.json(saveUploadedJar('mods', req.body?.filename, req.body?.data));
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.delete('/api/mods/:name', (req, res) => {
  const filePath = path.join(CONFIG.serverDir, 'mods', path.basename(req.params.name));
  if (!fs.existsSync(filePath)) {
    res.json({ error: 'File not found' });
    return;
  }
  fs.unlinkSync(filePath);
  delete INTEGRITY.records[filePath];
  saveIntegrity();
  res.json({ ok: true });
});

app.post('/api/plugins/upload', (req, res) => {
  try {
    res.json(saveUploadedJar('plugins', req.body?.filename, req.body?.data));
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.delete('/api/plugins/:name', (req, res) => {
  const filePath = path.join(CONFIG.serverDir, 'plugins', path.basename(req.params.name));
  if (!fs.existsSync(filePath)) {
    res.json({ error: 'File not found' });
    return;
  }
  fs.unlinkSync(filePath);
  delete INTEGRITY.records[filePath];
  saveIntegrity();
  res.json({ ok: true });
});

app.get('/api/versions/paper', async (req, res) => {
  try {
    const data = await httpsGet('https://api.papermc.io/v2/projects/paper');
    res.json({ versions: [...data.versions].reverse() });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/api/versions/purpur', async (req, res) => {
  try {
    const data = await httpsGet('https://api.purpurmc.org/v2/purpur');
    res.json({ versions: [...(data.versions || [])].reverse() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/versions/vanilla', async (req, res) => {
  try {
    const manifest = await httpsGet('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    const releases = manifest.versions.filter((entry) => entry.type === 'release');
    res.json({
      versions: releases.map((entry) => entry.id),
      urls: Object.fromEntries(releases.map((entry) => [entry.id, entry.url])),
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/api/versions/nukkit', async (req, res) => {
  try {
    const releases = await fetchGitHubReleases('CloudburstMC/Nukkit');
    res.json({
      versions: releases
        .map((release) => String(release.tag_name || '').replace(/^v/i, ''))
        .filter(Boolean),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/versions/fabric', async (req, res) => {
  try {
    const versions = await httpsGet('https://meta.fabricmc.net/v2/versions/game');
    res.json({ versions: versions.filter((entry) => entry.stable).map((entry) => entry.version) });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/api/versions/forge', async (req, res) => {
  try {
    const data = await httpsGet('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    const versions = [];
    const seen = new Set();
    Object.entries(data.promos || {}).forEach(([key, forgeVersion]) => {
      const match = key.match(/^(.+)-(latest|recommended)$/);
      if (!match) {
        return;
      }
      const mcVersion = match[1];
      const label = `${mcVersion} - ${forgeVersion} (${match[2]})`;
      const dedupeKey = `${mcVersion}-${forgeVersion}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        versions.push(label);
      }
    });
    res.json({ versions: versions.reverse() });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/api/versions/neoforge', async (req, res) => {
  try {
    const xml = await httpsGetRaw('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    const versions = parseXmlVersions(xml).filter((version) => !/(alpha|beta|snapshot)/i.test(version));
    res.json({ versions: versions.reverse() });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/api/versions/quilt', async (req, res) => {
  try {
    const versions = await httpsGet('https://meta.quiltmc.org/v3/versions/game');
    res.json({ versions: versions.filter((entry) => entry.stable).map((entry) => entry.version) });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.post('/api/download', async (req, res) => {
  const type = String(req.body?.type || '').trim();
  const version = String(req.body?.version || '').trim();
  const force = !!req.body?.force;
  const sameVersion = CONFIG.serverType === type && CONFIG.serverVersion === version;
  if (!type || !version) {
    res.json({ error: 'Type and version are required' });
    return;
  }
  if (sameVersion && !force) {
    res.json({
      needsConfirm: true,
      error: `Same version already installed: ${type} ${version}`,
    });
    return;
  }

  res.json({ ok: true });

  try {
    await handleServerDownload(type, version);
  } catch (error) {
    downloadState = downloadState || { name: `${type}-${version}`, progress: 0, total: 0, done: false, error: null };
    downloadState.error = error.message;
    addLog(`Download error: ${error.message}`, 'error');
    broadcast({ type: 'download', ...downloadState });
  }
});

app.post('/api/crossplay/install', async (req, res) => {
  try {
    await installCrossplayPlugins();
    res.json({ ok: true });
  } catch (error) {
    downloadState = downloadState || { name: 'Crossplay install', progress: 0, total: 0, done: false, error: null };
    downloadState.error = error.message;
    broadcast({ type: 'download', ...downloadState });
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/integrity', (req, res) => {
  res.json({
    records: INTEGRITY.records,
    lastDownloadedChecksum: CONFIG.lastDownloadedChecksum || null,
    lastDownloadedChecksumType: CONFIG.lastDownloadedChecksumType || null,
  });
});

app.get('/api/validation', (req, res) => {
  res.json(collectValidation());
});

app.use(express.static(STATIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

updateSystemStats();
setInterval(updateSystemStats, 1000);
setInterval(maybeRunScheduledTasks, 30 * 1000);

function createPanelServer() {
  if (hasHttpsConfig()) {
    const tlsOptions = {
      key: fs.readFileSync(CONFIG.httpsKeyPath),
      cert: fs.readFileSync(CONFIG.httpsCertPath),
    };
    return { instance: https.createServer(tlsOptions, app), protocol: 'https', port: CONFIG.httpsPort };
  }
  return { instance: http.createServer(app), protocol: 'http', port: CONFIG.uiPort };
}

const panelServer = createPanelServer();
server = panelServer.instance;
wss = new WebSocketServer({ server });

wss.on('connection', (socket, req) => {
  if (ACCESS.authRequired && !getSessionFromRequest(req)) {
    socket.close(4001, 'auth');
    return;
  }

  socket.send(JSON.stringify({ type: 'history', logs: logHistory }));
  socket.send(JSON.stringify({ type: 'status', ...buildStatusPayload() }));
  socket.send(JSON.stringify({ type: 'config', config: CONFIG }));
  socket.send(JSON.stringify({ type: 'stats', ...systemStats }));
  if (downloadState) {
    socket.send(JSON.stringify({ type: 'download', ...downloadState }));
  }

  const tick = setInterval(() => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({ type: 'uptime', uptime: getUptime() }));
    }
  }, 1000);

  socket.on('close', () => {
    clearInterval(tick);
  });
});

server.listen(panelServer.port, '0.0.0.0', () => {
  const network = getNetworkInfo();
  console.log(`\n  TermuCraft panel: ${panelServer.protocol}://localhost:${panelServer.port}`);
  console.log(`  LAN address:   ${panelServer.protocol}://${network.lanIp}:${panelServer.port}\n`);
});
