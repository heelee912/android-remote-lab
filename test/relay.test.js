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
    }));
    await delay(50);
    const deviceReadiness = await request(apiPort, token, 'GET', '/status');
    assert.equal(deviceReadiness.body.active.keyguardLocked, false);
    assert.equal(deviceReadiness.body.active.accessibilityReady, true);
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
    second.socket.destroy();

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
    process.stdout.write('companion relay integration: PASS\n');
  } finally {
    relay.kill();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
