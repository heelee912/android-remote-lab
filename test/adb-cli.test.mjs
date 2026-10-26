import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('installed command shape preserves ADB flags, paths, binary options and nonzero results', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlab-adb-cli-'));
  const deviceId = 'a'.repeat(32);
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      let result;
      if (request.url === '/status') result = { ok: true, active: { deviceId },
        controlLease: { owner: 'adb-cli-test', expiresAt: new Date(Date.now() + 600000).toISOString() } };
      else {
        calls.push(body);
        assert.equal(body.deviceId, deviceId);
        assert.equal(body.owner, 'adb-cli-test');
        assert.ok(['adb', 'adb_pair', 'adb_bind'].includes(body.command));
        const failed = body.command === 'adb' && body.args.argv.includes('denied');
        result = { ok: !failed, result: { exitCode: failed ? 7 : 0, stdout: '', stderr: failed ? 'Permission denied' : '' } };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(directory, 'local-api-token.txt'), 'test-token');
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ stateDir: directory, runtimeDir: directory,
    relayHost: 'relay.example.test', apiPort: server.address().port }));
  const cli = fileURLToPath(new URL('../bin/arlab.mjs', import.meta.url));
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'device', ...args], { windowsHide: true,
      env: { ...process.env, ANDROID_REMOTE_LAB_CONFIG: configPath, ANDROID_REMOTE_LAB_OWNER: 'adb-cli-test' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  try {
    let result = await run(['adb', '--json', '--timeout-ms', '12345', '--', 'shell', 'echo', '--device', '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls.at(-1).args.argv, ['shell', 'echo', '--device', '--json']);
    assert.equal(calls.at(-1).args.timeoutMs, 12345);
    result = await run(['adb', '--json', '--adb-route', 'companion', '--', 'shell', 'id']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls.at(-1).args.route, 'companion');
    const argvFile = path.join(directory, 'arguments.json');
    fs.writeFileSync(argvFile, '\uFEFF' + JSON.stringify(['shell', 'echo', 'space value', '--device', '한글']));
    result = await run(['adb', '--json', '--args-file', argvFile]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls.at(-1).args.argv, ['shell', 'echo', 'space value', '--device', '한글']);
    const shellFile = path.join(directory, 'script.sh');
    const script = "printf '한글\\n'\nid\n";
    fs.writeFileSync(shellFile, '\uFEFF' + script.replace(/\n/g, '\r\n'));
    result = await run(['adb', '--json', '--shell-file', shellFile]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls.at(-1).args.argv, ['shell', script]);
    const beforeInvalid = calls.length;
    result = await run(['adb', '--json', '--args-file', argvFile, '--', 'shell', 'id']);
    assert.equal(result.code, 2);
    assert.equal(calls.length, beforeInvalid);
    result = await run(['files', 'read', "/sdcard/file's name;echo bad", '--json', '--output', path.join(directory, 'saved.bin')]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls.at(-1).args.argv, ['pull']);
    assert.equal(calls.at(-1).args.readRemotePath, "/sdcard/file's name;echo bad");
    assert.equal(calls.at(-1).args.outputFile, path.join(directory, 'saved.bin'));
    result = await run(['files', 'read', '/data/user/0/com.example.debug/files/test', '--as-package', 'com.example.debug', '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls.at(-1).args.accessPackage, 'com.example.debug');
    result = await run(['files', 'read', '/data/local/test', '--as-root', '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls.at(-1).args.asRoot, true);
    const beforeInvalidScope = calls.length;
    for (const args of [['files', 'read', '/test', '--as-root', '--as-package', 'com.example.debug'],
      ['files', 'push', 'test', '/test', '--as-root']]) {
      result = await run([...args, '--json']);
      assert.equal(result.code, 2);
    }
    assert.equal(calls.length, beforeInvalidScope);
    result = await run(['files', 'push', 'local space.bin', '/sdcard/remote space.bin', '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(calls.at(-1).args.argv, ['push', path.resolve('local space.bin'), '/sdcard/remote space.bin']);
    result = await run(['adb', '--json', '--', 'shell', 'denied']);
    assert.equal(result.code, 7);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(JSON.parse(result.stdout).data.result.stderr, 'Permission denied');
    result = await run(['adb-pair', '123456', '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls.at(-1).command, 'adb_pair');
    assert.deepEqual(calls.at(-1).args, { code: '123456' });
    result = await run(['adb-bind', '--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls.at(-1).command, 'adb_bind');
    const beforeInvalidPair = calls.length;
    result = await run(['adb-pair', '12345', '--json']);
    assert.equal(result.code, 2);
    assert.equal(calls.length, beforeInvalidPair);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
