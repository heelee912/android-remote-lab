import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requestWebOsLuna } from '../src/webos-luna.mjs';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'webos-luna-'));
const identityFile = path.join(fixture, 'key');
const knownHostsFile = path.join(fixture, 'known_hosts');
fs.writeFileSync(identityFile, 'test key');
fs.writeFileSync(knownHostsFile, 'test host');
const state = { host: '192.0.2.1' };
const config = { user: 'root', port: 22, identityFile, knownHostsFile };

test.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

test('Luna SSH pins the host key and safely quotes payload without local shell', async () => {
  let invocation;
  const result = await requestWebOsLuna('luna://com.example.service/read', { text: "'; touch /tmp/x; echo '" },
    { state, config, execute: async (...args) => { invocation = args; return { stdout: '{"returnValue":true}' }; } });
  assert.equal(result.response.returnValue, true);
  assert.equal(invocation[0], 'ssh');
  assert.ok(invocation[1].includes('StrictHostKeyChecking=yes'));
  assert.ok(invocation[1].includes(`UserKnownHostsFile=${knownHostsFile}`));
  assert.match(invocation[1].at(-1), /^luna-send -n 1 -f /);
  assert.match(invocation[1].at(-1), /'\\''/);
  assert.equal(invocation[2].windowsHide, true);
});

test('prisoner uses public Luna access and failures remain failures', async () => {
  await assert.rejects(requestWebOsLuna('luna://com.example.service/read', {}, {
    state, config: { ...config, user: 'prisoner', port: 9922 },
    execute: async (_command, args) => {
      assert.match(args.at(-1), /^luna-send-pub /);
      return { stdout: '{"returnValue":false,"errorText":"permission denied"}' };
    },
  }), /permission denied/);
  await assert.rejects(requestWebOsLuna('luna://service/read;id', {}, { state, config }), /Luna URI/);
  await assert.rejects(requestWebOsLuna('luna://service/read', {}, {
    state, config, execute: async () => { throw new Error('connection lost'); },
  }), /outcome may be unconfirmed/);
});
