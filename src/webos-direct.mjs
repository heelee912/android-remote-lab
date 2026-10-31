import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const SCREEN_OFF_ENDPOINTS = Object.freeze([
  { uri: 'com.webos.service.tvpower/power/turnOffScreen', payload: {} },
  // webOS 4 uses the older service name and requires active standby mode.
  { uri: 'com.webos.service.tv.power/turnOffScreen', payload: { standbyMode: 'active' } },
]);
const SCREEN_ACTIVE_STATES = new Set(['Active']);
const PERMISSIONS = Object.freeze([
  'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_TV',
  'CONTROL_MOUSE_AND_KEYBOARD', 'CONTROL_POWER', 'CONTROL_TV_SCREEN',
  'LAUNCH', 'READ_APP_STATUS', 'READ_CURRENT_CHANNEL',
  'READ_INPUT_DEVICE_LIST', 'READ_INSTALLED_APPS', 'READ_NETWORK_STATE',
  'READ_POWER_STATE', 'READ_RUNNING_APPS', 'READ_SETTINGS', 'WRITE_SETTINGS',
]);

export function webOsStatePath(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'AndroidRemoteLab', 'webos-client-key.json');
}

function validateHost(host) {
  if (net.isIP(host) !== 4) throw new Error('webOS host must be an IPv4 address');
  return host;
}

function validateFingerprint(fingerprint) {
  if (!/^[a-f0-9]{64}$/i.test(fingerprint || '')) {
    throw new Error('webOS certificate fingerprint must be 64 hexadecimal characters');
  }
  return fingerprint.toLowerCase();
}

export function readWebOsState(file = webOsStatePath()) {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateHost(state.host);
  validateFingerprint(state.fingerprint);
  if (typeof state.clientKey !== 'string' || !state.clientKey) {
    throw new Error('webOS pairing key is missing');
  }
  return state;
}

function registration(clientKey) {
  return {
    type: 'register', id: 'register_0', payload: {
      'client-key': clientKey,
      forcePairing: false,
      manifest: {
        appVersion: '1.1', manifestVersion: 1,
        deviceName: 'Android Remote Lab', permissions: PERMISSIONS,
      },
      pairingType: 'PROMPT',
    },
  };
}

function websocketFrame(opcode, bytes) {
  if (bytes.length > MAX_FRAME_BYTES) throw new Error('webOS message is too large');
  const headerSize = bytes.length < 126 ? 2 : bytes.length <= 0xffff ? 4 : 10;
  const frame = Buffer.alloc(headerSize + 4 + bytes.length);
  frame[0] = 0x80 | opcode;
  if (headerSize === 2) frame[1] = 0x80 | bytes.length;
  else if (headerSize === 4) { frame[1] = 0xfe; frame.writeUInt16BE(bytes.length, 2); }
  else { frame[1] = 0xff; frame.writeBigUInt64BE(BigInt(bytes.length), 2); }
  const mask = crypto.randomBytes(4);
  mask.copy(frame, headerSize);
  for (let i = 0; i < bytes.length; i += 1) frame[headerSize + 4 + i] = bytes[i] ^ mask[i & 3];
  return frame;
}

export class WebOsSocket {
  constructor(socket, initialBytes = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = initialBytes;
    this.messages = [];
    this.waiters = [];
    this.fragment = [];
    this.closed = false;
    socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    socket.on('close', () => this.fail(new Error('webOS connection closed')));
    socket.on('error', (error) => this.fail(error));
    this.parse();
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  parse() {
    while (this.buffer.length >= 2 && !this.closed) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let offset = 2;
      let size = second & 0x7f;
      if (size === 126) {
        if (this.buffer.length < 4) return;
        size = this.buffer.readUInt16BE(2); offset = 4;
      } else if (size === 127) {
        if (this.buffer.length < 10) return;
        const large = this.buffer.readBigUInt64BE(2);
        if (large > BigInt(MAX_FRAME_BYTES)) return this.fail(new Error('webOS frame is too large'));
        size = Number(large); offset = 10;
      }
      if (size > MAX_FRAME_BYTES) return this.fail(new Error('webOS frame is too large'));
      const masked = Boolean(second & 0x80);
      const needed = offset + (masked ? 4 : 0) + size;
      if (this.buffer.length < needed) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + size));
      this.buffer = this.buffer.subarray(needed);
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      const opcode = first & 0x0f;
      if (opcode === 8) {
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : 'closed';
        this.fail(new Error(`webOS closed connection: ${reason}`));
      } else if (opcode === 9) this.socket.write(websocketFrame(10, payload));
      else if (opcode === 1 || opcode === 0) {
        this.fragment.push(payload);
        if (first & 0x80) {
          const message = Buffer.concat(this.fragment).toString('utf8');
          this.fragment = [];
          const waiter = this.waiters.shift();
          if (waiter) waiter.resolve(message);
          else this.messages.push(message);
        }
      }
    }
  }

  send(value) {
    if (this.closed) throw new Error('webOS connection is closed');
    this.socket.write(websocketFrame(1, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))));
  }

  receive(timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    if (this.closed) return Promise.reject(new Error('webOS connection is closed'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('webOS response timed out'));
      }, timeoutMs);
      waiter.resolve = (value) => { clearTimeout(timer); resolve(value); };
      waiter.reject = (error) => { clearTimeout(timer); reject(error); };
    });
  }

  async request(uri, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = crypto.randomUUID();
    this.send({ type: 'request', id, uri: uri.startsWith('ssap://') ? uri : `ssap://${uri}`, payload });
    while (true) {
      const message = JSON.parse(await this.receive(timeoutMs));
      if (message.id === id) return message;
    }
  }

  close() { this.socket.end(); }
}

