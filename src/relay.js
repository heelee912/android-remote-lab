'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { loadConfig } = require('./config.js');

if (process.argv[2]) process.env.ANDROID_REMOTE_LAB_CONFIG = process.argv[2];
const config = loadConfig();
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
let active = null;
let selectedDeviceId = readJson(selectionPath, {}, true).deviceId || null;
if (fs.existsSync(selectionPath) && !/^[a-f0-9]{32}$/.test(selectedDeviceId || '')) {
  throw new Error('invalid-device-selection');
}
const connections = new Map();
let controlLease = null;
let controlOperation = Promise.resolve();
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

function serializeControl(operation) {
  const current = controlOperation.then(operation, operation);
  controlOperation = current.catch(() => {});
  return current;
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
        if (active === previous) stopControlLease(false, 'device-reconnected');
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
        writeJson(selectionPath, { deviceId });
      }
      if (selectedDeviceId === deviceId) active = connection;
      sendFrame(socket, { type: 'auth_ok', sessionId: crypto.randomUUID() });
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
    request.resolve(frame);
  }, () => authenticated ? maxFrameBytes : maxAuthenticationFrameBytes);

  socket.on('timeout', () => socket.destroy(new Error('socket-timeout')));
  socket.on('close', () => {
    if (connections.get(deviceId)?.socket === socket) connections.delete(deviceId);
    if (active && active.socket === socket) {
      active = null;
      stopControlLease(false, 'device-disconnected');
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

function invokeCommand(command, args, timeoutMs) {
  if (!active || active.socket.destroyed) return Promise.reject(new Error('device-not-connected'));
  const requestId = crypto.randomUUID();
  const target = active;
  const seq = ++target.sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(requestId);
      reject(new Error('command-timeout'));
    }, Math.max(1_000, Math.min(Number(timeoutMs) || 20_000, 120_000)));
    pendingCommands.set(requestId, { seq, socket: target.socket, resolve, reject, timer });
    sendFrame(target.socket, { type: 'command', requestId, seq, command, args: args || {} });
  });
}

async function startControlLease(requestedMillis, requestedOwner, force = false, displayOnly = false) {
  const owner = normalizedOwner(requestedOwner);
  if (!owner) return { ok: false, error: 'control-owner-required' };
  const durationMillis = Math.max(60_000, Math.min(Number(requestedMillis) || 60 * 60_000, 8 * 60 * 60_000));
  if (controlLease && controlLease.expiresAt > Date.now() && controlLease.owner !== owner && !force) {
    return {
      ok: false,
      error: 'control-owned-by-another-session',
      owner: controlLease.owner,
      expiresAt: new Date(controlLease.expiresAt).toISOString(),
    };
  }
  const target = active;
  const first = await invokeCommand(displayOnly ? 'wake' : 'lease', { leaseMillis: displayLeaseMillis }, displayRenewalTimeoutMs);
  if (!first.ok) return first;
  if (active !== target || target.socket.destroyed) return { ok: false, error: 'device-disconnected' };
  stopControlLease(false, 'replaced');
  const expiresAt = Date.now() + durationMillis;
  controlLease = { expiresAt, timer: null, owner, deviceId: active.deviceId };
  scheduleControlLeaseRenewal(controlLease, displayRenewalIntervalMs);
  log(`control lease started owner=${owner} durationMs=${durationMillis}`);
  return { ok: true, result: { expiresAt: new Date(expiresAt).toISOString(), durationMillis, owner, deviceId: active.deviceId } };
}

function scheduleControlLeaseRenewal(lease, requestedDelayMs) {
  if (controlLease !== lease) return;
  const remainingMillis = lease.expiresAt - Date.now();
  if (remainingMillis <= 0) {
    stopControlLease(true, 'expired');
    return;
  }
  const delayMillis = Math.max(10, Math.min(requestedDelayMs, remainingMillis));
  lease.timer = setTimeout(() => renewControlLease(lease), delayMillis);
  lease.timer.unref();
}

async function renewControlLease(lease) {
  if (controlLease !== lease) return;
  if (lease.expiresAt <= Date.now()) {
    stopControlLease(true, 'expired');
    return;
  }
  try {
    const renewed = await invokeCommand(
      'lease', { leaseMillis: displayLeaseMillis }, displayRenewalTimeoutMs);
    if (controlLease !== lease) return;
    if (!renewed.ok) {
      stopControlLease(true, 'renewal-rejected');
      return;
    }
    scheduleControlLeaseRenewal(lease, displayRenewalIntervalMs);
  } catch (error) {
    if (controlLease !== lease) return;
    if (!active || active.socket.destroyed) {
      stopControlLease(false, 'device-disconnected');
      return;
    }
    log(`control lease renewal retry error=${error.code || error.message || error.name}`);
    scheduleControlLeaseRenewal(lease, displayRenewalRetryMs);
  }
}

function stopControlLease(releaseDevice, reason) {
  const previous = controlLease;
  if (previous?.timer) clearTimeout(previous.timer);
  controlLease = null;
  if (previous) log(`control lease stopped reason=${reason}`);
  if (releaseDevice && active && !active.socket.destroyed) {
    invokeCommand('release_lease', {}, 10_000).catch(() => {});
  }
}

