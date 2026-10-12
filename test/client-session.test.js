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
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      assert.equal(request.headers['x-companion-token'], token);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      let result;
      if (request.method === 'GET' && request.url === '/status') {
        result = { ok: true, active: { deviceId: 'test-device' }, controlLease: null };
      } else if (request.method === 'POST' && request.url === '/control/start') {
        starts.push(body);
        result = { ok: true, result: { durationMillis: body.durationMillis, owner: body.owner } };
      } else if (request.method === 'POST' && request.url === '/command') {
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

    await runClient(clientPath, configPath, ['diagnostics']);
    assert.equal(starts[1].durationMillis, 60 * 60_000);
    assert.equal(starts[1].owner, 'client-session-test');
    process.stdout.write('client session duration: PASS\n');
  } finally {
    await close(server);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