export async function inspectWebOsHost(host) {
  const { socket, fingerprint, subject } = await openTls(validateHost(host));
  socket.end();
  return { host, fingerprint, subject };
}

function openTls(host, expectedFingerprint = null) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 3001, rejectUnauthorized: false });
    const timer = setTimeout(() => socket.destroy(new Error('webOS TLS connection timed out')), DEFAULT_TIMEOUT_MS);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const certificate = socket.getPeerCertificate(true);
      const fingerprint = crypto.createHash('sha256').update(certificate.raw).digest('hex');
      if (expectedFingerprint && fingerprint !== validateFingerprint(expectedFingerprint)) {
        socket.destroy();
        reject(new Error('webOS certificate changed; refusing to send pairing key'));
        return;
      }
      resolve({ socket, fingerprint, subject: certificate.subject });
    });
    socket.once('error', reject);
  });
}

export function webOsSocketPath(socketUrl, host) {
  return webOsResourcePath(socketUrl, host, 'wss:');
}

function webOsResourcePath(resourceUrl, host, protocol) {
  const url = new URL(resourceUrl);
  if (url.protocol !== protocol || url.hostname !== validateHost(host) || url.port !== '3001'
      || !url.pathname.startsWith('/resources/') || url.search || url.hash) {
    throw new Error('webOS resource is outside the paired TV');
  }
  return url.pathname;
}

export async function connectWebOs(host, expectedFingerprint, socketPath = '/') {
  if (!/^\/(?:[a-zA-Z0-9._~!$&'()*+,;=:@%/-]*)$/.test(socketPath)) {
    throw new Error('Invalid webOS WebSocket path');
  }
  const { socket } = await openTls(validateHost(host), expectedFingerprint);
  const nonce = crypto.randomBytes(16).toString('base64');
  const accept = crypto.createHash('sha1')
    .update(`${nonce}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(`GET ${socketPath} HTTP/1.1\r\nHost: ${host}:3001\r\nUpgrade: websocket\r\n`
    + `Connection: Upgrade\r\nSec-WebSocket-Key: ${nonce}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('webOS WebSocket handshake timed out')), DEFAULT_TIMEOUT_MS);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      if (error) { socket.destroy(); reject(error); }
      else resolve(value);
    };
    const onError = (error) => finish(error);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 16_384) return finish(new Error('webOS handshake is too large'));
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const header = buffer.subarray(0, end).toString('ascii');
      const accepted = header.split('\r\n').some((line) =>
        /^sec-websocket-accept\s*:/i.test(line)
        && line.split(':', 2)[1].trim() === accept);
      if (!/^HTTP\/1\.1 101\b/.test(header)
          || !accepted) {
        return finish(new Error('webOS WebSocket handshake was rejected'));
      }
      finish(null, new WebOsSocket(socket, buffer.subarray(end + 4)));
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

export async function registerWebOs(connection, clientKey = null, timeoutMs = 60_000) {
  connection.send(registration(clientKey));
  for (let i = 0; i < 3; i += 1) {
    const response = JSON.parse(await connection.receive(timeoutMs));
    if (response.type === 'registered') {
      const key = response.payload?.['client-key'] || clientKey;
      if (!key) throw new Error('webOS registration did not return a key');
      return { clientKey: key };
    }
    if (response.type === 'error') throw new Error(response.error || 'webOS registration rejected');
    if (response.type !== 'response' || response.payload?.pairingType !== 'PROMPT') {
      throw new Error('Unexpected webOS registration response');
    }
  }
  throw new Error('webOS registration was not completed');
}

