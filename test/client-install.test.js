'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

(async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'arlab-install-test-'));
  const deviceId = 'a'.repeat(32);
  const apk = path.join(state, 'mock.apk');
  fs.writeFileSync(apk, 'mock-apk-bytes');
  const id = crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
  fs.writeFileSync(path.join(state, 'local-api-token.txt'), 'MOCK-TOKEN');
  let mode = 'disconnect';
  let commits = 0;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', b => body += b); req.on('end', () => {
      if (req.url === '/status') return res.end(JSON.stringify({ ok: true, selectedDeviceId: deviceId,
        active: { deviceId, accessibilityReady: false, screenInteractive: false },
        controlLease: { owner: 'install-test', background: true,
          expiresAt: new Date(Date.now() + 3600000).toISOString() } }));
      const command = JSON.parse(body);
      assert.equal(command.owner, 'install-test');
      assert.equal(command.deviceId, deviceId);
      let result;
      switch (command.command) {
        case 'install_begin': result = { uploadId: id, receivedBytes: mode === 'pending' ? 14 : 0,
          status: mode === 'pending' ? 'pending-user-action' : 'uploading' }; break;
        case 'install_chunk': result = { receivedBytes: 14 }; break;
        case 'install_commit':
          commits++;
          if (mode === 'disconnect') { res.statusCode = 503; return res.end(JSON.stringify({ ok: false, error: 'device-disconnected' })); }
          result = { submitted: true }; break;
        case 'install_status': result = { uploadId: id, status: mode === 'pending' ? 'pending-user-action'
          : mode === 'failed' ? 'failed' : 'success' }; break;
        default: throw new Error('Unexpected mock command');
      }
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = path.join(state, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ stateDir: state, runtimeDir: path.resolve('src'),
    relayHost: 'mock.example.test', apiPort: server.address().port }));
  try {
    for (const scenario of ['disconnect', 'pending', 'failed']) {
      mode = scenario; commits = 0;
      const child = spawn(process.execPath, [path.resolve('src/client.js'), 'install', apk], {
        windowsHide: true, env: { ...process.env, ANDROID_REMOTE_LAB_CONFIG: config,
          ANDROID_REMOTE_LAB_STATE_DIR: state, ANDROID_REMOTE_LAB_API_PORT: String(server.address().port),
          ANDROID_REMOTE_LAB_OWNER: 'install-test', ANDROID_REMOTE_LAB_DEVICE_ID: deviceId } });
      let stdout = '', stderr = '';
      child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      assert.equal(code, scenario === 'failed' ? 1 : 0, stderr);
      assert.equal(commits, scenario === 'pending' ? 0 : 1, 'An uncertain or sealed commit must not be retried');
      const result = JSON.parse(stdout);
      assert.equal(result.state, { disconnect: 'INSTALLED', pending: 'PENDING_USER_ACTION', failed: 'INSTALL_FAILED' }[scenario]);
      assert.equal(result.uploadId, id);
      if (scenario === 'disconnect') assert.equal(result.submissionError, 'device-disconnected');
    }
    process.stdout.write('client self-update recovery and no duplicate commit: PASS\n');
  } finally { server.close(); }
})().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
