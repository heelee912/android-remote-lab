'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function reader(socket) {
  let buffered = Buffer.alloc(0);
  const waiting = [];
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size = buffered.readUInt32BE(0);
      if (buffered.length < size + 4) break;
      const value = JSON.parse(buffered.subarray(4, size + 4).toString('utf8'));
      buffered = buffered.subarray(size + 4);
      waiting.shift()?.resolve(value);
    }
  });
  socket.on('error', (error) => waiting.splice(0).forEach((item) => item.reject(error)));
  return () => new Promise((resolve, reject) => waiting.push({ resolve, reject }));
}

function request(port, token, method, route, body) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: route,
      headers: { 'x-companion-token': token, ...(encoded ? { 'content-length': encoded.length } : {}) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

function waitForClose(socket, timeoutMilliseconds = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMilliseconds);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function connectSocket(port) {
  let socket;
  for (let attempt = 0; attempt < 100; attempt++) {
    socket = net.connect(port, '127.0.0.1');
    try {
      await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
      break;
    } catch (error) {
      socket.destroy();
      if (attempt === 99) throw error;
      await delay(25);
    }
  }
  return socket;
}

async function connectAndAuthenticate(port, identity) {
  const socket = await connectSocket(port);
  const next = reader(socket);
  const challenge = await next();
  assert.equal(challenge.type, 'challenge');
  const clientNonce = crypto.randomBytes(16).toString('base64url');
  const canonical = `companion-v1\n${identity.deviceId}\n${challenge.nonce}\n${clientNonce}\n${challenge.issuedAt}`;
  const signature = crypto.sign('sha256', Buffer.from(canonical), identity.privateKey).toString('base64');
  const authFrame = {
    type: 'auth', version: 1, deviceId: identity.deviceId,
    publicKey: identity.publicKey, clientNonce, signature,
  };
  socket.write(frame(authFrame));
  return { socket, next, auth: await next(), authFrame };
}

async function main() {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-relay-test-'));
  const ingressPort = 17001 + Math.floor(Math.random() * 1000);
  const apiPort = ingressPort + 2000;
  const runtimeDir = path.join(__dirname, '..', 'src');
  const configPath = path.join(state, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    stateDir: state, runtimeDir, relayHost: 'relay.example.test',
    ingressPort, apiPort, publicPort: 10000, taskName: 'test',
  }));
  const relay = spawn(process.execPath, [path.join(runtimeDir, 'relay.js'), configPath], {
    stdio: 'ignore', windowsHide: true,
  });
  try {
    const tokenPath = path.join(state, 'local-api-token.txt');
    for (let attempt = 0; attempt < 100 && !fs.existsSync(tokenPath); attempt++) await delay(25);
    const token = fs.readFileSync(tokenPath, 'utf8').trim();

    const oversizedSocket = await connectSocket(ingressPort);
    const oversizedNext = reader(oversizedSocket);
    await oversizedNext();
    const oversizedHeader = Buffer.alloc(4);
    oversizedHeader.writeUInt32BE(8 * 1024 + 1);
    const oversizedClosed = waitForClose(oversizedSocket);
    oversizedSocket.write(oversizedHeader);
    await oversizedClosed;

    const malformedSocket = await connectSocket(ingressPort);
    const malformedNext = reader(malformedSocket);
    await malformedNext();
    malformedSocket.write(frame({
      type: 'auth', version: 1, deviceId: 'a'.repeat(32),
      publicKey: 'A'.repeat(3000), clientNonce: 'b'.repeat(32), signature: 'c'.repeat(100),
    }));
    const malformedResult = await malformedNext();
    assert.equal(malformedResult.type, 'auth_rejected');
    assert.equal(malformedResult.reason, 'invalid-auth-size');
    malformedSocket.destroy();

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicDer = publicKey.export({ type: 'spki', format: 'der' });
    const identity = {
      privateKey,
      publicKey: publicDer.toString('base64'),
      deviceId: crypto.createHash('sha256').update(publicDer).digest('hex').slice(0, 32),
    };

    const first = await connectAndAuthenticate(ingressPort, identity);
    assert.equal(first.auth.type, 'enrollment_required');
    first.socket.destroy();

    const replaySocket = await connectSocket(ingressPort);
    const replayNext = reader(replaySocket);
    await replayNext();
    replaySocket.write(frame(first.authFrame));
    const replayResult = await replayNext();
    assert.equal(replayResult.type, 'auth_rejected');
    assert.equal(replayResult.reason, 'signature-invalid');
    replaySocket.destroy();

    const unauthorized = await request(apiPort, 'wrong-token', 'GET', '/status');
    assert.equal(unauthorized.status, 401);
    const pending = await request(apiPort, token, 'GET', '/status');
    assert.deepEqual(pending.body.pendingDevices, [identity.deviceId]);
    const enrolled = await request(apiPort, token, 'POST', '/enroll', { deviceId: identity.deviceId });
    assert.equal(enrolled.status, 200);

    const second = await connectAndAuthenticate(ingressPort, identity);
    assert.equal(second.auth.type, 'auth_ok');
    second.socket.write(frame({
      type: 'pong', sentAt: Date.now(), keyguardLocked: false, accessibilityReady: true,
      versionCode: 7, versionName: '1.1.1', screenInteractive: false, secureKeyguardLocked: false, userUnlocked: true,
    }));
    await delay(50);
    const deviceReadiness = await request(apiPort, token, 'GET', '/status');
    assert.equal(deviceReadiness.body.active.keyguardLocked, false);
    assert.equal(deviceReadiness.body.active.accessibilityReady, true);
    assert.equal(deviceReadiness.body.active.versionCode, 7);
    assert.equal(deviceReadiness.body.active.screenInteractive, false);
    assert.equal(deviceReadiness.body.active.secureKeyguardLocked, false);
    assert.equal(deviceReadiness.body.active.userUnlocked, true);
    assert.equal(deviceReadiness.body.active.versionName, '1.1.1');
    const owner = 'test-thread';
    const startLeasePromise = request(apiPort, token, 'POST', '/control/start', {
      durationMillis: 120_000, owner,
    });
    const leaseCommand = await second.next();
    assert.equal(leaseCommand.command, 'lease');
    second.socket.write(frame({
      type: 'response', requestId: leaseCommand.requestId, seq: leaseCommand.seq,
      ok: true, result: { leaseMillis: 90_000 },
    }));
    const startedLease = await startLeasePromise;
    assert.equal(startedLease.status, 200);
    assert.equal(startedLease.body.result.owner, owner);

    const blockedOwner = await request(apiPort, token, 'POST', '/control/start', {
      durationMillis: 120_000, owner: 'different-thread',
    });
    assert.equal(blockedOwner.status, 409);
    assert.equal(blockedOwner.body.error, 'control-owned-by-another-session');

    const encodedChunk = Buffer.alloc(512 * 1024, 0x5a).toString('base64');
    const largeCommandPromise = request(apiPort, token, 'POST', '/command', {
      command: 'install_chunk',
      args: { uploadId: 'a'.repeat(64), offset: 0, base64: encodedChunk, chunkSha256: 'b'.repeat(64) },
      owner,
    });
    const largeCommand = await second.next();
    assert.equal(largeCommand.command, 'install_chunk');
    assert.equal(largeCommand.args.base64.length, encodedChunk.length);
    second.socket.write(frame({
      type: 'response', requestId: largeCommand.requestId, seq: largeCommand.seq,
      ok: true, result: { receivedBytes: 512 * 1024 },
    }));
    const largeResponse = await largeCommandPromise;
    assert.equal(largeResponse.status, 200);

    const commandPromise = request(apiPort, token, 'POST', '/command', {
      command: 'status', args: {}, owner,
    });
    const command = await second.next();
    assert.equal(command.type, 'command');
    assert.equal(command.seq, 3);
    second.socket.write(frame({
      type: 'response', requestId: command.requestId, seq: command.seq,
      ok: true, result: { connected: true },
    }));
    const response = await commandPromise;
    assert.equal(response.status, 200);
    assert.equal(response.body.result.connected, true);

    const failedActionPromise = request(apiPort, token, 'POST', '/command', {
      command: 'click', args: { selector: { text: 'missing' } }, owner,
    });
    const failedAction = await second.next();
    second.socket.write(frame({
      type: 'response', requestId: failedAction.requestId, seq: failedAction.seq,
      ok: false, error: { code: 'IllegalStateException', message: 'Click was not performed' },
    }));
    const failedActionResponse = await failedActionPromise;
    assert.equal(failedActionResponse.status, 409);
    assert.equal(failedActionResponse.body.error.message, 'Click was not performed');

    let sequenceRequestSettled = false;
    const sequencePromise = request(apiPort, token, 'POST', '/command', {
      command: 'status', args: {}, owner,
    })
      .then((value) => {
        sequenceRequestSettled = true;
        return value;
    });
    const sequenceCommand = await second.next();
    assert.equal(sequenceCommand.seq, 5);
    second.socket.write(frame({
      type: 'response', requestId: sequenceCommand.requestId, seq: 1,
      ok: true, result: { acceptedStaleSequence: true },
    }));
    await delay(100);
    assert.equal(sequenceRequestSettled, false);
    second.socket.write(frame({
      type: 'response', requestId: sequenceCommand.requestId, seq: sequenceCommand.seq,
      ok: true, result: { acceptedStaleSequence: false },
    }));
    const sequenceResponse = await sequencePromise;
    assert.equal(sequenceResponse.status, 200);
    assert.equal(sequenceResponse.body.result.acceptedStaleSequence, false);

    const leaseStatus = await request(apiPort, token, 'GET', '/status');
    assert.ok(leaseStatus.body.controlLease?.expiresAt);
    assert.equal(leaseStatus.body.controlLease.owner, owner);

    const blockedStop = await request(apiPort, token, 'POST', '/control/stop', { owner: 'different-thread' });
    assert.equal(blockedStop.status, 409);

    const stopLeasePromise = request(apiPort, token, 'POST', '/control/stop', { owner });
    const releaseCommand = await second.next();
    assert.equal(releaseCommand.command, 'release_lease');
    second.socket.write(frame({
      type: 'response', requestId: releaseCommand.requestId, seq: releaseCommand.seq,
      ok: true, result: { released: true },
    }));
    const stoppedLease = await stopLeasePromise;
    assert.equal(stoppedLease.status, 200);

    const raceStartA = request(apiPort, token, 'POST', '/control/start', {
      durationMillis: 120_000, owner: 'race-owner-a',
    });
    const raceStartB = request(apiPort, token, 'POST', '/control/start', {
      durationMillis: 120_000, owner: 'race-owner-b',
    });
    const raceLeaseCommand = await second.next();
    assert.equal(raceLeaseCommand.command, 'lease');
    second.socket.write(frame({
      type: 'response', requestId: raceLeaseCommand.requestId, seq: raceLeaseCommand.seq,
      ok: true, result: { leaseMillis: 90_000 },
    }));
    const raceResults = await Promise.race([
      Promise.all([raceStartA, raceStartB]),
      delay(2000).then(() => { throw new Error('concurrent control starts did not settle'); }),
    ]);
    assert.deepEqual(raceResults.map((item) => item.status).sort(), [200, 409]);
    const raceWinner = raceResults.find((item) => item.status === 200).body.result.owner;
    const raceStopPromise = request(apiPort, token, 'POST', '/control/stop', { owner: raceWinner });
    const raceReleaseCommand = await second.next();
    assert.equal(raceReleaseCommand.command, 'release_lease');
    second.socket.write(frame({
      type: 'response', requestId: raceReleaseCommand.requestId, seq: raceReleaseCommand.seq,
      ok: true, result: { released: true },
    }));
    assert.equal((await raceStopPromise).status, 200);

    const tabletKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const tabletDer = tabletKeys.publicKey.export({ type: 'spki', format: 'der' });
    const tabletIdentity = {
      privateKey: tabletKeys.privateKey,
      publicKey: tabletDer.toString('base64'),
      deviceId: crypto.createHash('sha256').update(tabletDer).digest('hex').slice(0, 32),
    };
    const pendingTablet = await connectAndAuthenticate(ingressPort, tabletIdentity);
    assert.equal(pendingTablet.auth.type, 'enrollment_required');
    pendingTablet.socket.destroy();
    assert.equal((await request(apiPort, token, 'POST', '/enroll', { deviceId: tabletIdentity.deviceId })).status, 200);
    const tablet = await connectAndAuthenticate(ingressPort, tabletIdentity);
    assert.equal(tablet.auth.type, 'auth_ok');
    tablet.socket.write(frame({ type: 'pong', keyguardLocked: false, accessibilityReady: true, versionCode: 7 }));
    await delay(25);
    const bothDevices = (await request(apiPort, token, 'GET', '/status')).body;
    assert.equal(bothDevices.connectedDevices.length, 2);
    assert.equal(bothDevices.active.deviceId, identity.deviceId);
    assert.equal(second.socket.destroyed, false);
    assert.equal((await request(apiPort, token, 'POST', '/select', { deviceId: tabletIdentity.deviceId })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'device-selection.json'))).deviceId, tabletIdentity.deviceId);
    const wrongDevice = await request(apiPort, token, 'POST', '/control/start', { owner, deviceId: identity.deviceId });
    assert.equal(wrongDevice.body.error, 'selected-device-changed');
    const tabletStart = request(apiPort, token, 'POST', '/control/start', { owner, deviceId: tabletIdentity.deviceId });
    const tabletLease = await tablet.next();
    const tabletResponse = { type: 'response', requestId: tabletLease.requestId, seq: tabletLease.seq, ok: true, result: { leaseMillis: 90_000 } };
    second.socket.write(frame(tabletResponse));
    await delay(25);
    assert.equal((await request(apiPort, token, 'GET', '/status')).body.controlLease, null);
    tablet.socket.write(frame(tabletResponse));
    assert.equal((await tabletStart).body.result.deviceId, tabletIdentity.deviceId);
    assert.equal((await request(apiPort, token, 'POST', '/select', { deviceId: identity.deviceId })).body.error, 'stop-session-before-device-selection');
    assert.equal((await request(apiPort, token, 'POST', '/command', { owner, deviceId: identity.deviceId, command: 'diagnostics' })).body.error, 'selected-device-changed');
    const tabletStop = request(apiPort, token, 'POST', '/control/stop', { owner, deviceId: tabletIdentity.deviceId });
    const tabletRelease = await tablet.next();
    assert.equal(tabletRelease.command, 'release_lease');
    tablet.socket.write(frame({ type: 'response', requestId: tabletRelease.requestId, seq: tabletRelease.seq, ok: true, result: { released: true } }));
    assert.equal((await tabletStop).status, 200);
    tablet.socket.destroy();
    await delay(50);
    const offlineTablet = (await request(apiPort, token, 'GET', '/status')).body;
    assert.equal(offlineTablet.active, null);
    assert.equal(offlineTablet.selectedDeviceId, tabletIdentity.deviceId);
    assert.equal(offlineTablet.connectedDevices[0].deviceId, identity.deviceId);
    const restartConfigPath = path.join(state, 'restart-config.json');
    fs.writeFileSync(restartConfigPath, JSON.stringify({
      stateDir: state, runtimeDir, relayHost: 'relay.example.test',
      ingressPort: ingressPort + 3, apiPort: apiPort + 3, publicPort: 10000, taskName: 'test',
    }));
    const restartedRelay = spawn(process.execPath, [path.join(runtimeDir, 'relay.js'), restartConfigPath], {
      stdio: 'ignore', windowsHide: true,
    });
    let restartedPhone;
    try {
      restartedPhone = await connectAndAuthenticate(ingressPort + 3, identity);
      assert.equal(restartedPhone.auth.type, 'auth_ok');
      const persistedSelection = (await request(apiPort + 3, token, 'GET', '/status')).body;
      assert.equal(persistedSelection.selectedDeviceId, tabletIdentity.deviceId);
      assert.equal(persistedSelection.active, null);
      assert.equal(persistedSelection.connectedDevices[0].deviceId, identity.deviceId);
    } finally {
      restartedPhone?.socket.destroy();
      restartedRelay.kill();
    }
    assert.equal((await request(apiPort, token, 'POST', '/select', { deviceId: identity.deviceId })).status, 200);
    second.socket.destroy();

    const renewalState = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-relay-renewal-test-'));
    fs.writeFileSync(path.join(renewalState, 'devices.json'), JSON.stringify({
      [identity.deviceId]: { publicKey: identity.publicKey, enrolledAt: new Date().toISOString() },
    }));
    const renewalConfig = path.join(renewalState, 'config.json');
    fs.writeFileSync(renewalConfig, JSON.stringify({
      stateDir: renewalState, runtimeDir, relayHost: 'relay.example.test',
      ingressPort: ingressPort + 2, apiPort: apiPort + 2, publicPort: 10000, taskName: 'test',
      controlLeaseRenewalIntervalMs: 250,
      controlLeaseRenewalRetryMs: 20,
      controlLeaseRenewalTimeoutMs: 60,
    }));
    const renewalRelay = spawn(process.execPath, [path.join(runtimeDir, 'relay.js'), renewalConfig], {
      stdio: 'ignore', windowsHide: true,
    });
    let renewalDevice;
    try {
      const renewalTokenPath = path.join(renewalState, 'local-api-token.txt');
      for (let attempt = 0; attempt < 100 && !fs.existsSync(renewalTokenPath); attempt++) await delay(25);
      const renewalToken = fs.readFileSync(renewalTokenPath, 'utf8').trim();
      renewalDevice = await connectAndAuthenticate(ingressPort + 2, identity);
      assert.equal(renewalDevice.auth.type, 'auth_ok');

      const renewalStart = request(apiPort + 2, renewalToken, 'POST', '/control/start', {
        durationMillis: 60_000, owner: 'renewal-recovery-owner',
      });
      const initialLease = await renewalDevice.next();
      assert.equal(initialLease.command, 'lease');
      renewalDevice.socket.write(frame({
        type: 'response', requestId: initialLease.requestId, seq: initialLease.seq,
        ok: true, result: { leaseMillis: 90_000 },
      }));
      assert.equal((await renewalStart).status, 200);

      const timedOutRenewal = await renewalDevice.next();
      assert.equal(timedOutRenewal.command, 'lease');
      const retriedRenewal = await Promise.race([
        renewalDevice.next(),
        delay(2500).then(() => { throw new Error('display lease renewal was not retried'); }),
      ]);
      assert.equal(retriedRenewal.command, 'lease');
      renewalDevice.socket.write(frame({
        type: 'response', requestId: retriedRenewal.requestId, seq: retriedRenewal.seq,
        ok: true, result: { leaseMillis: 90_000 },
      }));
      await delay(25);
      const recoveredStatus = await request(apiPort + 2, renewalToken, 'GET', '/status');
      assert.equal(recoveredStatus.body.controlLease.owner, 'renewal-recovery-owner');

      const renewalStop = request(apiPort + 2, renewalToken, 'POST', '/control/stop', {
        owner: 'renewal-recovery-owner',
      });
      const recoveredRelease = await renewalDevice.next();
      assert.equal(recoveredRelease.command, 'release_lease');
      renewalDevice.socket.write(frame({
        type: 'response', requestId: recoveredRelease.requestId, seq: recoveredRelease.seq,
        ok: true, result: { released: true },
      }));
      assert.equal((await renewalStop).status, 200);
      const stoppedStatus = await request(apiPort + 2, renewalToken, 'GET', '/status');
      assert.equal(stoppedStatus.body.controlLease, null);
    } finally {
      renewalDevice?.socket.destroy();
      renewalRelay.kill();
    }

    const corruptState = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-relay-corrupt-test-'));
    fs.writeFileSync(path.join(corruptState, 'devices.json'), '{invalid json');
    const corruptConfig = path.join(corruptState, 'config.json');
    fs.writeFileSync(corruptConfig, JSON.stringify({
      stateDir: corruptState, runtimeDir, relayHost: 'relay.example.test',
      ingressPort: ingressPort + 1, apiPort: apiPort + 1, publicPort: 10000, taskName: 'test',
    }));
    const corruptRelay = spawn(process.execPath, [path.join(runtimeDir, 'relay.js'), corruptConfig], {
      stdio: 'ignore', windowsHide: true,
    });
    const corruptExit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay accepted corrupt device database')), 2000);
      corruptRelay.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.notEqual(corruptExit, 0);

    fs.writeFileSync(path.join(corruptState, 'devices.json'), '{}');
    fs.writeFileSync(path.join(corruptState, 'device-selection.json'), '{invalid json');
    const corruptSelectionRelay = spawn(process.execPath, [path.join(runtimeDir, 'relay.js'), corruptConfig], {
      stdio: 'ignore', windowsHide: true,
    });
    const corruptSelectionExit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay accepted corrupt device selection')), 2000);
      corruptSelectionRelay.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.notEqual(corruptSelectionExit, 0);
    process.stdout.write('companion relay integration: PASS\n');
  } finally {
    relay.kill();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
