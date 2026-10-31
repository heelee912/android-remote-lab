'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { executeInBankingDebugWindow, isSafeBankingDebugForeground } = require('../src/banking-debug-window.js');

test('permits debug windows only on known system and launcher foregrounds', () => {
  assert.equal(isSafeBankingDebugForeground({ foregroundPackage: 'com.sec.android.app.launcher' }), true);
  assert.equal(isSafeBankingDebugForeground({ foregroundPackage: 'com.nonghyup.nhallonebank' }), false);
  assert.equal(isSafeBankingDebugForeground({ foregroundPackage: null }), false);
});

test('always closes the transient debug window after a native command', async () => {
  const order = [];
  const result = await executeInBankingDebugWindow(
    { foregroundPackage: 'com.android.systemui' },
    async () => { order.push('open'); return { ok: true, result: { bootstrapOpened: true } }; },
    async () => { order.push('execute'); return { ok: true, result: { exitCode: 0 } }; },
    async () => { order.push('close'); return { ok: true, result: { bootstrapClosed: true } }; });
  assert.deepEqual(order, ['open', 'execute', 'close']);
  assert.equal(result.result.bankingDebugWindow, true);
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
