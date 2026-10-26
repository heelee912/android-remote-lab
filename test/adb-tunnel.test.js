'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createAdbTunnel, provisionTcpListener, waitForAdbListener } = require('../src/adb-tunnel.js');

test('mobile bootstrap discovers TLS first and waits for hotspot teardown after TCP provisioning', async () => {
  let elapsed = 0;
  const wait = async milliseconds => { elapsed += milliseconds; };
  const now = () => elapsed;
  const tls = { ready: true, listenerType: 'tls', mobileRecoveryRunning: true };
  assert.equal(await waitForAdbListener({ ready: false, mobileRecoveryRunning: true },
    async () => tls, 5000, wait, now), tls);
  let probes = 0;
  const tcp = await waitForAdbListener({ ready: true, listenerType: 'tcp', mobileRecoveryRunning: true },
    async () => ({ ready: true, listenerType: 'tcp', mobileRecoveryRunning: ++probes < 3 }),
    5000, wait, now);
  assert.equal(tcp.mobileRecoveryRunning, false);
  assert.equal(probes, 3, 'A listening TCP socket alone is insufficient during hotspot teardown');
  const denied = { ready: false, mobileRecoveryRunning: false, mobileRecoveryError: 'hotspot permission denied' };
  assert.equal(await waitForAdbListener(denied, () => { throw new Error('must not poll'); }), denied);
  await assert.rejects(waitForAdbListener({ ready: false, mobileRecoveryRunning: true },
    async () => ({ ready: false, mobileRecoveryRunning: true }), 1000, wait, now), /bootstrap-timeout/);
  await assert.rejects(waitForAdbListener({ ready: false, mobileRecoveryRunning: true },
    async () => { throw new Error('adb-control-lease-expired'); }, 1000, wait, now), /lease-expired/);
});

test('TCP provisioning verifies the new listener after an interrupted adbd restart without replay', async () => {
  let submissions = 0;
  let observations = 0;
  const status = await provisionTcpListener({ listenerType: 'tls' }, async () => {
    submissions++;
    throw new Error('adb-transport-closed');
  }, async () => (++observations < 3 ? { ready: false } : { ready: true, listenerType: 'tcp', port: 5555 }),
  async () => {});
  assert.equal(status.port, 5555);
  assert.equal(submissions, 1);
  assert.equal(observations, 3);
  let touched = false;
  const tcp = { ready: true, listenerType: 'tcp', port: 5555 };
  assert.equal(await provisionTcpListener(tcp, () => { touched = true; }, () => { touched = true; }), tcp);
  assert.equal(touched, false, 'An existing TCP route has no provisioning side effect');
  await assert.rejects(provisionTcpListener({ listenerType: 'tls' },
    async () => ({ ok: false, result: { error: 'native-failure' } }),
    async () => ({ ready: true, listenerType: 'tls' }), async () => {}), /native-failure/);
});

test('tunnel preserves binary duplex data and closes streams on ownership loss', async () => {
  let owner = true;
  const streams = new Map();
  const calls = [];
  let backpressure = 0;
  const invoke = async (command, args) => {
    calls.push(command);
    let result;
    if (command === 'adb_tunnel_status') result = { ready: true, tlsPort: 12345, chunkBytes: 512 * 1024 };
    else if (command === 'adb_tunnel_open') { const id = crypto.randomUUID(); streams.set(id, []); result = { streamId: id }; }
    else if (command === 'adb_tunnel_close') { streams.delete(args.streamId); result = { closed: true }; }
    else if (command === 'adb_tunnel_write') {
      const bytes = Buffer.from(args.base64, 'base64');
      const queued = streams.get(args.streamId);
      const accepted = queued.length >= 2 ? 0 : Math.min(bytes.length, 8191);
      if (!accepted) backpressure++;
      if (accepted) queued.push(bytes.subarray(0, accepted));
      result = { written: accepted };
    } else if (command === 'adb_tunnel_read') {
      result = { base64: (streams.get(args.streamId)?.shift() || Buffer.alloc(0)).toString('base64') };
    } else throw new Error(command);
    return { ok: true, result };
  };
  const tunnel = await createAdbTunnel(invoke, () => owner);
  assert.match(tunnel.serial, /^127\.0\.0\.1:\d+$/);
  const socket = net.connect({ host: '127.0.0.1', port: Number(tunnel.serial.split(':')[1]) });
  socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    const original = Buffer.alloc(256 * 1024 + 1);
    for (let index = 0; index < original.length; index++) original[index] = index % 256;
    const received = [];
    let count = 0;
    const completed = new Promise(resolve => socket.on('data', bytes => {
      received.push(bytes); count += bytes.length; if (count === original.length) resolve();
    }));
    socket.write(original);
    await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new Error('tunnel transfer timeout')), 5000).unref())]);
    assert.deepEqual(Buffer.concat(received), original);
    assert.ok(backpressure > 0, 'The reader must make progress while the writer has no capacity');
    const closed = once(socket, 'close');
    owner = false;
    await closed;
    assert.equal(tunnel.closed, true);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(streams.size, 0);
    assert.ok(calls.includes('adb_tunnel_close'));
  } finally { socket.destroy(); tunnel.close(); }
});

