'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { loadConfig } = require('./config.js');
const { systemInput } = require('./system-input.js');
const { createAdbTunnel, provisionTcpListener } = require('./adb-tunnel.js');
const { deviceAdb, isHostAdbCommand, runAdbProcess } = require('./adb-device.js');
const { createAdbRouteSelection } = require('./adb-route.js');

if (process.argv[2]) process.env.ANDROID_REMOTE_LAB_CONFIG = process.argv[2];
const config = loadConfig();
const adbTunnels = new Map();
const tvTunnels = new Map();
const selectAdbRoute = createAdbRouteSelection();
const adbOperationTimeoutMs = 30_000;

async function executeDeviceAdb(deviceId, owner, request, owns) {
  let dispatched = false;
  try {
    return await routeDeviceAdb(deviceId, owner, request, owns, () => { dispatched = true; });
  } catch (error) {
    if (!dispatched) error.dispatchState = 'not-started';
    throw error;
  }
}

async function pairDeviceAdb(deviceId, owner, args, owns) {
  const pairingCode = args?.code;
  if (typeof pairingCode !== 'string' || !/^\d{6}$/.test(pairingCode)) {
    throw new Error('adb-pairing-code-required');
  }
  const adbPath = config.systemInput?.adbPath;
  if (!adbPath || !path.isAbsolute(adbPath)) throw new Error('adb-executable-not-configured');
  const connection = connections.get(deviceId);
  if (!connection || connection.socket.destroyed || Number(connection.versionCode || 0) < 26) {
    throw new Error('adb-pairing-companion-update-required');
  }
  const pairingTunnel = await createAdbTunnel(
    (command, input) => invokeCommand(deviceId, command, input, adbOperationTimeoutMs),
    () => owns() && connections.get(deviceId) === connection,
    () => {}, { purpose: 'pairing' });
  try {
    const result = await runAdbProcess(adbPath, ['pair', pairingTunnel.serial, pairingCode],
      { timeoutMs: 45_000 }, owns);
    const confirmed = !result.error && result.exitCode === 0
      && /Successfully paired to /i.test(`${result.stdout}\n${result.stderr}`);
    if (!confirmed) return { ok: false, result: { transport: 'adb', deviceId,
      pairingRoute: 'companion-tunnel', ...result,
      error: result.error || 'adb-pairing-not-confirmed' } };
  } finally {
    pairingTunnel.close();
  }
  try {
    const bound = await bindDeviceAdb(deviceId, owner, owns);
    return { ok: true, result: { transport: 'adb', deviceId, pairingRoute: 'companion-tunnel',
      paired: true, ...bound } };
  } catch (error) {
    // Pairing may have succeeded even when the follow-up connection did not.
    // A later adb_bind resumes without asking Android for a new pairing code.
    return { ok: false, result: { transport: 'adb', deviceId, pairingRoute: 'companion-tunnel',
      paired: true, bound: false, error: error.message || 'adb-binding-failed' } };
  }
}

async function bindDeviceAdb(deviceId, owner, owns) {
  const adbPath = config.systemInput?.adbPath;
  if (!adbPath || !path.isAbsolute(adbPath)) throw new Error('adb-executable-not-configured');
  const connection = connections.get(deviceId);
  if (!connection || connection.socket.destroyed) throw new Error('device-not-connected');
  const tunnel = await createAdbTunnel(
    (command, input) => invokeCommand(deviceId, command, input, adbOperationTimeoutMs),
    () => owns() && connections.get(deviceId) === connection);
  try {
    const connected = await runAdbProcess(adbPath, ['connect', tunnel.serial],
      { timeoutMs: 20_000 }, owns);
    if (connected.error || connected.exitCode !== 0
        || !/(?:connected to|already connected to)/i.test(`${connected.stdout}\n${connected.stderr}`)) {
      throw new Error(connected.error || 'adb-connect-not-confirmed');
    }
    const identity = await runAdbProcess(adbPath,
      ['-s', tunnel.serial, 'shell', 'getprop', 'ro.serialno'], { timeoutMs: 20_000 }, owns);
    const hardwareSerial = identity.stdout.trim();
    if (identity.error || identity.exitCode !== 0
        || !/^[A-Za-z0-9_.-]{1,128}$/.test(hardwareSerial) || hardwareSerial === 'unknown') {
      throw new Error(identity.error || 'adb-hardware-identity-unavailable');
    }
    if (!owns()) throw new Error('adb-control-lease-expired');
    const stored = readJson(config.configPath, {}, true);
    const existing = stored.systemInput?.devices?.[deviceId];
    if (existing && existing.hardwareSerial !== hardwareSerial) throw new Error('adb-device-mismatch');
    const systemInput = { ...stored.systemInput, adbPath, devices: {
      ...stored.systemInput?.devices,
      [deviceId]: existing || { serial: hardwareSerial, hardwareSerial },
    } };
    writeJson(config.configPath, { ...stored, systemInput });
    config.systemInput = systemInput;
    return { bound: true, hardwareSerial };
  } finally {
    tunnel.close();
  }
}

