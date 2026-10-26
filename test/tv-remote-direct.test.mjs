import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { generateTvIdentity, pairTvRemote, pressTvRemote } from '../src/tv-remote-direct.mjs';

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
});
