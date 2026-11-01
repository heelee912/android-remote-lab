'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { bankingForegroundPackageToStop, executeInBankingDebugWindow,
  isBankingAppForeground } = require('../src/banking-debug-window.js');

test('identifies only configured banking apps as protected foregrounds', () => {
  assert.equal(isBankingAppForeground({ foregroundPackage: 'com.nonghyup.nhallonebank' }), true);
  assert.equal(isBankingAppForeground({ foregroundPackage: 'com.google.android.youtube' }), false);
  assert.equal(isBankingAppForeground({ foregroundPackage: 'com.sec.android.app.launcher' }), false);
  assert.equal(isBankingAppForeground({ foregroundPackage: null }), false);
});

test('stops only a foreground banking app before banking mode hides ADB', () => {
  assert.equal(bankingForegroundPackageToStop({ foregroundPackage: 'com.nonghyup.nhallonebank' }),
    'com.nonghyup.nhallonebank');
  assert.equal(bankingForegroundPackageToStop({ foregroundPackage: 'com.google.android.youtube' }), null);
  assert.equal(bankingForegroundPackageToStop({ foregroundPackage: 'com.sec.android.app.launcher' }), null);
  assert.throws(() => bankingForegroundPackageToStop({ foregroundPackage: '../bad' }),
    /banking-foreground-package-invalid/);
});

test('always closes the transient debug window after a native command', async () => {
  const order = [];
  const result = await executeInBankingDebugWindow(
    { foregroundPackage: 'com.google.android.youtube' },
    async () => { order.push('open'); return { ok: true, result: { bootstrapOpened: true } }; },
    async () => { order.push('execute'); return { ok: true, result: { exitCode: 0 } }; },
    async () => { order.push('close'); return { ok: true, result: { bootstrapClosed: true } }; });
  assert.deepEqual(order, ['open', 'execute', 'close']);
  assert.equal(result.result.bankingDebugWindow, true);
});

test('rejects a native ADB window only while the banking app is foreground', async () => {
  const order = [];
  await assert.rejects(() => executeInBankingDebugWindow(
    { foregroundPackage: 'com.nonghyup.nhallonebank' },
    async () => { order.push('open'); },
    async () => { order.push('execute'); },
    async () => { order.push('close'); }),
  /banking-app-active/);
  assert.deepEqual(order, []);
});

test('closes the transient debug window when command execution fails', async () => {
  const order = [];
  await assert.rejects(() => executeInBankingDebugWindow(
    { foregroundPackage: 'com.sec.android.app.launcher' },
    async () => { order.push('open'); return { ok: true, result: { bootstrapOpened: true } }; },
    async () => { order.push('execute'); throw new Error('native command failed'); },
    async () => { order.push('close'); return { ok: true, result: { bootstrapClosed: true } }; }),
  /native command failed/);
  assert.deepEqual(order, ['open', 'execute', 'close']);
});