async function routeDeviceAdb(deviceId, owner, request, owns, onDispatch) {
  const direct = () => deviceAdb(config, deviceId, request, owns, undefined, onDispatch);
  if (isHostAdbCommand(request.argv)) return direct();
  if (Number(connections.get(deviceId)?.versionCode || 0) < 16) {
    if (request.route === 'companion') throw new Error('adb-companion-tunnel-unavailable');
    return direct();
  }
  const transportChange = ['tcpip', 'usb'].includes(request.argv?.[0]);
  if ((!request.route || request.route === 'auto') && !transportChange) {
    const status = await invokeCommand(deviceId, 'adb_tunnel_status', { repair: true }, adbOperationTimeoutMs);
    if (status.ok && status.result.ready && status.result.listenerType === 'tls') {
      // Provision while a TLS route exists, including when LAN discovery could
      // otherwise hide the missing mobile-capable TCP listener after a reboot.
      await preparedCompanionAdbConfig(deviceId, owner, request, owns);
    }
  }
  return selectAdbRoute(deviceId, request, direct, async () => {
    const remoteConfig = await preparedCompanionAdbConfig(deviceId, owner, request, owns);
    return deviceAdb(remoteConfig, deviceId, request, owns, undefined, onDispatch);
  });
}

async function preparedCompanionAdbConfig(deviceId, owner, request, owns) {
  let remoteConfig = await tunneledAdbConfig(deviceId, owner, request);
  const tunnel = adbTunnels.get(deviceId);
  if (tunnel?.listenerType === 'tls' && !['tcpip', 'usb'].includes(request.argv?.[0])) {
    await provisionTcpListener({ listenerType: tunnel.listenerType },
      () => deviceAdb(remoteConfig, deviceId, { argv: ['tcpip', '5555'], timeoutMs: 15_000 }, owns),
      async () => {
        const status = await invokeCommand(deviceId, 'adb_tunnel_status', {}, adbOperationTimeoutMs);
        if (!status.ok) throw new Error(status.error?.message || 'adb-listener-status-failed');
        return status.result;
      });
    remoteConfig = await tunneledAdbConfig(deviceId, owner, request);
  }
  return remoteConfig;
}

async function tunneledAdbConfig(deviceId, owner, request = {}) {
  if (isHostAdbCommand(request.argv)) return config;
  const connection = connections.get(deviceId);
  if (Number(connection?.versionCode) < 16 || !connection?.versionCode) return config;
  const binding = config.systemInput?.devices?.[deviceId];
  if (!binding) throw new Error('adb-device-binding-required');
  let tunnel = adbTunnels.get(deviceId);
  if (tunnel?.lastError) {
    tunnel.close();
    tunnel = null;
  }
  if (tunnel && !tunnel.closed && tunnel.connection === connection && tunnel.owner === owner) {
    const status = await invokeCommand(deviceId, 'adb_tunnel_status', { repair: true }, adbOperationTimeoutMs);
    if (!status.ok) throw new Error(status.error?.message || 'adb-listener-status-failed');
    if (!status.result.ready) {
      tunnel.close();
      tunnel = null;
    }
    // The SDK can retain an offline TCP transport. A new loopback endpoint also
    // invalidates that stale transport after Android restarts its ADB listener.
    if (tunnel && (tunnel.lastError || tunnel.listenerPort !== (status.result.port || status.result.tlsPort))) {
      tunnel.close();
      tunnel = null;
    }
  }
  if (!tunnel || tunnel.closed || tunnel.connection !== connection || tunnel.owner !== owner) {
    tunnel?.close();
    const owns = () => ownerControlsDevice(deviceId, owner) && connections.get(deviceId) === connection
      && !connection.socket.destroyed;
    tunnel = await createAdbTunnel((command, args) => invokeCommand(deviceId, command, args, adbOperationTimeoutMs), owns);
    tunnel.connection = connection;
    tunnel.owner = owner;
    adbTunnels.set(deviceId, tunnel);
  }
  return { ...config, systemInput: { ...config.systemInput, devices: {
    ...config.systemInput.devices, [deviceId]: { ...binding, serial: tunnel.serial, route: 'companion-tunnel' },
  } } };
}

