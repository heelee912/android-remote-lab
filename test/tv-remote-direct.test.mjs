import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateTvIdentity, launchTvRemoteApp, pairTvRemote, pressTvRemote,
  tvRemoteConnectionRoute } from '../src/tv-remote-direct.mjs';

test('TV identity is a self-signed certificate for its private key', () => {
  const identity = generateTvIdentity();
  const certificate = new crypto.X509Certificate(identity.cert);
  const privateKey = crypto.createPrivateKey(identity.key);
  assert.equal(certificate.subject, 'CN=Android Remote Lab PC');
  assert.equal(certificate.verify(crypto.createPublicKey(privateKey)), true);
  assert.equal(certificate.checkPrivateKey(privateKey), true);
});

test('direct TV control requires a full selected device identity', async () => {
  await assert.rejects(pairTvRemote('wrong', '127.0.0.1', async () => ''),
    /full selected ARLab device ID/);
  await assert.rejects(pressTvRemote('wrong', 'home'), /full selected ARLab device ID/);
  await assert.rejects(launchTvRemoteApp('wrong', 'arlab-probe://open', 'com.example.app'),
    /full selected ARLab device ID/);
  await assert.rejects(launchTvRemoteApp('a'.repeat(32), 'com.example.app'),
    /app link URL/);
  await assert.rejects(launchTvRemoteApp('a'.repeat(32), 'arlab-probe://open', 'not a package'),
    /package name is invalid/);
});

test('TV control uses the route saved when pairing, including older direct records', () => {
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlab-tv-route-'));
  const deviceId = 'a'.repeat(32);
  const pairingDirectory = path.join(temporaryDirectory, 'AndroidRemoteLab',
    'tv-remote-direct', deviceId);
  try {
    process.env.LOCALAPPDATA = temporaryDirectory;
    assert.equal(tvRemoteConnectionRoute(deviceId), null);
    fs.mkdirSync(pairingDirectory, { recursive: true });
    const recordPath = path.join(pairingDirectory, 'pairing.json');
    fs.writeFileSync(recordPath, JSON.stringify({ route: 'companion-tunnel', host: null }));
    assert.equal(tvRemoteConnectionRoute(deviceId), 'companion-tunnel');
    fs.writeFileSync(recordPath, JSON.stringify({ route: 'direct', host: 'example.invalid' }));
    assert.equal(tvRemoteConnectionRoute(deviceId), 'direct');
    fs.writeFileSync(recordPath, JSON.stringify({ host: 'example.invalid' }));
    assert.equal(tvRemoteConnectionRoute(deviceId), 'direct');
  } finally {
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
