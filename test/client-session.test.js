'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runClient(clientPath, configPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [clientPath, ...args], {
      env: {
        ...process.env,
        ANDROID_REMOTE_LAB_CONFIG: configPath,
        ANDROID_REMOTE_LAB_OWNER: 'client-session-test',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`client exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
        return;
      }
      resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
    });
  });
}

async function main() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-remote-lab-client-test-'));
  const token = 'test-local-api-token';
  fs.writeFileSync(path.join(stateDir, 'local-api-token.txt'), token);
  const starts = [];
  let currentLease = null;
  let offlineReads = 0;
  let telemetryReads = 0;
  let preparationFailures = 0;
  let uncertainFailures = 0;
  let mutations = 0;
  let changeSelection = false;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      assert.equal(request.headers['x-companion-token'], token);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      let result;
      if (request.method === 'GET' && request.url === '/status') {
        const offline = offlineReads > 0;
        if (offline) offlineReads--;
        const deviceId = changeSelection && !offline ? 'other-device' : 'test-device';
        result = { ok: true, active: { deviceId: 'test-device', secureKeyguardLocked: true,
          screenInteractive: false, accessibilityReady: false }, controlLease: currentLease };
        result.active = offline ? null : { ...result.active, deviceId };
        if (result.active) {
          result.active.versionCode = telemetryReads > 0 ? null : 15;
          if (telemetryReads > 0) telemetryReads--;
        }
        result.selectedDeviceId = deviceId;
        result.connectedDevices = [{ deviceId: 'other-device' }];
      } else if (request.method === 'POST' && request.url === '/control/start') {
        starts.push(body);
        currentLease = { ...body, expiresAt: new Date(Date.now() + body.durationMillis).toISOString() };
        result = { ok: true, result: { durationMillis: body.durationMillis, owner: body.owner } };
      } else if (request.method === 'POST' && request.url === '/command') {
        if (preparationFailures > 0) {
          preparationFailures--;
          currentLease = null;
          offlineReads = 2;
          response.writeHead(503);
          response.end(JSON.stringify({ ok: false, error: 'device-disconnected', dispatchState: 'not-started' }));
          return;
        }
        if (body.args?.argv?.[0] === 'install') mutations++;
        if (uncertainFailures > 0) {
          uncertainFailures--;
          response.writeHead(503);
          response.end(JSON.stringify({ ok: false, error: 'device-disconnected' }));
          return;
        }
        result = { ok: true, result: { versionCode: 7 } };
      } else {
        response.writeHead(404);
        response.end(JSON.stringify({ ok: false, error: 'not-found' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    });
  });

  const apiPort = await listen(server);
  try {
    const configPath = path.join(stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      stateDir,
      runtimeDir: path.join(__dirname, '..', 'src'),
      relayHost: 'relay.example.test',
      ingressPort: apiPort + 1,
      apiPort,
      publicPort: 10000,
    }));
    const clientPath = path.join(__dirname, '..', 'src', 'client.js');

    await runClient(clientPath, configPath, ['session-start']);
    assert.equal(starts[0].durationMillis, 60 * 60_000);
    assert.equal(starts[0].owner, 'client-session-test');

    currentLease = null;
    await runClient(clientPath, configPath, ['diagnostics']);
    assert.equal(starts[1].durationMillis, 60 * 60_000);
    assert.equal(starts[1].owner, 'client-session-test');
    assert.equal(starts[1].background, true);
    await runClient(clientPath, configPath, ['adb', JSON.stringify({ argv: ['shell', 'id'] })]);
    assert.equal(starts.length, 2, 'ADB reuses background ownership without waking the screen');
    await runClient(clientPath, configPath, ['open', 'com.example.app']);
    assert.equal(starts.length, 3);
    assert.equal(starts[2].background, false, 'UI request upgrades to an interactive lease');
    await runClient(clientPath, configPath, ['session-start', '120', '--background']);
    assert.equal(starts[3].background, true);
    assert.equal(starts[3].durationMillis, 120 * 60000);
    currentLease = null;
    offlineReads = 3;
    await runClient(clientPath, configPath, ['diagnostics']);
    assert.equal(starts[4].deviceId, 'test-device', 'Reconnect waits for the enrolled target, not another online phone');
    currentLease = null;
    offlineReads = 1;
    changeSelection = true;
    await assert.rejects(runClient(clientPath, configPath, ['diagnostics']), /selected-device-changed/);
    assert.equal(starts.length, 5, 'A changed target must never acquire ownership or receive the caller command');
    changeSelection = false;
    telemetryReads = 3;
    await runClient(clientPath, configPath, ['adb', JSON.stringify({ argv: ['shell', 'id'], route: 'companion' })]);
    assert.equal(telemetryReads, 0, 'Reconnect waits for fresh capabilities before choosing the ADB route');
    assert.equal(starts.length, 6);
    preparationFailures = 1;
    await runClient(clientPath, configPath, ['adb', JSON.stringify({ argv: ['install', 'test.apk'] })]);
    assert.equal(mutations, 1, 'A handoff before dispatch reconnects and executes the caller once');
    uncertainFailures = 1;
    await assert.rejects(runClient(clientPath, configPath, ['adb', JSON.stringify({ argv: ['install', 'test.apk'] })]), /device-disconnected/);
    assert.equal(mutations, 2, 'An uncertain executed install is not replayed');
    process.stdout.write('client session duration: PASS\n');
  } finally {
    await close(server);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