async function openTvRemoteTunnel(deviceId, owner, args) {
  const purpose = args?.purpose;
  if (!['tv-pairing', 'tv-control'].includes(purpose)) throw new Error('tv-remote-tunnel-purpose-required');
  const connection = connections.get(deviceId);
  if (!connection || connection.socket.destroyed || Number(connection.versionCode || 0) < 36) {
    throw new Error('tv-remote-tunnel-companion-update-required');
  }
  const id = crypto.randomUUID();
  const owns = () => ownerControlsDevice(deviceId, owner)
    && connections.get(deviceId) === connection && !connection.socket.destroyed;
  const tunnel = await createAdbTunnel(
    (command, input) => invokeCommand(deviceId, command, input, adbOperationTimeoutMs),
    owns, () => tvTunnels.delete(id), { purpose });
  tvTunnels.set(id, { tunnel, deviceId, owner });
  return { tunnelId: id, host: '127.0.0.1', port: Number(tunnel.serial.split(':')[1]) };
}

function closeTvRemoteTunnel(deviceId, owner, args) {
  const record = tvTunnels.get(args?.tunnelId);
  if (!record || record.deviceId !== deviceId || record.owner !== owner) {
    throw new Error('tv-remote-tunnel-not-owned');
  }
  record.tunnel.close();
  return { closed: true };
}

async function executeSystemInput(deviceId, owner, args) {
  const owns = () => ownerControlsDevice(deviceId, owner) && Boolean(connections.get(deviceId)?.socket
    && !connections.get(deviceId).socket.destroyed);
  if (!config.systemInput?.devices?.[deviceId]) throw new Error('system-input-not-configured');
  const connected = await executeDeviceAdb(deviceId, owner, { argv: ['get-state'] }, owns);
  if (!connected.ok) throw new Error('system-input-adb-unavailable');
  const inputConfig = connected.result.connectionRoute === 'companion-tunnel'
    ? await tunneledAdbConfig(deviceId, owner) : config;
  return systemInput(inputConfig, deviceId, args || {}, owns);
}
const stateDir = config.stateDir;
const logPath = path.join(stateDir, 'relay.log');
const ingressPort = config.ingressPort;
const apiPort = config.apiPort;
const maxFrameBytes = 16 * 1024 * 1024;
const maxAuthenticationFrameBytes = 8 * 1024;
const maxApiBodyBytes = 1024 * 1024;
const maxPendingEnrollments = 16;
const pendingEnrollmentTtlMs = 60 * 60 * 1000;
const displayLeaseMillis = 90_000;
const displayRenewalIntervalMs = Number(config.controlLeaseRenewalIntervalMs) || 45_000;
const displayRenewalRetryMs = Number(config.controlLeaseRenewalRetryMs) || 5_000;
const displayRenewalTimeoutMs = Number(config.controlLeaseRenewalTimeoutMs) || 10_000;

fs.mkdirSync(stateDir, { recursive: true });
const tokenPath = path.join(stateDir, 'local-api-token.txt');
const devicesPath = path.join(stateDir, 'devices.json');
const pendingPath = path.join(stateDir, 'pending-enrollment.json');
const selectionPath = path.join(stateDir, 'device-selection.json');
if (!fs.existsSync(tokenPath)) {
  fs.writeFileSync(tokenPath, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
}
const apiToken = fs.readFileSync(tokenPath, 'utf8').trim();

let devices = readJson(devicesPath, {}, true);
let pendingEnrollment = readJson(pendingPath, {});
const selection = readJson(selectionPath, {}, true);
let selectedDeviceId = selection.deviceId || null;
const ownerSelections = new Map(Object.entries(selection.owners || {}));
for (const [owner, deviceId] of ownerSelections) {
  if (normalizedOwner(owner) !== owner || !/^[a-f0-9]{32}$/.test(deviceId)) throw new Error('invalid-device-selection');
}
if (fs.existsSync(selectionPath) && !/^[a-f0-9]{32}$/.test(selectedDeviceId || '')) {
  throw new Error('invalid-device-selection');
}
const connections = new Map();
const controlLeases = new Map();
const controlOperations = new Map();
const pendingCommands = new Map();

prunePendingEnrollments();

function readJson(file, fallback, failIfCorrupt = false) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (failIfCorrupt && fs.existsSync(file)) throw error;
    return fallback;
  }
}

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function prunePendingEnrollments() {
  const cutoff = Date.now() - pendingEnrollmentTtlMs;
  const retained = Object.entries(pendingEnrollment)
    .filter(([, candidate]) => Date.parse(candidate?.firstSeenAt || '') >= cutoff)
    .sort((left, right) => Date.parse(left[1].firstSeenAt) - Date.parse(right[1].firstSeenAt))
    .slice(-maxPendingEnrollments);
  pendingEnrollment = Object.fromEntries(retained);
}

function log(message) {
  try {
    if (fs.statSync(logPath).size > 5 * 1024 * 1024) {
      const previous = `${logPath}.1`;
      if (fs.existsSync(previous)) fs.rmSync(previous);
      fs.renameSync(logPath, previous);
    }
  } catch {}
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}

function safeEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizedOwner(value) {
  const owner = String(value || '').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 128);
  return owner.length >= 3 ? owner : null;
}

