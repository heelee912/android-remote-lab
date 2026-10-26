'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdbRouteSelection } = require('../src/adb-route.js');

test('automatic routing uses direct ADB and recovers only before command dispatch', async () => {
  let now = 100;
  const execute = createAdbRouteSelection(() => now);
  let probes = 0;
  let tunneled = 0;
  const direct = async () => { probes++; throw new Error('adb-transport-unavailable'); };
  const companion = async () => { tunneled++; return { ok: true }; };
  assert.equal((await execute('selected', {}, direct, companion)).ok, true);
  await execute('selected', {}, direct, companion);
  assert.equal(probes, 1, 'Offline LAN discovery is not repeated for every remote command');
  assert.equal(tunneled, 2);
  now += 30001;
  await execute('selected', {}, async () => { probes++; return { ok: true }; }, companion);
  assert.equal(probes, 2);
  assert.equal(tunneled, 2, 'Restored direct ADB replaces the slower internet route');
});

test('failed or uncertain dispatched mutations never execute through a second route', async () => {
  const execute = createAdbRouteSelection();
  const never = async () => { throw new Error('MUTATION_REPLAYED'); };
  for (const result of [{ ok: false }, { ok: false, result: { outcome: 'unconfirmed' } }]) {
    assert.equal(await execute('selected', {}, async () => result, never), result);
  }
  for (const message of ['adb-control-lease-expired', 'adb-invalid-arguments']) {
    await assert.rejects(execute('selected', {}, async () => { throw new Error(message); }, never), new RegExp(message));
  }
  await assert.rejects(execute('selected', { route: 'direct' }, async () => { throw new Error('adb-timeout'); }, never), /adb-timeout/);
  await assert.rejects(execute('selected', { route: 'direct' }, async () => { throw new Error('adb-device-mismatch'); }, never), /adb-device-mismatch/);
  for (const message of ['adb-device-mismatch', 'adb-multiple-matching-transports']) {
    const auto = createAdbRouteSelection();
    const recovered = await auto('selected', {}, async () => { throw new Error(message); }, async () => 'verified-companion');
    assert.equal(recovered, 'verified-companion', 'An obsolete LAN address cannot dispatch to another phone; the enrolled Companion is verified independently');
  }
  assert.equal(await execute('selected', { route: 'companion' }, never, async () => 'remote'), 'remote');
  await assert.rejects(execute('selected', { route: 'unknown' }, never, never), /adb-invalid-route/);
});
