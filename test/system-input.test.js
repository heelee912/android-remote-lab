'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { systemInput } = require('../src/system-input.js');
const deviceId = 'a'.repeat(32);
const config = { systemInput: { adbPath: path.resolve('mock-adb'),
  devices: { [deviceId]: { serial: 'mock-transport', hardwareSerial: 'MOCK_SERIAL' } } } };
const args = { action: 'tap', x: 42, y: 90, expectedPackage: 'com.google.android.packageinstaller' };
function fake(overrides = {}) {
  const calls = [];
  const output = {
    'get-state': 'device',
    'shell getprop ro.serialno': 'MOCK_SERIAL',
    'shell dumpsys window policy': 'KeyguardServiceDelegate\n showing=false\n inputRestricted=false\n screenState=SCREEN_STATE_ON\n KeyguardStateMonitor',
    'shell dumpsys window displays': 'mCurrentFocus=Window{abcd u0 com.google.android.packageinstaller/.InstallActivity}',
    ...overrides,
  };
  return { calls, run: async (file, command) => {
    assert.equal(file, config.systemInput.adbPath);
    assert.deepEqual(command.slice(0, 2), ['-s', 'mock-transport']);
    calls.push(command);
    return output[command.slice(2).join(' ')] || '';
  } };
}
test('protected-button input uses exactly the configured target and reports dispatch only', async () => {
  const adb = fake();
  const result = await systemInput(config, deviceId, args, () => true, adb.run);
  assert.deepEqual(adb.calls.at(-1), ['-s', 'mock-transport', 'shell', 'input', 'touchscreen', 'tap', '42', '90']);
  assert.equal(result.result.dispatched, true);
  assert.equal(result.result.performed, undefined);
});
test('no input on wrong target, locked/unknown screen, wrong foreground, or expired ownership', async () => {
  for (const [overrides, owns, expected] of [
    [{ 'shell getprop ro.serialno': 'OTHER_DEVICE' }, true, 'device-mismatch'],
    [{ 'get-state': 'offline' }, true, 'adb-unavailable'],
    [{ 'shell dumpsys window policy': 'showing=false' }, true, 'screen-not-unlocked'],
    [{ 'shell dumpsys window policy': 'KeyguardServiceDelegate\n showing=true\n inputRestricted=false\n screenState=SCREEN_STATE_ON' }, true, 'screen-not-unlocked'],
    [{ 'shell dumpsys window displays': 'mCurrentFocus=Window{abcd u0 com.example.other/.Activity}' }, true, 'foreground-mismatch'],
    [{}, false, 'control-lease-expired'],
  ]) {
    const adb = fake(overrides);
    await assert.rejects(systemInput(config, deviceId, args, () => owns, adb.run), new RegExp(expected));
    assert.equal(adb.calls.some(c => c.includes('input')), false);
  }
});
test('unmapped devices and unvalidated input cannot choose a target or run shell text', async () => {
  const adb = fake();
  await assert.rejects(systemInput(config, 'b'.repeat(32), args, () => true, adb.run), /not-configured/);
  for (const extra of [{ x: -1 }, { y: 1.2 }, { expectedPackage: 'pkg;reboot' }, { action: 'keyevent' }]) {
    await assert.rejects(systemInput(config, deviceId, { ...args, ...extra }, () => true, adb.run));
  }
  assert.equal(adb.calls.length, 0);
});
test('swipe retains bounded duration and exact coordinates', async () => {
  const adb = fake();
  await systemInput(config, deviceId, { ...args, action: 'swipe', startX: 1, startY: 2,
    endX: 3, endY: 4, durationMillis: 180 }, () => true, adb.run);
  assert.deepEqual(adb.calls.at(-1).slice(2), ['shell', 'input', 'touchscreen', 'swipe', '1', '2', '3', '4', '180']);
});