function serializeControl(deviceId, operation) {
  const previous = controlOperations.get(deviceId) || Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.catch(() => {});
  controlOperations.set(deviceId, settled);
  settled.finally(() => {
    if (controlOperations.get(deviceId) === settled) controlOperations.delete(deviceId);
  });
  return current;
}

function selectedForOwner(owner) {
  return ownerSelections.get(normalizedOwner(owner)) || selectedDeviceId;
}

function persistSelection() {
  writeJson(selectionPath, { deviceId: selectedDeviceId, owners: Object.fromEntries(ownerSelections) });
}

function targetDevice(body) {
  return body.deviceId || selectedForOwner(body.owner);
}

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (!body.length || body.length > maxFrameBytes) throw new Error('frame-size');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function sendFrame(socket, value) {
  socket.write(encodeFrame(value));
}

function attachFrameReader(socket, onFrame, maximumFrameBytes = () => maxFrameBytes) {
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size = buffered.readUInt32BE(0);
      if (!size || size > maximumFrameBytes()) {
        socket.destroy(new Error('invalid-frame-size'));
        return;
      }
      if (buffered.length < size + 4) return;
      const body = buffered.subarray(4, size + 4);
      buffered = buffered.subarray(size + 4);
      let value;
      try {
        value = JSON.parse(body.toString('utf8'));
      } catch {
        socket.destroy(new Error('invalid-json'));
        return;
      }
      onFrame(value);
    }
  });
}

