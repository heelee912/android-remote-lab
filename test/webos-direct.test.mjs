import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  readWebOsState, turnOffWebOsScreen, WebOsSocket, webOsSocketPath, webOsStatePath,
} from '../src/webos-direct.mjs';

class FakeSocket extends EventEmitter {
  writes = [];
  write(bytes) { this.writes.push(Buffer.from(bytes)); }
  end() { this.emit('close'); }
}

function serverText(value) {
  const bytes = Buffer.from(value);
  assert.ok(bytes.length < 126);
  return Buffer.concat([Buffer.from([0x81, bytes.length]), bytes]);
}

test('webOS state stays outside the repository and requires a pairing key', () => {
  assert.match(webOsStatePath({ LOCALAPPDATA: 'C:\\Temp' }), /AndroidRemoteLab[\\/]webos-client-key\.json$/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webos-state-'));
  const file = path.join(directory, 'state.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ host: '192.0.2.1', fingerprint: 'a'.repeat(64) }));
    assert.throws(() => readWebOsState(file), /pairing key is missing/);
    fs.writeFileSync(file, JSON.stringify({
      host: '192.0.2.1', fingerprint: 'a'.repeat(64), clientKey: 'secret',
    }));
    assert.equal(readWebOsState(file).clientKey, 'secret');
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

test('webOS frames are masked on send and reassembled on receive', async () => {
  const socket = new FakeSocket();
  const connection = new WebOsSocket(socket);
  connection.send({ type: 'hello' });
  const frame = socket.writes[0];
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1] & 0x80, 0x80);
  const payload = Buffer.from(frame.subarray(6));
  for (let i = 0; i < payload.length; i += 1) payload[i] ^= frame[2 + (i & 3)];
  assert.deepEqual(JSON.parse(payload.toString('utf8')), { type: 'hello' });

  const reply = serverText('{"type":"registered"}');
  const pending = connection.receive();
  socket.emit('data', reply.subarray(0, 3));
  socket.emit('data', reply.subarray(3));
  assert.deepEqual(JSON.parse(await pending), { type: 'registered' });
  connection.close();
});

test('webOS close reason rejects a pending response', async () => {
  const socket = new FakeSocket();
  const connection = new WebOsSocket(socket);
  const pending = connection.receive();
  const reason = Buffer.from('invalid origin');
  socket.emit('data', Buffer.concat([
    Buffer.from([0x88, reason.length + 2, 0x03, 0xf0]), reason,
  ]));
  await assert.rejects(pending, /invalid origin/);
});

test('pointer socket remains on the paired TV and secure port', () => {
  assert.equal(webOsSocketPath('wss://192.0.2.1:3001/resources/id/netinput.pointer.sock', '192.0.2.1'),
    '/resources/id/netinput.pointer.sock');
  assert.throws(() => webOsSocketPath('wss://192.0.2.2:3001/resources/id/netinput.pointer.sock', '192.0.2.1'),
    /outside the paired TV/);
  assert.throws(() => webOsSocketPath('ws://192.0.2.1:3000/resources/id/netinput.pointer.sock', '192.0.2.1'),
    /outside the paired TV/);
});

test('panel-off uses the modern endpoint and verifies Screen Off without audio control', async () => {
  const calls = [];
  let state = 'Active';
  const connection = { async request(uri, payload) {
    calls.push({ uri, payload });
    if (uri.endsWith('/getPowerState')) return reply({ state });
    if (uri === 'com.webos.service.tvpower/power/turnOffScreen') {
      state = 'Screen Off';
      return reply({});
    }
    throw new Error(`Unexpected request: ${uri}`);
  } };
  const result = await turnOffWebOsScreen({ connect: (action) => action(connection), sleep: async () => {} });
  assert.deepEqual(result, { changed: true, verified: true, state: 'Screen Off',
    command: 'com.webos.service.tvpower/power/turnOffScreen' });
  assert.ok(!calls.some(({ uri }) => /audio|volume|mute|changeSoundOutput/i.test(uri)));
});

test('panel-off falls back to the webOS 4 service name and never wakes a powered-off TV', async () => {
  let state = 'Active';
  const calls = [];
  const connection = { async request(uri, payload) {
    calls.push({ uri, payload });
    if (uri.endsWith('/getPowerState')) return reply({ state });
    if (uri === 'com.webos.service.tvpower/power/turnOffScreen') {
      return { type: 'error', error: '404 no such service' };
    }
    if (uri === 'com.webos.service.tv.power/turnOffScreen') {
      assert.deepEqual(payload, { standbyMode: 'active' });
      state = 'Screen Off';
      return reply({});
    }
    throw new Error(`Unexpected request: ${uri}`);
  } };
  assert.equal((await turnOffWebOsScreen({ connect: (action) => action(connection),
    sleep: async () => {} })).verified, true);

  state = 'Active Standby';
  calls.length = 0;
  const inactive = await turnOffWebOsScreen({ connect: (action) => action(connection) });
  assert.deepEqual(inactive, { changed: false, verified: false, state: 'Active Standby',
    command: null, reason: 'tv-not-active' });
  assert.equal(calls.length, 1);
});

function reply(fields) { return { type: 'response', payload: { returnValue: true, ...fields } }; }