export async function pairWebOs(host, fingerprint, file = webOsStatePath()) {
  const connection = await connectWebOs(host, validateFingerprint(fingerprint));
  try {
    const { clientKey } = await registerWebOs(connection);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ host, fingerprint, clientKey }), { mode: 0o600 });
    return { host, paired: true, stateFile: file };
  } finally { connection.close(); }
}

export async function withRegisteredWebOs(action, file = webOsStatePath()) {
  const state = readWebOsState(file);
  const connection = await connectWebOs(state.host, state.fingerprint);
  try {
    await registerWebOs(connection, state.clientKey);
    return await action(connection, state.host);
  } finally { connection.close(); }
}

function acceptedResponse(response) {
  return response?.type !== 'error' && response?.payload?.returnValue !== false;
}

/**
 * Turns off only the display panel. It never sends Wake-on-LAN, a power toggle,
 * an audio command, or an input command. A fully-off TV is left untouched.
 */
export async function turnOffWebOsScreen({ connect = withRegisteredWebOs,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
  return connect(async (connection) => {
    const initial = await connection.request('com.webos.service.tvpower/power/getPowerState');
    if (!acceptedResponse(initial) || typeof initial.payload?.state !== 'string') {
      throw new Error(initial?.error || initial?.payload?.errorText || 'webOS power state is unavailable');
    }
    const initialState = initial.payload.state;
    if (initialState === 'Screen Off') {
      return { changed: false, verified: true, state: initialState, command: null };
    }
    if (!SCREEN_ACTIVE_STATES.has(initialState)) {
      return { changed: false, verified: false, state: initialState,
        command: null, reason: 'tv-not-active' };
    }

    const failures = [];
    for (const endpoint of SCREEN_OFF_ENDPOINTS) {
      const response = await connection.request(endpoint.uri, endpoint.payload);
      if (!acceptedResponse(response)) {
        failures.push(response?.error || response?.payload?.errorText || `${endpoint.uri} rejected`);
        continue;
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (attempt > 0) await sleep(250);
        const readback = await connection.request('com.webos.service.tvpower/power/getPowerState');
        if (acceptedResponse(readback) && readback.payload?.state === 'Screen Off') {
          return { changed: true, verified: true, state: 'Screen Off', command: endpoint.uri };
        }
      }
      throw new Error(`webOS accepted ${endpoint.uri} but the panel-off state was not verified`);
    }
    throw new Error(`webOS panel-off command is unavailable: ${failures.join('; ')}`);
  });
}

export async function pressWebOsButton(button, file = webOsStatePath()) {
  if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(button)) {
    throw new Error('webOS button name must contain uppercase letters, digits, or underscores');
  }
  const state = readWebOsState(file);
  return withRegisteredWebOs(async (connection, host) => {
    const response = await connection.request('com.webos.service.networkinput/getPointerInputSocket');
    if (response.type === 'error' || !response.payload?.returnValue) {
      throw new Error(response.error || 'webOS pointer input is unavailable');
    }
    const pointerPath = webOsSocketPath(response.payload.socketPath, host);
    const pointer = await connectWebOs(host, state.fingerprint, pointerPath);
    try {
      pointer.send(`type:button\nname:${button}\n\n`);
      return { button, dispatched: true };
    } finally { pointer.close(); }
  }, file);
}

function downloadWebOsImage(host, fingerprint, resourcePath) {
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => {
      openTls(host, fingerprint).then(({ socket }) => callback(null, socket), callback);
    };
    const request = https.get({ host, port: 3001, path: resourcePath, agent, timeout: DEFAULT_TIMEOUT_MS }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`webOS image request failed with HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_FRAME_BYTES) {
          response.destroy(new Error('webOS screenshot is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('webOS image request timed out')));
    request.on('error', reject);
  });
}

export async function captureWebOsScreenshot(outputPath, file = webOsStatePath()) {
  if (!path.isAbsolute(outputPath) || !/\.jpe?g$/i.test(outputPath)) {
    throw new Error('webOS screenshot output must be an absolute .jpg path');
  }
  const state = readWebOsState(file);
  const response = await withRegisteredWebOs((connection) => connection.request('tv/executeOneShot'), file);
  if (response.type === 'error' || !response.payload?.returnValue) {
    throw new Error(response.error || 'webOS screenshot request failed');
  }
  const { image, imageUri } = response.payload;
  const bytes = image ? Buffer.from(image, 'base64')
    : await downloadWebOsImage(state.host, state.fingerprint,
      webOsResourcePath(imageUri, state.host, 'https:'));
  if (bytes.length < 3 || !bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    throw new Error('webOS screenshot is not a JPEG image');
  }
  fs.writeFileSync(outputPath, bytes, { flag: 'wx' });
  return { outputPath, bytes: bytes.length };
}