function publicKeyFor(encoded) {
  return crypto.createPublicKey({
    key: Buffer.from(encoded, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function expectedDeviceId(encoded) {
  return crypto.createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex').slice(0, 32);
}

function rejectSession(socket, reason) {
  try { sendFrame(socket, { type: 'auth_rejected', reason }); } catch {}
  socket.end();
}

const ingress = net.createServer((socket) => {
  socket.setKeepAlive(true, 15_000);
  socket.setNoDelay(true);
  socket.setTimeout(10_000);
  const nonce = crypto.randomBytes(32).toString('base64url');
  const issuedAt = Date.now();
  let authenticated = false;
  let deviceId = null;
  sendFrame(socket, { type: 'challenge', nonce, issuedAt });

  attachFrameReader(socket, (frame) => {
    if (!authenticated) {
      if (frame.type !== 'auth' || frame.version !== 1) return rejectSession(socket, 'invalid-auth-frame');
      deviceId = String(frame.deviceId || '');
      const publicKey = String(frame.publicKey || '');
      const clientNonce = String(frame.clientNonce || '');
      const signature = String(frame.signature || '');
      if (publicKey.length < 80 || publicKey.length > 2048
          || clientNonce.length < 16 || clientNonce.length > 128
          || signature.length < 80 || signature.length > 1024) {
        return rejectSession(socket, 'invalid-auth-size');
      }
      if (!/^[a-f0-9]{32}$/.test(deviceId) || expectedDeviceId(publicKey) !== deviceId) {
        return rejectSession(socket, 'device-id-mismatch');
      }
      const canonical = `companion-v1\n${deviceId}\n${nonce}\n${clientNonce}\n${issuedAt}`;
      let signatureValid = false;
      try {
        signatureValid = crypto.verify(
          'sha256',
          Buffer.from(canonical, 'utf8'),
          publicKeyFor(publicKey),
          Buffer.from(signature, 'base64'));
      } catch {}
      if (!signatureValid) return rejectSession(socket, 'signature-invalid');

      const enrolled = devices[deviceId];
      if (!enrolled) {
        prunePendingEnrollments();
        const existing = pendingEnrollment[deviceId];
        if (existing && !safeEqual(existing.publicKey, publicKey)) {
          return rejectSession(socket, 'pending-key-mismatch');
        }
        if (!existing && Object.keys(pendingEnrollment).length >= maxPendingEnrollments) {
          return rejectSession(socket, 'enrollment-capacity');
        }
        if (!existing) {
          pendingEnrollment[deviceId] = { publicKey, firstSeenAt: new Date().toISOString() };
          writeJson(pendingPath, pendingEnrollment);
          log(`enrollment pending device=${deviceId}`);
        }
        sendFrame(socket, { type: 'enrollment_required' });
        socket.end();
        return;
      }
      if (!safeEqual(enrolled.publicKey, publicKey)) return rejectSession(socket, 'registered-key-mismatch');

      authenticated = true;
      socket.setTimeout(45_000);
      const previous = connections.get(deviceId);
      if (previous) {
        stopControlLease(deviceId, false, 'device-reconnected');
        previous.socket.destroy();
      }
      const connection = {
        socket,
        deviceId,
        sequence: 0,
        connectedAt: new Date().toISOString(),
        lastPongAt: Date.now(),
        keyguardLocked: null,
        accessibilityReady: null,
        versionCode: null,
        versionName: null,
      };
      connections.set(deviceId, connection);
      if (!selectedDeviceId) {
        selectedDeviceId = deviceId;
        persistSelection();
      }
      sendFrame(socket, { type: 'auth_ok', sessionId: crypto.randomUUID() });
      sendFrame(socket, { type: 'ping', sentAt: Date.now() });
      log(`authenticated device connected device=${deviceId}`);
      return;
    }

    if (frame.type === 'pong') {
      const connection = connections.get(deviceId);
      if (connection?.socket === socket) {
        connection.lastPongAt = Date.now();
        if (typeof frame.keyguardLocked === 'boolean') connection.keyguardLocked = frame.keyguardLocked;
        for (const field of ['secureKeyguardLocked', 'screenInteractive', 'userUnlocked', 'supportsAtomicGuards']) {
          if (typeof frame[field] === 'boolean') connection[field] = frame[field];
        }
        if (typeof frame.accessibilityReady === 'boolean') connection.accessibilityReady = frame.accessibilityReady;
        if (Number.isSafeInteger(frame.versionCode) && frame.versionCode > 0) connection.versionCode = frame.versionCode;
        if (typeof frame.versionName === 'string' && frame.versionName.length <= 64) connection.versionName = frame.versionName;
      }
      return;
    }
    if (frame.type !== 'response') return;
    const request = pendingCommands.get(frame.requestId);
    if (!request || request.socket !== socket || request.seq !== frame.seq) return;
    pendingCommands.delete(frame.requestId);
    clearTimeout(request.timer);
    const elapsedMs = Date.now() - request.sentAt;
    if (request.command.startsWith('adb_tunnel_') && elapsedMs >= 1000) {
      log(`slow ADB operation device=${deviceId} command=${request.command} elapsedMs=${elapsedMs}`);
    }
    request.resolve(frame);
  }, () => authenticated ? maxFrameBytes : maxAuthenticationFrameBytes);

  socket.on('timeout', () => socket.destroy(new Error('socket-timeout')));
  socket.on('close', () => {
    if (connections.get(deviceId)?.socket === socket) {
      connections.delete(deviceId);
      stopControlLease(deviceId, false, 'device-disconnected');
    }
    for (const [requestId, request] of pendingCommands) {
      if (request.socket !== socket) continue;
      clearTimeout(request.timer);
      request.reject(new Error('device-disconnected'));
      pendingCommands.delete(requestId);
    }
    log(`authenticated device disconnected device=${deviceId || 'unknown'}`);
  });
  socket.on('error', (error) => log(`ingress socket error=${error.code || error.name}`));
});
ingress.maxConnections = 16;

setInterval(() => {
  for (const connection of connections.values()) {
    if (connection.socket.destroyed) continue;
    const busy = [...pendingCommands.values()].some((item) => item.socket === connection.socket);
    const heartbeatTimeoutMs = busy ? 130_000 : 40_000;
    if (Date.now() - connection.lastPongAt > heartbeatTimeoutMs) {
      connection.socket.destroy(new Error('heartbeat-timeout'));
      continue;
    }
    sendFrame(connection.socket, { type: 'ping', sentAt: Date.now() });
  }
}, 10_000).unref();

function authenticateApi(request) {
  return safeEqual(request.headers['x-companion-token'], apiToken);
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxApiBodyBytes) {
        reject(new Error('request-too-large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('invalid-json')); }
    });
    request.on('error', reject);
  });
}

function invokeCommand(deviceId, command, args, timeoutMs) {
  const target = connections.get(deviceId);
  if (!target || target.socket.destroyed) return Promise.reject(new Error('device-not-connected'));
  const requestId = crypto.randomUUID();
  const seq = ++target.sequence;
  const sentAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(requestId);
      log(`command timeout device=${deviceId} command=${command} elapsedMs=${Date.now() - sentAt}`);
      reject(new Error('command-timeout'));
    }, Math.max(1_000, Math.min(Number(timeoutMs) || 20_000, 120_000)));
    pendingCommands.set(requestId, { deviceId, seq, command, sentAt, socket: target.socket, resolve, reject, timer });
    sendFrame(target.socket, { type: 'command', requestId, seq, command, args: args || {} });
  });
}

