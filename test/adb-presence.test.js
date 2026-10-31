'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { reconcileAdbPresence, discoveredAddress } = require('../src/adb-presence.js');

function fakeAdb(initial, discover = '') {
  const connected = new Map(initial);
  const calls = [];
  const available = new Map([
    ['192.0.2.11:5555', 'phone-serial'],
    ['192.0.2.12:5555', 'note-serial'],
    ['192.0.2.13:5555', 'other-serial'],
    ['192.0.2.14:37123', 'tablet-serial'],
  ]);
  const run = async (_path, args) => {
    calls.push(args);
    if (args[0] === 'devices') {
      return { exitCode: 0, stdout: `List of devices attached\n${[...connected.keys()]
        .map(serial => `${serial}\tdevice`).join('\n')}\n` };
    }
    if (args[0] === 'mdns') return { exitCode: 0, stdout: discover };
    if (args[0] === 'connect') {
      if (!available.has(args[1])) return { exitCode: 0, stdout: `cannot connect to ${args[1]}` };
      connected.set(args[1], available.get(args[1]));
      return { exitCode: 0, stdout: `connected to ${args[1]}` };
    }
    if (args[0] === 'disconnect') {
      connected.delete(args[1]);
      return { exitCode: 0, stdout: `disconnected ${args[1]}` };
    }
    if (args[0] === '-s' && args[2] === 'shell') {
      return { exitCode: connected.has(args[1]) ? 0 : 1,
        stdout: `${connected.get(args[1]) || ''}\n` };
    }
    throw new Error(`Unexpected ADB command ${args.join(' ')}`);
  };
  return { run, calls, connected };
}

test('restores missing phones without touching devices already in use', async () => {
  const adb = fakeAdb([['192.0.2.14:37123', 'tablet-serial'],
    ['198.51.100.20:5555', 'settop-serial']]);
  const config = { systemInput: { adbPath: 'C:\\adb.exe', devices: {
    phone: { serial: '192.0.2.11:5555', hardwareSerial: 'phone-serial' },
    note: { serial: '192.0.2.12:5555', hardwareSerial: 'note-serial' },
    tablet: { serial: '192.0.2.14:5555', hardwareSerial: 'tablet-serial' },
    settop: { serial: 'settop-serial', hardwareSerial: 'settop-serial' },
  } } };
  assert.deepEqual(await reconcileAdbPresence(config, adb.run), { connected: 2, missing: 0 });
  assert.deepEqual(adb.calls.filter(args => args[0] === 'connect').map(args => args[1]),
    ['192.0.2.11:5555', '192.0.2.12:5555']);
  assert.equal(adb.connected.get('192.0.2.14:37123'), 'tablet-serial');
});

test('finds a rotated wireless debugging port through the hardware serial', async () => {
  const adb = fakeAdb([], 'adb-tablet-serial-123\t_adb-tls-connect._tcp\t192.0.2.14:37123\n');
  const config = { systemInput: { adbPath: 'C:\\adb.exe', devices: {
    tablet: { serial: 'tablet-serial', hardwareSerial: 'tablet-serial' },
  } } };
  assert.deepEqual(await reconcileAdbPresence(config, adb.run), { connected: 1, missing: 0 });
  assert.equal(adb.connected.get('192.0.2.14:37123'), 'tablet-serial');
});

test('rejects a stale address that now belongs to a different device', async () => {
  const adb = fakeAdb([]);
  const config = { systemInput: { adbPath: 'C:\\adb.exe', devices: {
    phone: { serial: '192.0.2.13:5555', hardwareSerial: 'phone-serial' },
  } } };
  assert.deepEqual(await reconcileAdbPresence(config, adb.run), { connected: 0, missing: 1 });
  assert.equal(adb.connected.has('192.0.2.13:5555'), false);
  assert.equal(adb.calls.some(args => args[0] === 'disconnect'), true);
});

test('does not accept ambiguous discovery results', () => {
  const records = 'adb-tablet-serial-1 _adb-tls-connect._tcp 192.0.2.14:37123\n'
    + 'adb-tablet-serial-2 _adb-tls-connect._tcp 192.0.2.14:37124';
  assert.equal(discoveredAddress(records, 'tablet-serial'), null);
});