test('remote EOF delivers all buffered bytes and a new tunnel can reconnect after closure', async () => {
  const original = crypto.randomBytes(512 * 1024 + 17);
  for (let connection = 0; connection < 2; connection++) {
    let offset = 0;
    const invoke = async command => {
      if (command === 'adb_tunnel_status') return { ok: true, result: { ready: true } };
      if (command === 'adb_tunnel_open') return { ok: true, result: { streamId: crypto.randomUUID() } };
      if (command === 'adb_tunnel_read') {
        const bytes = original.subarray(offset, offset + 48 * 1024);
        offset += bytes.length;
        return { ok: true, result: bytes.length ? { base64: bytes.toString('base64') } : { eof: true } };
      }
      return { ok: true, result: { closed: true } };
    };
    const tunnel = await createAdbTunnel(invoke, () => true);
    const socket = net.connect({ host: '127.0.0.1', port: Number(tunnel.serial.split(':')[1]) });
    const chunks = [];
    socket.on('data', bytes => chunks.push(bytes));
    try {
      await once(socket, 'end');
      assert.deepEqual(Buffer.concat(chunks), original);
    } finally { socket.destroy(); tunnel.close(); }
  }
});

test('tunnel refuses missing listener and cannot reserve an endpoint without ownership', async () => {
  await assert.rejects(createAdbTunnel(async () => { throw new Error('must not dispatch'); }, () => false), /lease-expired/);
  for (const canRepair of [false, true]) {
    await assert.rejects(createAdbTunnel(async () => ({ ok: true, result: { ready: false, canRepair } }), () => true),
      canRepair ? /unavailable-after-repair/ : /provisioning-required/);
  }
});

test('pairing tunnel opens only the discovered local pairing service', async () => {
  const calls = [];
  const streamId = crypto.randomUUID();
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === 'adb_tunnel_status') return { ok: true,
      result: { pairingPort: 43210, ready: false, chunkBytes: 4096 } };
    if (command === 'adb_tunnel_open') return { ok: true, result: { streamId } };
    if (command === 'adb_tunnel_read') return { ok: true, result: { eof: true } };
    if (command === 'adb_tunnel_close') return { ok: true, result: { closed: true } };
    throw new Error(`Unexpected command: ${command}`);
  };
  const tunnel = await createAdbTunnel(invoke, () => true, () => {}, { purpose: 'pairing' });
  const socket = net.connect({ host: '127.0.0.1', port: Number(tunnel.serial.split(':')[1]) });
  try {
    await once(socket, 'end');
    assert.equal(tunnel.listenerPort, 43210);
    assert.equal(tunnel.listenerType, 'pairing');
    assert.deepEqual(calls.find(call => call.command === 'adb_tunnel_open')?.args, { purpose: 'pairing' });
    assert.deepEqual(calls.find(call => call.command === 'adb_tunnel_status')?.args, {});
  } finally { socket.destroy(); tunnel.close(); }
  await assert.rejects(createAdbTunnel(async () => ({ ok: true,
    result: { pairingPort: -1, chunkBytes: 4096 } }), () => true, () => {}, { purpose: 'pairing' }),
  /adb-pairing-service-unavailable/);
});

test('a failed native reconnect retires the endpoint instead of repeatedly repairing the phone', async () => {
  let opens = 0;
  const tunnel = await createAdbTunnel(async command => {
    if (command === 'adb_tunnel_status') return { ok: true, result: { ready: true, port: 5555 } };
    if (command === 'adb_tunnel_open') {
      opens++;
      return { ok: false, error: { message: 'ADB wireless listener is not running' } };
    }
    throw new Error(`Unexpected command: ${command}`);
  }, () => true);
  const endpoint = { host: '127.0.0.1', port: Number(tunnel.serial.split(':')[1]) };
  const first = net.connect(endpoint);
  first.on('error', () => {});
  try {
    await once(first, 'close');
    assert.equal(tunnel.closed, true);
    assert.match(tunnel.lastError, /listener is not running/);
    const retry = net.connect(endpoint);
    const failure = await new Promise(resolve => retry.once('error', resolve));
    assert.equal(failure.code, 'ECONNREFUSED');
    assert.equal(opens, 1, 'The SDK reconnect must not enqueue another phone repair');
  } finally { first.destroy(); tunnel.close(); }
});