async function startControlLease(deviceId, requestedMillis, requestedOwner, force = false, displayOnly = false, background = false) {
  const owner = normalizedOwner(requestedOwner);
  if (!owner) return { ok: false, error: 'control-owner-required' };
  const durationMillis = Math.max(60_000, Math.min(Number(requestedMillis) || 60 * 60_000, 8 * 60 * 60_000));
  const controlLease = controlLeases.get(deviceId);
  if (controlLease && controlLease.expiresAt > Date.now() && controlLease.owner !== owner && !force) {
    return {
      ok: false,
      error: 'control-owned-by-another-session',
      owner: controlLease.owner,
      expiresAt: new Date(controlLease.expiresAt).toISOString(),
    };
  }
  const target = connections.get(deviceId);
  // Ownership does not require a display wake. A ping works even at the secure
  // keyguard and on older Companions, without changing their screen state.
  const first = await invokeCommand(deviceId, background ? 'ping' : displayOnly ? 'wake' : 'lease',
    background ? {} : { leaseMillis: displayLeaseMillis }, displayRenewalTimeoutMs);
  if (!first.ok) return first;
  if (connections.get(deviceId) !== target || target.socket.destroyed) return { ok: false, error: 'device-disconnected' };
  if (background && controlLease && !controlLease.background) {
    const released = await invokeCommand(deviceId, 'release_lease', {}, displayRenewalTimeoutMs);
    if (!released.ok) return released;
  }
  stopControlLease(deviceId, false, 'replaced');
  const expiresAt = Date.now() + durationMillis;
  const lease = { expiresAt, timer: null, owner, deviceId, background };
  controlLeases.set(deviceId, lease);
  scheduleControlLeaseRenewal(lease, background ? durationMillis : displayRenewalIntervalMs);
  log(`control lease started owner=${owner} durationMs=${durationMillis}`);
  return { ok: true, result: { expiresAt: new Date(expiresAt).toISOString(), durationMillis, owner, deviceId, background } };
}

function scheduleControlLeaseRenewal(lease, requestedDelayMs) {
  if (controlLeases.get(lease.deviceId) !== lease) return;
  const remainingMillis = lease.expiresAt - Date.now();
  if (remainingMillis <= 0) {
    stopControlLease(lease.deviceId, true, 'expired');
    return;
  }
  const delayMillis = Math.max(10, Math.min(requestedDelayMs, remainingMillis));
  lease.timer = setTimeout(() => serializeControl(lease.deviceId, () => renewControlLease(lease)).catch(error => log(`control renewal error=${error.message}`)), delayMillis);
  lease.timer.unref();
}

async function renewControlLease(lease) {
  if (controlLeases.get(lease.deviceId) !== lease) return;
  if (lease.expiresAt <= Date.now()) {
    await stopControlLease(lease.deviceId, true, 'expired');
    return;
  }
  if (lease.background) {
    scheduleControlLeaseRenewal(lease, lease.expiresAt - Date.now());
    return;
  }
  try {
    const renewed = await invokeCommand(
      lease.deviceId, 'lease', { leaseMillis: displayLeaseMillis }, displayRenewalTimeoutMs);
    if (controlLeases.get(lease.deviceId) !== lease) return;
    if (!renewed.ok) {
      await stopControlLease(lease.deviceId, true, 'renewal-rejected');
      return;
    }
    scheduleControlLeaseRenewal(lease, displayRenewalIntervalMs);
  } catch (error) {
    if (controlLeases.get(lease.deviceId) !== lease) return;
    const target = connections.get(lease.deviceId);
    if (!target || target.socket.destroyed) {
      stopControlLease(lease.deviceId, false, 'device-disconnected');
      return;
    }
    log(`control lease renewal retry error=${error.code || error.message || error.name}`);
    scheduleControlLeaseRenewal(lease, displayRenewalRetryMs);
  }
}

function stopControlLease(deviceId, releaseDevice, reason) {
  const previous = controlLeases.get(deviceId);
  if (previous?.timer) clearTimeout(previous.timer);
  controlLeases.delete(deviceId);
  for (const record of tvTunnels.values()) {
    if (record.deviceId === deviceId) record.tunnel.close();
  }
  if (previous) log(`control lease stopped device=${deviceId} reason=${reason}`);
  if (releaseDevice && previous && !previous.background && connections.has(deviceId)) {
    return invokeCommand(deviceId, 'release_lease', {}, 10_000).catch(() => {});
  }
}

function ownerControlsDevice(deviceId, owner) {
  const lease = controlLeases.get(deviceId);
  return lease && lease.expiresAt > Date.now() && lease.owner === normalizedOwner(owner);
}

// Reject another controller before joining a possibly long file-transfer queue.
// The check inside that queue remains authoritative for acquisition races.
function rejectConflictingOwner(deviceId, owner, response, force = false) {
  const lease = controlLeases.get(deviceId);
  if (!force && lease && lease.expiresAt > Date.now() && lease.owner !== normalizedOwner(owner)) {
    sendJson(response, 409, { ok: false, error: 'control-owned-by-another-session',
      owner: lease.owner, expiresAt: leaseStatus(lease).expiresAt });
    return true;
  }
  return false;
}

function leaseStatus(lease) {
  return lease ? { expiresAt: new Date(lease.expiresAt).toISOString(), owner: lease.owner,
    deviceId: lease.deviceId, background: lease.background === true } : null;
}

