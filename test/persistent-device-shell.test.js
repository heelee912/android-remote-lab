'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { executePersistentDeviceShell, isPersistentDeviceShellRequest } = require('../src/persistent-device-shell.js');

test('recognizes shell commands without treating other adb commands as native shell', () => {
  assert.equal(isPersistentDeviceShellRequest({ argv: ['shell', 'getprop', 'ro.product.model'] }), true);
  assert.equal(isPersistentDeviceShellRequest({ argv: ['exec-out', 'cat', '/proc/version'] }), true);
  assert.equal(isPersistentDeviceShellRequest({ argv: ['install', 'app.apk'] }), false);
});

test('executes through Companion without an adbd route', async () => {
  let invoked;
  const response = await executePersistentDeviceShell({
    argv: ['shell', 'printf', '%s', 'ready'], timeoutMs: 1_000,
  }, async (command, args) => {
    invoked = { command, args };
    return { ok: true, result: {
      exitCode: 0,
      stdoutBase64: Buffer.from('ready').toString('base64'),
      stderrBase64: '',
      executionIdentity: { uid: 10345, kind: 'companion-application', requiresAdbd: false },
    } };
  });
  assert.equal(invoked.command, 'persistent_device_shell_exec');
  assert.deepEqual(invoked.args.argv, ['printf', '%s', 'ready']);
  assert.equal(response.ok, true);
  assert.equal(response.result.stdout, 'ready');
  assert.equal(response.result.connectionRoute, 'companion-device-shell');
  assert.equal(response.result.executionIdentity.requiresAdbd, false);
});

test('treats a single shell argument as a complete script', async () => {
  let argv;
  await executePersistentDeviceShell({ argv: ['shell', 'id; getprop ro.product.model'], timeoutMs: 1_000 },
    async (_command, args) => {
      argv = args.argv;
      return { ok: true, result: { exitCode: 0, stdoutBase64: '', stderrBase64: '' } };
    });
  assert.deepEqual(argv, ['/system/bin/sh', '-c', 'id; getprop ro.product.model']);
});

test('writes binary output exclusively', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-device-shell-test-'));
  const destination = path.join(directory, 'capture.bin');
  try {
    const bytes = Buffer.from([0, 1, 255]);
    const response = await executePersistentDeviceShell({
      argv: ['exec-out', 'test-command'], timeoutMs: 1_000, outputFile: destination,
    }, async () => ({ ok: true, result: {
      exitCode: 0, stdoutBase64: bytes.toString('base64'), stderrBase64: '',
    } }));
    assert.equal(response.ok, true);
    assert.deepEqual(fs.readFileSync(destination), bytes);
    await assert.rejects(() => executePersistentDeviceShell({
      argv: ['exec-out', 'test-command'], timeoutMs: 1_000, outputFile: destination,
    }, async () => ({ ok: true, result: {
      exitCode: 0, stdoutBase64: bytes.toString('base64'), stderrBase64: '',
    } })), /EEXIST/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not report Android permission text with exit code zero as success', async () => {
  const response = await executePersistentDeviceShell({
    argv: ['shell', 'dumpsys', 'package'], timeoutMs: 1_000,
  }, async () => ({ ok: true, result: {
    exitCode: 0,
    stdoutBase64: Buffer.from('Permission Denial: missing android.permission.DUMP\n').toString('base64'),
    stderrBase64: '',
  } }));
  assert.equal(response.ok, false);
  assert.equal(response.result.error, 'android-command-permission-denied');
  assert.equal(response.result.outcome, 'confirmed-failed');
});

test('permission text remains a failure when stdout is saved to a file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-device-shell-denial-'));
  const destination = path.join(directory, 'dump.txt');
  try {
    const response = await executePersistentDeviceShell({
      argv: ['shell', 'dumpsys', 'package'], timeoutMs: 1_000, outputFile: destination,
    }, async () => ({ ok: true, result: {
      exitCode: 0,
      stdoutBase64: Buffer.from('Permission Denial: missing android.permission.DUMP\n').toString('base64'),
      stderrBase64: '',
    } }));
    assert.equal(response.ok, false);
    assert.equal(response.result.error, 'android-command-permission-denied');
    assert.match(fs.readFileSync(destination, 'utf8'), /Permission Denial/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