function ownerControlsDevice(owner) {
  return controlLease
    && controlLease.expiresAt > Date.now()
    && controlLease.owner === normalizedOwner(owner);
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

function targetMatches(body) {
  return !body.deviceId || body.deviceId === selectedDeviceId;
}

const api = http.createServer(async (request, response) => {
  if (!authenticateApi(request)) return sendJson(response, 401, { ok: false, error: 'unauthorized' });
  try {
    if (request.method === 'GET' && request.url === '/health') {
      return sendJson(response, 200, { ok: true, connected: Boolean(active && !active.socket.destroyed) });
    }
    if (request.method === 'GET' && request.url === '/status') {
      prunePendingEnrollments();
      const connected = Boolean(active && !active.socket.destroyed);
      return sendJson(response, 200, {
        ok: true,
        selectedDeviceId,
        connectedDevices: [...connections.values()].filter((item) => !item.socket.destroyed).map(connectionStatus),
        active: connected ? {
          deviceId: active.deviceId,
          connectedAt: active.connectedAt,
          lastPongAt: new Date(active.lastPongAt).toISOString(),
          keyguardLocked: active.keyguardLocked,
          secureKeyguardLocked: active.secureKeyguardLocked ?? null,
          screenInteractive: active.screenInteractive ?? null,
          userUnlocked: active.userUnlocked ?? null,
          supportsAtomicGuards: active.supportsAtomicGuards ?? false,
          accessibilityReady: active.accessibilityReady,
          versionCode: active.versionCode,
          versionName: active.versionName,
        } : null,
        controlLease: controlLease ? {
          expiresAt: new Date(controlLease.expiresAt).toISOString(),
          owner: controlLease.owner,
          deviceId: controlLease.deviceId,
        } : null,
        enrolledDevices: Object.keys(devices),
        pendingDevices: Object.keys(pendingEnrollment),
      });
    }
    if (request.method === 'POST' && request.url === '/select') {
      const body = await readBody(request);
      return await serializeControl(async () => {
        const deviceId = String(body.deviceId || '');
        if (!devices[deviceId]) return sendJson(response, 404, { ok: false, error: 'device-not-enrolled' });
        if (controlLease || pendingCommands.size) {
          return sendJson(response, 409, { ok: false, error: 'stop-session-before-device-selection', owner: controlLease?.owner });
        }
        writeJson(selectionPath, { deviceId });
        selectedDeviceId = deviceId;
        active = connections.get(deviceId) || null;
        return sendJson(response, 200, { ok: true, deviceId, connected: Boolean(active && !active.socket.destroyed) });
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
      if (!targetMatches(body)) return sendJson(response, 409, { ok: false, error: 'selected-device-changed' });
      if (typeof body.command !== 'string') return sendJson(response, 400, { ok: false, error: 'command-required' });
      if (!ownerControlsDevice(body.owner)) {
        return sendJson(response, 409, {
          ok: false,
          error: controlLease ? 'control-owned-by-another-session' : 'control-lease-required',
          owner: controlLease?.owner || null,
          expiresAt: controlLease ? new Date(controlLease.expiresAt).toISOString() : null,
        });
      }
      const result = await invokeCommand(body.command, body.args, body.timeoutMs);
      return sendJson(response, result.ok ? 200 : 409, result);
    }
    if (request.method === 'POST' && request.url === '/control/start') {
      const body = await readBody(request);
      return await serializeControl(async () => {
        if (!targetMatches(body)) return sendJson(response, 409, { ok: false, error: 'selected-device-changed' });
        const result = await startControlLease(body.durationMillis, body.owner, body.force === true, body.displayOnly === true);
        return sendJson(response, result.ok ? 200 : 409, result);
      });
    }
    if (request.method === 'POST' && request.url === '/control/stop') {
      const body = await readBody(request);
      return await serializeControl(async () => {
        if (!targetMatches(body)) return sendJson(response, 409, { ok: false, error: 'selected-device-changed' });
        const owner = normalizedOwner(body.owner);
        if (controlLease && controlLease.owner !== owner && body.force !== true) {
          return sendJson(response, 409, {
            ok: false,
            error: 'control-owned-by-another-session',
            owner: controlLease.owner,
            expiresAt: new Date(controlLease.expiresAt).toISOString(),
          });
        }
        stopControlLease(false, `local-request owner=${owner || 'force'}`);
        let result = { ok: true, result: { released: false } };
        if (active && !active.socket.destroyed) {
          result = await invokeCommand('release_lease', {}, 10_000);
        }
        return sendJson(response, result.ok ? 200 : 409, result);
      });
    }
    return sendJson(response, 404, { ok: false, error: 'not-found' });
  } catch (error) {
    const status = error.message === 'device-not-connected' ? 503 : 500;
    return sendJson(response, status, { ok: false, error: error.message || error.name });
  }
});

ingress.listen(ingressPort, '127.0.0.1', () => log(`companion ingress listening on 127.0.0.1:${ingressPort}`));
api.listen(apiPort, '127.0.0.1', () => log(`companion API listening on 127.0.0.1:${apiPort}`));