function connectionStatus(connection) {
  return {
    deviceId: connection.deviceId,
    connectedAt: connection.connectedAt,
    lastPongAt: new Date(connection.lastPongAt).toISOString(),
    keyguardLocked: connection.keyguardLocked,
    secureKeyguardLocked: connection.secureKeyguardLocked ?? null,
    screenInteractive: connection.screenInteractive ?? null,
    userUnlocked: connection.userUnlocked ?? null,
    supportsAtomicGuards: connection.supportsAtomicGuards ?? false,
    accessibilityReady: connection.accessibilityReady,
    versionCode: connection.versionCode,
    versionName: connection.versionName,
  };
}

const api = http.createServer(async (request, response) => {
  if (!authenticateApi(request)) return sendJson(response, 401, { ok: false, error: 'unauthorized' });
  try {
    if (request.method === 'GET' && request.url === '/health') {
      return sendJson(response, 200, { ok: true, connected: [...connections.values()].some(item => !item.socket.destroyed) });
    }
    if (request.method === 'GET' && request.url === '/status') {
      prunePendingEnrollments();
      const owner = request.headers['x-companion-owner'];
      const requestedDevice = request.headers['x-companion-device'];
      const deviceId = requestedDevice || selectedForOwner(owner);
      const active = connections.get(deviceId);
      const connected = Boolean(active && !active.socket.destroyed);
      return sendJson(response, 200, {
        ok: true,
        selectedDeviceId: deviceId,
        connectedDevices: [...connections.values()].filter(item => !item.socket.destroyed).map(connectionStatus),
        active: connected ? connectionStatus(active) : null,
        controlLease: leaseStatus(controlLeases.get(deviceId)),
        controlLeases: [...controlLeases.values()].map(leaseStatus),
        enrolledDevices: Object.keys(devices),
        pendingDevices: Object.keys(pendingEnrollment),
      });
    }
    if (request.method === 'POST' && request.url === '/select') {
      const body = await readBody(request);
      const owner = normalizedOwner(body.owner);
      if (!owner) return sendJson(response, 400, { ok: false, error: 'control-owner-required' });
      const previousDevice = selectedForOwner(owner);
      return await serializeControl(previousDevice, async () => {
        const deviceId = String(body.deviceId || '');
        if (!devices[deviceId]) return sendJson(response, 404, { ok: false, error: 'device-not-enrolled' });
        const ownLease = controlLeases.get(previousDevice);
        if (deviceId !== previousDevice && ownLease?.owner === owner) {
          return sendJson(response, 409, { ok: false, error: 'stop-session-before-device-selection', owner });
        }
        ownerSelections.set(owner, deviceId);
        persistSelection();
        const target = connections.get(deviceId);
        return sendJson(response, 200, { ok: true, deviceId, owner, connected: Boolean(target && !target.socket.destroyed) });
      });
    }
    if (request.method === 'POST' && request.url === '/enroll') {
      const body = await readBody(request);
      const deviceId = String(body.deviceId || '');
      prunePendingEnrollments();
      const candidate = pendingEnrollment[deviceId];
      if (!candidate) return sendJson(response, 404, { ok: false, error: 'pending-device-not-found' });
      devices[deviceId] = { publicKey: candidate.publicKey, enrolledAt: new Date().toISOString() };
      delete pendingEnrollment[deviceId];
      writeJson(devicesPath, devices);
      writeJson(pendingPath, pendingEnrollment);
      log(`device enrolled device=${deviceId}`);
      return sendJson(response, 200, { ok: true, deviceId });
    }
    if (request.method === 'POST' && request.url === '/command') {
      const body = await readBody(request);
      const deviceId = targetDevice(body);
      if (!devices[deviceId]) return sendJson(response, 404, { ok: false, error: 'device-not-enrolled' });
      if (typeof body.command !== 'string') return sendJson(response, 400, { ok: false, error: 'command-required' });
      if (rejectConflictingOwner(deviceId, body.owner, response)) return;
      return await serializeControl(deviceId, async () => {
        if (response.destroyed) return;
        if (!ownerControlsDevice(deviceId, body.owner)) {
          const lease = controlLeases.get(deviceId);
          return sendJson(response, 409, {
            ok: false, error: lease ? 'control-owned-by-another-session' : 'control-lease-required',
            dispatchState: 'not-started',
            owner: lease?.owner || null, expiresAt: leaseStatus(lease)?.expiresAt || null,
          });
        }
        // Direct API clients also upgrade before UI commands. The failed upgrade
        // leaves background ownership intact, so a locked screen cannot stop ADB.
        const lease = controlLeases.get(deviceId);
        if (lease.background && !['adb', 'adb_pair', 'adb_bind', 'diagnostics', 'ping',
          'release_lease', 'adb_tunnel_status', 'tv_remote_status',
          'tv_remote_pair_start', 'tv_remote_pair_finish', 'tv_remote_press',
          'tv_remote_tunnel_open', 'tv_remote_tunnel_close',
          'install_begin', 'install_chunk',
          'install_commit', 'install_status'].includes(body.command)) {
          const upgraded = await startControlLease(deviceId, lease.expiresAt - Date.now(), body.owner,
            false, body.command === 'wake');
          if (!upgraded.ok) return sendJson(response, 409, upgraded);
        }
        const result = body.command === 'adb'
          ? await executeDeviceAdb(deviceId, body.owner, body.args || {}, () =>
            !response.destroyed && ownerControlsDevice(deviceId, body.owner) && Boolean(connections.get(deviceId)?.socket
              && !connections.get(deviceId).socket.destroyed))
          : body.command === 'adb_pair'
          ? await pairDeviceAdb(deviceId, body.owner, body.args || {}, () =>
            !response.destroyed && ownerControlsDevice(deviceId, body.owner) && Boolean(connections.get(deviceId)?.socket
              && !connections.get(deviceId).socket.destroyed))
          : body.command === 'adb_bind'
          ? { ok: true, result: await bindDeviceAdb(deviceId, body.owner, () =>
            !response.destroyed && ownerControlsDevice(deviceId, body.owner) && Boolean(connections.get(deviceId)?.socket
              && !connections.get(deviceId).socket.destroyed)) }
          : body.command === 'system_input'
          ? await executeSystemInput(deviceId, body.owner, body.args)
          : body.command === 'tv_remote_tunnel_open'
          ? { ok: true, result: await openTvRemoteTunnel(deviceId, body.owner, body.args) }
          : body.command === 'tv_remote_tunnel_close'
          ? { ok: true, result: closeTvRemoteTunnel(deviceId, body.owner, body.args) }
          : await invokeCommand(deviceId, body.command, body.args, body.timeoutMs);
        const tunnel = adbTunnels.get(deviceId);
        if (tunnel?.owner === body.owner) {
          if (body.command === 'adb_tunnel_status' && result.ok) result.result.pcTunnel = {
            closed: tunnel.closed, lastError: tunnel.lastError, statistics: tunnel.statistics,
          };
          if (body.command === 'adb' && !result.ok && tunnel.lastError) {
            result.result.tunnelError = tunnel.lastError;
            result.result.tunnelStatistics = tunnel.statistics;
          }
        }
        // ADB command failures carry their real exit code/stdout/stderr to the CLI.
        return sendJson(response, ['adb', 'adb_pair'].includes(body.command) || result.ok ? 200 : 409, result);
      });
    }
    if (request.method === 'POST' && request.url === '/control/start') {
      const body = await readBody(request);
      const deviceId = targetDevice(body);
      if (!devices[deviceId]) return sendJson(response, 404, { ok: false, error: 'device-not-enrolled' });
      if (rejectConflictingOwner(deviceId, body.owner, response, body.force === true)) return;
      return await serializeControl(deviceId, async () => {
        if (response.destroyed) return;
        const result = await startControlLease(deviceId, body.durationMillis, body.owner, body.force === true,
          body.displayOnly === true, body.background === true);
        return sendJson(response, result.ok ? 200 : 409, result);
      });
    }
    if (request.method === 'POST' && request.url === '/control/stop') {
      const body = await readBody(request);
      const deviceId = targetDevice(body);
      const owner = normalizedOwner(body.owner);
      if (!owner) return sendJson(response, 400, { ok: false, error: 'control-owner-required' });
      if (rejectConflictingOwner(deviceId, owner, response, body.force === true)) return;
      return await serializeControl(deviceId, async () => {
        const lease = controlLeases.get(deviceId);
        if (lease && lease.owner !== owner && body.force !== true) {
          return sendJson(response, 409, {
            ok: false, error: 'control-owned-by-another-session',
            owner: lease.owner, expiresAt: leaseStatus(lease).expiresAt,
          });
        }
        stopControlLease(deviceId, false, `local-request owner=${owner}`);
        let result = { ok: true, result: { released: Boolean(lease), displayReleased: false } };
        const target = connections.get(deviceId);
        if (lease && !lease.background && target && !target.socket.destroyed) {
          result = await invokeCommand(deviceId, 'release_lease', {}, 10_000);
        }
        return sendJson(response, result.ok ? 200 : 409, result);
      });
    }
    return sendJson(response, 404, { ok: false, error: 'not-found' });
  } catch (error) {
    const status = error.message === 'device-not-connected' ? 503
      : /^(system-input-|adb-)/.test(error.message) ? 409 : 500;
    return sendJson(response, status, { ok: false, error: error.message || error.name,
      ...(error.dispatchState ? { dispatchState: error.dispatchState } : {}) });
  }
});

ingress.listen(ingressPort, '127.0.0.1', () => log(`companion ingress listening on 127.0.0.1:${ingressPort}`));
api.listen(apiPort, '127.0.0.1', () => log(`companion API listening on 127.0.0.1:${apiPort}`));
