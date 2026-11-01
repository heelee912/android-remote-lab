'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

test('shared file push and pull preserve bytes without ADB commands', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlab-shared-file-'));
  const deviceId = 'b'.repeat(32);
  const uploadBytes = Buffer.alloc(700 * 1024 + 3);
  for (let index = 0; index < uploadBytes.length; index++) uploadBytes[index] = index % 251;
  const downloadBytes = Buffer.from(uploadBytes).reverse();
  const uploadSha = crypto.createHash('sha256').update(uploadBytes).digest('hex');
  const downloadSha = crypto.createHash('sha256').update(downloadBytes).digest('hex');
  let uploaded = Buffer.alloc(0);
  const commands = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      let payload;
      if (request.url === '/status') {
        payload = { active: { deviceId, versionCode: 52 }, selectedDeviceId: deviceId,
          controlLease: { owner: 'shared-file-test', background: true,
            expiresAt: new Date(Date.now() + 600000).toISOString() } };
      } else {
        commands.push(body.command);
        const args = body.args;
        if (body.command === 'shared_file_upload_begin') payload = { result: {
          uploadId: uploadSha, receivedBytes: 0, sizeBytes: uploadBytes.length } };
        else if (body.command === 'shared_file_upload_chunk') {
          const bytes = Buffer.from(args.base64, 'base64');
          assert.equal(args.offset, uploaded.length);
          assert.equal(args.chunkSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
          uploaded = Buffer.concat([uploaded, bytes]);
          payload = { result: { receivedBytes: uploaded.length } };
        } else if (body.command === 'shared_file_upload_commit') payload = { result: {
          completed: true, sha256: uploadSha, sizeBytes: uploadBytes.length } };
        else if (body.command === 'shared_file_download_begin') payload = { result: {
          sizeBytes: downloadBytes.length, sha256: downloadSha, chunkBytes: 512 * 1024 } };
        else if (body.command === 'shared_file_download_chunk') {
          const bytes = downloadBytes.subarray(args.offset,
            Math.min(downloadBytes.length, args.offset + 512 * 1024));
          payload = { result: { offset: args.offset, base64: bytes.toString('base64'),
            chunkSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            nextOffset: args.offset + bytes.length,
            completed: args.offset + bytes.length === downloadBytes.length } };
        } else throw new Error(`Unexpected command ${body.command}`);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, ...payload }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(directory, 'local-api-token.txt'), 'test-token');
  const config = path.join(directory, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ stateDir: directory, runtimeDir: directory,
    relayHost: 'relay.example.test', apiPort: server.address().port }));
  const input = path.join(directory, 'input.bin');
  const output = path.join(directory, 'output.bin');
  fs.writeFileSync(input, uploadBytes);
  const client = path.resolve(__dirname, '../src/client.js');
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [client, ...args], { windowsHide: true,
      env: { ...process.env, ANDROID_REMOTE_LAB_CONFIG: config,
        ANDROID_REMOTE_LAB_DEVICE_ID: deviceId, ANDROID_REMOTE_LAB_OWNER: 'shared-file-test' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  try {
    let result = await run(['shared-file-push', input, '/sdcard/Download/input.bin']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(uploaded, uploadBytes);
    result = await run(['shared-file-pull', '/sdcard/Download/output.bin', output]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(output), downloadBytes);
    assert.equal(commands.includes('adb'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
