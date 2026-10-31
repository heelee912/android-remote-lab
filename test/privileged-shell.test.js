'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { bootstrapPrivilegedShell, executePrivilegedShell, isPrivilegedShellRequest } = require('../src/privileged-shell.js');

test('recognizes only adb shell and exec-out requests', () => {
  assert.equal(isPrivilegedShellRequest({ argv: ['shell', 'id'] }), true);
  assert.equal(isPrivilegedShellRequest({ argv: ['exec-out', 'screencap', '-p'] }), true);
  assert.equal(isPrivilegedShellRequest({ argv: ['install', 'app.apk'] }), false);
});

test('preserves argument boundaries and decodes broker output', async () => {
  let request;
  const result = await executePrivilegedShell({
    argv: ['shell', 'printf', '%s', 'a b'], timeoutMs: 1_000,
  }, async (command, args) => {
    assert.equal(command, 'privileged_shell_exec');
    request = args;
    return { ok: true, result: {
      exitCode: 0,
      stdoutBase64: Buffer.from('a b').toString('base64'),
      stderrBase64: '',
    } };
  });
  assert.deepEqual(request.argv, ['printf', '%s', 'a b']);
  assert.equal(result.ok, true);
  assert.equal(result.result.stdout, 'a b');
  assert.equal(result.result.connectionRoute, 'privileged-shell');
});

test('treats a single shell argument as one complete script', async () => {
  let argv;
  await executePrivilegedShell({ argv: ['shell', 'id; getprop ro.serialno'], timeoutMs: 1_000 },
    async (command, args) => {
      argv = args.argv;
      return { ok: true, result: { exitCode: 0, stdoutBase64: '', stderrBase64: '' } };
    });
  assert.deepEqual(argv, ['/system/bin/sh', '-c', 'id; getprop ro.serialno']);
});

test('writes binary output exclusively', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privileged-shell-test-'));
  const destination = path.join(directory, 'capture.bin');
  try {
    const bytes = Buffer.from([0, 1, 2, 255]);
    const result = await executePrivilegedShell({
      argv: ['exec-out', 'test-command'], timeoutMs: 1_000, outputFile: destination,
    }, async () => ({ ok: true, result: {
      exitCode: 0, stdoutBase64: bytes.toString('base64'), stderrBase64: '',
    } }));
    assert.equal(result.ok, true);
    assert.deepEqual(fs.readFileSync(destination), bytes);
    await assert.rejects(() => executePrivilegedShell({
      argv: ['exec-out', 'test-command'], timeoutMs: 1_000, outputFile: destination,
    }, async () => ({ ok: true, result: {
      exitCode: 0, stdoutBase64: bytes.toString('base64'), stderrBase64: '',
    } })), /EEXIST/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bootstraps through authorized ADB without returning the capability', async () => {
  const token = 'a'.repeat(64);
  let adbRequest;
  let statusReads = 0;
  const result = await bootstrapPrivilegedShell(async request => {
    adbRequest = request;
    return { ok: true, result: { exitCode: 0 } };
  }, async command => {
    if (command === 'privileged_shell_prepare') return { ok: true, result: {
      port: 27183,
      token,
      classpath: '/data/app/example/base.apk',
      mainClass: 'com.codex.remotecompanion.PrivilegedShellBroker',
    } };
    assert.equal(command, 'privileged_shell_status');
    statusReads++;
    return { ok: true, result: { ready: true, uid: 2000, pid: 1234 } };
  });
  assert.equal(statusReads, 1);
  assert.match(adbRequest.argv[1], /app_process/);
  assert.match(adbRequest.argv[1], new RegExp(token));
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.deepEqual(result, { ok: true, result: {
    ready: true, uid: 2000, pid: 1234, connectionRoute: 'companion-privileged-shell',
  } });
});
