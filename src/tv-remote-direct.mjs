import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const MAX_FRAME_BYTES = 65_536;
const PAIRING_PORT = 6467;
const CONTROL_PORT = 6466;
const DESIRED_FEATURES = 1 | 2 | 32 | 64 | 512;
const KEY_CODES = Object.freeze({
  home: 3, back: 4, dpad_up: 19, dpad_down: 20, dpad_left: 21,
  dpad_right: 22, dpad_center: 23, enter: 66, menu: 82,
});

function varint(value) {
  const bytes = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function readVarint(bytes, offset) {
  let value = 0n;
  for (let shift = 0n; shift < 63n; shift += 7n) {
    if (offset.index >= bytes.length) return null;
    const byte = bytes[offset.index++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return Number(value);
  }
  throw new Error('TV remote varint is too long');
}

function fieldNumber(field, value) {
  return Buffer.concat([varint(field << 3), varint(value)]);
}

function fieldBytes(field, value) {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
}

function fieldText(field, value) {
  return fieldBytes(field, Buffer.from(value, 'utf8'));
}

function message(...fields) {
  return Buffer.concat(fields);
}

function parseFields(bytes) {
  const fields = new Map();
  const offset = { index: 0 };
  while (offset.index < bytes.length) {
    const tag = readVarint(bytes, offset);
    const field = tag >> 3;
    const wire = tag & 7;
    if (!field || (wire !== 0 && wire !== 2)) throw new Error('Invalid TV remote field');
    let value;
    if (wire === 0) value = readVarint(bytes, offset);
    else {
      const length = readVarint(bytes, offset);
      if (length === null || length > bytes.length - offset.index) throw new Error('Invalid TV remote field length');
      value = bytes.subarray(offset.index, offset.index + length);
      offset.index += length;
    }
    fields.set(field, value);
  }
  return fields;
}

function der(tag, bytes) {
  const length = bytes.length < 128 ? Buffer.from([bytes.length]) : (() => {
    const chunks = [];
    for (let remaining = bytes.length; remaining; remaining >>>= 8) chunks.unshift(remaining & 0xff);
    return Buffer.from([0x80 | chunks.length, ...chunks]);
  })();
  return Buffer.concat([Buffer.from([tag]), length, bytes]);
}

function derSequence(...values) { return der(0x30, Buffer.concat(values)); }
function derInteger(bytes) {
  const positive = bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return der(0x02, positive);
}
function derOid(bytes) { return der(0x06, Buffer.from(bytes)); }
function derPem(label, bytes) {
  const base64 = bytes.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

export function generateTvIdentity(now = new Date()) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signatureAlgorithm = derSequence(
    derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), der(0x05, Buffer.alloc(0)));
  const commonName = derSequence(der(0x31, derSequence(
    derOid([0x55, 0x04, 0x03]), der(0x0c, Buffer.from('Android Remote Lab PC')))));
  const time = (date) => der(0x17, Buffer.from(
    `${String(date.getUTCFullYear()).slice(-2)}${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    + `${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}`
    + `${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}Z`));
  const validFrom = new Date(now.getTime() - 86_400_000);
  const validTo = new Date(now.getTime() + 10 * 365 * 86_400_000);
  const basicConstraints = derSequence(derOid([0x55, 0x1d, 0x13]), der(0x04, derSequence()));
  const tbs = derSequence(
    der(0xa0, derInteger(Buffer.from([2]))), derInteger(crypto.randomBytes(16)), signatureAlgorithm,
    commonName, derSequence(time(validFrom), time(validTo)), commonName,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, derSequence(basicConstraints)));
  const signature = crypto.sign('sha256', tbs, privateKey);
  const certificate = derSequence(tbs, signatureAlgorithm,
    der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const parsed = new crypto.X509Certificate(certificate);
  if (!parsed.verify(publicKey)) throw new Error('Generated TV remote certificate failed verification');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: derPem('CERTIFICATE', certificate),
  };
}

function deviceDirectory(deviceId) {
  if (!/^[a-f0-9]{32}$/.test(deviceId || '')) throw new Error('A full selected ARLab device ID is required');
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
    'AndroidRemoteLab', 'tv-remote-direct', deviceId);
}

function identity(directory) {
  const saved = path.join(directory, 'client-identity.json');
  if (fs.existsSync(saved)) return JSON.parse(fs.readFileSync(saved, 'utf8'));
  const oldKey = path.join(directory, 'client-key.pem');
  const oldCert = path.join(directory, 'client-cert.pem');
  if (fs.existsSync(oldKey) && fs.existsSync(oldCert)) {
    return { key: fs.readFileSync(oldKey, 'utf8'), cert: fs.readFileSync(oldCert, 'utf8') };
  }
  if (fs.existsSync(oldKey) || fs.existsSync(oldCert)) throw new Error('Incomplete TV remote identity');
  const generated = generateTvIdentity();
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(saved, JSON.stringify(generated), { flag: 'wx', mode: 0o600 });
  return generated;
}

function certificateHash(raw) { return crypto.createHash('sha256').update(raw).digest('hex'); }
function publicParts(certificate) {
  const jwk = new crypto.X509Certificate(certificate).publicKey.export({ format: 'jwk' });
  return [Buffer.from(jwk.n, 'base64url'), Buffer.from(jwk.e, 'base64url')];
}

class TvFrames {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.closed = null;
    socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.flush(); });
    socket.on('error', (error) => this.close(error));
    socket.on('end', () => this.close(new Error('TV remote stream closed')));
    socket.on('close', () => this.close(new Error('TV remote connection closed')));
  }

  flush() {
    while (this.pending.length) {
      const offset = { index: 0 };
      let length;
      try { length = readVarint(this.buffer, offset); }
      catch (error) { this.close(error); return; }
      if (length === null) return;
      if (length > MAX_FRAME_BYTES) { this.close(new Error('TV remote frame is too large')); return; }
      if (this.buffer.length < offset.index + length) return;
      const frame = this.buffer.subarray(offset.index, offset.index + length);
      this.buffer = this.buffer.subarray(offset.index + length);
      this.pending.shift().resolve(parseFields(frame));
    }
  }

  close(error) {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.splice(0)) pending.reject(error);
  }

  receive() {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => { this.pending.push({ resolve, reject }); this.flush(); });
  }

  send(bytes) {
    if (bytes.length > MAX_FRAME_BYTES) throw new Error('TV remote frame is too large');
    return new Promise((resolve, reject) => {
      this.socket.write(message(varint(bytes.length), bytes), (error) => error ? reject(error) : resolve());
    });
  }
}

function connect(host, port, credentials, expectedHash) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, key: credentials.key, cert: credentials.cert,
      rejectUnauthorized: false, timeout: 15000 }, () => {
      const peer = socket.getPeerCertificate(true).raw;
      if (!peer || (expectedHash && certificateHash(peer) !== expectedHash)) {
        socket.destroy();
        reject(new Error('TV remote server certificate does not match the paired device'));
        return;
      }
      socket.setTimeout(15000);
      resolve({ socket, peer, frames: new TvFrames(socket) });
    });
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('TV remote TLS timed out')));
  });
}

function pairingOuter(field, payload) {
  return message(fieldNumber(1, 2), fieldNumber(2, 200), fieldBytes(field, payload));
}

function requirePairingSuccess(fields) {
  if (fields.get(1) !== 2 || fields.get(2) !== 200) throw new Error('TV remote pairing rejected');
}

export async function pairTvRemote(deviceId, host, readCode, options = {}) {
  const directory = deviceDirectory(deviceId);
  const credentials = identity(directory);
  const { socket, peer, frames } = await connect(host, options.port || PAIRING_PORT, credentials);
  try {
    await frames.send(pairingOuter(10, message(fieldText(1, 'atvremote'),
      fieldText(2, 'Android Remote Lab PC'))));
    let configured = false;
    for (let index = 0; index < 8; index++) {
      const reply = await frames.receive();
      requirePairingSuccess(reply);
      const encoding = message(fieldNumber(1, 3), fieldNumber(2, 6));
      if (reply.has(11)) await frames.send(pairingOuter(20,
        message(fieldBytes(1, encoding), fieldNumber(3, 1))));
      else if (reply.has(20)) await frames.send(pairingOuter(30,
        message(fieldBytes(1, encoding), fieldNumber(2, 1))));
      else if (reply.has(31)) { configured = true; break; }
      else throw new Error('Unexpected TV remote pairing response');
    }
    if (!configured) throw new Error('TV did not show a pairing code');
    socket.setTimeout(0); // Keep the TV's code prompt open while the user reads it.
    const code = String(await readCode()).trim().toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(code)) throw new Error('TV pairing code must be six hexadecimal characters');
    const codeBytes = Buffer.from(code, 'hex');
    const parts = [...publicParts(credentials.cert), ...publicParts(peer), codeBytes.subarray(1)];
    const secret = crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
    if (secret[0] !== codeBytes[0]) throw new Error('TV pairing code did not match this certificate');
    socket.setTimeout(15000);
    await frames.send(pairingOuter(40, fieldBytes(1, secret)));
    const reply = await frames.receive();
    requirePairingSuccess(reply);
    if (!reply.has(41)) throw new Error('TV did not acknowledge pairing');
    const record = { route: options.route || 'direct',
      host: options.route === 'companion-tunnel' ? null : host,
      serverCertificateSha256: certificateHash(peer) };
    fs.writeFileSync(path.join(directory, 'pairing.json'), JSON.stringify(record), { mode: 0o600 });
    return { paired: true, serverCertificateSha256: record.serverCertificateSha256 };
  } finally { socket.destroy(); }
}

export async function pressTvRemote(deviceId, key, endpoint = null) {
  const keyCode = KEY_CODES[key];
  if (keyCode === undefined) throw new Error('Unsupported TV remote key');
  const directory = deviceDirectory(deviceId);
  const record = JSON.parse(fs.readFileSync(path.join(directory, 'pairing.json'), 'utf8'));
  const credentials = identity(directory);
  const host = endpoint?.host || record.host;
  if (!host) throw new Error('The paired TV requires the Companion tunnel');
  const { socket, frames } = await connect(host, endpoint?.port || CONTROL_PORT,
    credentials, record.serverCertificateSha256);
  try {
    let activeFeatures = 0;
    let started = false;
    for (let index = 0; index < 16; index++) {
      const reply = await frames.receive();
      if (reply.has(1)) {
        const offered = parseFields(reply.get(1)).get(1) || 0;
        activeFeatures = offered & DESIRED_FEATURES;
        if (!(activeFeatures & 2)) throw new Error('TV remote service does not support key input');
        const deviceInfo = message(fieldNumber(3, 1), fieldText(4, '1'),
          fieldText(5, 'com.codex.remotecompanion'), fieldText(6, '1.0'));
        await frames.send(fieldBytes(1, message(fieldNumber(1, activeFeatures),
          fieldBytes(2, deviceInfo))));
      } else if (reply.has(2)) {
        await frames.send(fieldBytes(2, fieldNumber(1, activeFeatures)));
      } else if (reply.has(8)) {
        const ping = parseFields(reply.get(8)).get(1) || 0;
        await frames.send(fieldBytes(9, fieldNumber(1, ping)));
      } else if (reply.has(40)) { started = true; break; }
      else if (reply.has(3)) throw new Error('TV remote service rejected the session');
    }
    if (!started) throw new Error('TV remote session did not start');
    await frames.send(fieldBytes(10, message(fieldNumber(1, keyCode), fieldNumber(2, 3))));
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { dispatched: true, key };
  } finally { socket.destroy(); }
}
