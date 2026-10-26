'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { loadConfig, ownerId } = require('./config.js');

const config = loadConfig();
const stateDir = process.env.ANDROID_REMOTE_LAB_STATE_DIR || config.stateDir;
const apiPort = Number(process.env.ANDROID_REMOTE_LAB_API_PORT || config.apiPort);
const token = fs.readFileSync(path.join(stateDir, 'local-api-token.txt'), 'utf8').trim();
const owner = ownerId();
const sessionDir = path.join(stateDir, 'sessions', `owner-${encodeURIComponent(owner)}`);
const automaticControlLeaseMillis = 60 * 60_000;
const minimumControlLeaseRemainingMillis = 5 * 60_000;
const explicitDeviceId = process.env.ANDROID_REMOTE_LAB_DEVICE_ID || null;
let commandDeviceId = explicitDeviceId;

function usage(error) {
  if (error) process.stderr.write(`${error}\n`);
  process.stderr.write([
    'Usage:',
    '  companion-cli.js status',
    '  companion-cli.js enroll <deviceId>',
    '  companion-cli.js snapshot [session]',
    '  companion-cli.js press <back|home|recents|notifications|quick_settings>',
    '  companion-cli.js press <dpad_up|dpad_down|dpad_left|dpad_right|dpad_center> <expectedPackage>',
    '  companion-cli.js tap <x> <y>',
    '  companion-cli.js swipe <startX> <startY> <endX> <endY> [durationMs]',
    '  companion-cli.js click <@eN|text=...|viewId=...|desc=...> [session]',
    '  companion-cli.js set-text <@eN|text=...|viewId=...|desc=...> <value> [session]',
    '  companion-cli.js open <packageName>',
    '  companion-cli.js screenshot <absolutePngPath>',
    '  companion-cli.js install <absoluteApkPath>',
    '  companion-cli.js install-status [uploadId]',
    '  companion-cli.js diagnostics',
    '  companion-cli.js adb-status [--repair]',
    '  companion-cli.js adb <jsonRequest>',
    '  companion-cli.js session-start [minutes]',
    '  companion-cli.js session-stop',
    '  companion-cli.js lease [milliseconds]',
    '  companion-cli.js release',
    '  companion-cli.js raw <command> [jsonArgs]',
  ].join('\n') + '\n');
  process.exit(error ? 2 : 0);
}

function api(method, route, body, requestTimeoutMs = 35_000) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const request = http.request({
      host: '127.0.0.1',
      port: apiPort,
      path: route,
      method,
      headers: {
        'x-companion-token': token,
        'x-companion-owner': owner,
        ...((commandDeviceId || explicitDeviceId) ? { 'x-companion-device': commandDeviceId || explicitDeviceId } : {}),
        ...(encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {}),
      },
      timeout: requestTimeoutMs,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reject(new Error(`invalid API response (${response.statusCode})`)); }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const rawError = value.error;
          const message = typeof rawError === 'string'
            ? rawError
            : rawError?.message || rawError?.code || `API HTTP ${response.statusCode}`;
          const detail = value.owner ? ` (owner=${value.owner}, expiresAt=${value.expiresAt || 'unknown'})` : '';
          const error = new Error(`${message}${detail}`);
          error.dispatchState = value.dispatchState;
          return reject(error);
        }
        resolve(value);
      });
    });
    request.on('timeout', () => request.destroy(new Error('API timeout')));
    request.on('error', reject);
    if (encoded) request.write(encoded);
    request.end();
  });
}

async function connectedStatus(timeoutMs = 30_000) {
  let status = await api('GET', '/status');
  const expectedDeviceId = commandDeviceId || status.selectedDeviceId || status.active?.deviceId;
  const reconnectDeadline = Date.now() + timeoutMs;
  while ((!status.active || status.active.versionCode === null) && expectedDeviceId && Date.now() < reconnectDeadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    status = await api('GET', '/status');
    if (status.selectedDeviceId && status.selectedDeviceId !== expectedDeviceId) throw new Error('selected-device-changed');
  }
  if (!status.active) throw new Error('device-not-connected');
  if (status.active.versionCode === null) throw new Error('device-readiness-pending');
  if (expectedDeviceId && expectedDeviceId !== status.active.deviceId) throw new Error('selected-device-changed');
  return status;
}

async function ensureControlLease(displayOnly = false, background = false, timeoutMs = 30_000) {
  const status = await connectedStatus(timeoutMs);
  commandDeviceId = status.active.deviceId;
  const expiresAt = Date.parse(status.controlLease?.expiresAt || '');
  if (status.controlLease?.owner === owner && Number.isFinite(expiresAt)
      && expiresAt - Date.now() > minimumControlLeaseRemainingMillis
      && (background || status.controlLease.background !== true)) return;
  await api('POST', '/control/start', { durationMillis: automaticControlLeaseMillis, owner,
    deviceId: commandDeviceId, displayOnly, background });
}

async function command(name, args = {}, timeoutMs = 20_000, maintainDisplayLease = true) {
  const longAdbCommand = ['adb', 'adb_pair', 'adb_bind'].includes(name);
  const apiTimeoutMs = Math.max(35_000,
    Math.min(timeoutMs + (longAdbCommand ? 210_000 : 20_000), longAdbCommand ? 900_000 : 140_000));
  const reconnectDeadline = Date.now() + 30_000;
  for (let attempt = 0; ; attempt++) {
    let submitted = false;
    try {
      if (maintainDisplayLease) await ensureControlLease(name === 'wake',
        ['adb', 'adb_pair', 'adb_bind', 'diagnostics', 'ping', 'adb_tunnel_status',
          'install_begin', 'install_chunk', 'install_commit', 'install_status'].includes(name),
        Math.max(1, reconnectDeadline - Date.now()));
      else if (!commandDeviceId) commandDeviceId = (await api('GET', '/status')).selectedDeviceId;
      submitted = true;
      return await api('POST', '/command', { command: name, args, timeoutMs, owner, deviceId: commandDeviceId }, apiTimeoutMs);
    } catch (error) {
      // The relay marks only failures before native caller dispatch. Results
      // from an executed SDK command and uncertain submissions retain one attempt.
      const notStarted = !submitted || error.dispatchState === 'not-started';
      if (name !== 'adb' || !maintainDisplayLease || !notStarted || attempt >= 2 || Date.now() >= reconnectDeadline
          || !/^(device-not-connected|device-disconnected|device-readiness-pending|control-lease-required|adb-control-lease-expired|command-timeout)$/.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
    input.on('error', reject);
  });
}

async function installApk(inputPath) {
  const file = path.resolve(inputPath || '');
  const details = fs.statSync(file, { throwIfNoEntry: false });
  if (!details?.isFile() || path.extname(file).toLowerCase() !== '.apk') {
    usage('install requires an existing absolute or relative .apk path');
  }
  if (details.size <= 0 || details.size > 512 * 1024 * 1024) {
    usage('APK size must be between 1 byte and 512 MiB');
  }
  const sha256 = await hashFile(file);
  const begin = await command('install_begin', {
    sizeBytes: details.size,
    sha256,
    fileName: path.basename(file),
  });
  if (begin.result?.permissionRequired) {
    return {
      ok: true,
      state: 'INSTALL_PERMISSION_REQUIRED',
      uploadId: sha256,
      sizeBytes: details.size,
      settingsIntentRequested: true,
    };
  }

  const uploadId = begin.result?.uploadId;
  let offset = Number(begin.result?.receivedBytes || 0);
  if (uploadId !== sha256 || offset < 0 || offset > details.size) {
    throw new Error('Companion returned invalid APK upload state');
  }
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(512 * 1024);
  try {
    while (offset < details.size) {
      const count = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, details.size - offset),
        offset);
      if (count <= 0) throw new Error('Unexpected end of APK file');
      const chunk = buffer.subarray(0, count);
      const appended = await command('install_chunk', {
        uploadId,
        offset,
        base64: chunk.toString('base64'),
        chunkSha256: crypto.createHash('sha256').update(chunk).digest('hex'),
      }, 30_000);
      const received = Number(appended.result?.receivedBytes);
      if (received !== offset + count) throw new Error('Companion APK upload offset diverged');
      offset = received;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  let committed;
  let submissionError;
  // A resumed sealed session must never be committed a second time.
  if (begin.result?.status === 'uploading') {
    try { committed = await command('install_commit', { uploadId }, 120_000); }
    catch (error) {
      if (!/^(device-not-connected|device-disconnected|command-timeout|API timeout)$/.test(error.message)) throw error;
      submissionError = error.message;
    }
  }
  const deadline = Date.now() + 10_000;
  let status;
  while (Date.now() < deadline) {
    try {
      status = (await command('install_status', { uploadId })).result;
      if (['success', 'failed', 'pending-user-action'].includes(status?.status) && status.uploadId !== uploadId) {
        throw new Error('Companion returned a different APK installation result');
      }
      if (['success', 'failed', 'pending-user-action'].includes(status?.status)) break;
    } catch (error) {
      if (!/^(device-not-connected|device-disconnected|command-timeout|API timeout|selected-device-changed)$/.test(error.message)) throw error;
      // Poll this upload on the same device after self-replacement; never resend it.
      if (error.message === 'selected-device-changed') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const states = { success: 'INSTALLED', failed: 'INSTALL_FAILED', 'pending-user-action': 'PENDING_USER_ACTION' };
  return {
    ok: true,
    state: states[status?.status] || (submissionError ? 'SUBMISSION_UNCONFIRMED' : 'SUBMITTED'),
    uploadId,
    sha256,
    sizeBytes: details.size,
    result: status || committed?.result || begin.result,
    ...(submissionError ? { submissionError } : {}),
  };
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) usage(`${label} must be numeric`);
  return number;
}

function sessionPath(name) {
  const safe = String(name || 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(sessionDir, `${safe}.json`);
}

function selectorFrom(value, session) {
  if (/^@e\d+$/.test(value)) {
    const stored = JSON.parse(fs.readFileSync(sessionPath(session), 'utf8'));
    if (explicitDeviceId && stored.deviceId !== explicitDeviceId) throw new Error('snapshot-device-mismatch');
    commandDeviceId = stored.deviceId || null;
    const node = stored.refs[value];
    if (!node) usage(`unknown element reference ${value}`);
    const identity = { expectedPackage: stored.rootPackageName, packageName: node.packageName, className: node.className };
    if (!identity.expectedPackage || !identity.packageName || !identity.className) usage('snapshot identity incomplete; capture a fresh snapshot');
    if (node.viewId) identity.viewId = node.viewId;
    if (node.text) identity.text = node.text;
    if (node.contentDescription) identity.contentDescription = node.contentDescription;
    if (node.editable === true) identity.editable = true;
    if (identity.viewId || identity.text || identity.contentDescription || identity.editable) return identity;
    usage(`${value} has no stable selector`);
  }
  const separator = value.indexOf('=');
  if (separator < 1) usage('selector must be @eN, text=, viewId=, or desc=');
  const kind = value.slice(0, separator);
  const content = value.slice(separator + 1);
  if (!content) usage('selector value cannot be empty');
  if (kind === 'text' || kind === 'viewId') return { [kind]: content };
  if (kind === 'desc') return { contentDescription: content };
  usage(`unsupported selector kind ${kind}`);
}

async function snapshot(session) {
  const response = await command('snapshot');
  const nodes = response.result?.nodes || [];
  const root = nodes.find((node) => node.id === 0) || nodes[0] || null;
  const refs = {};
  const lines = [];
  let index = 0;
  for (const node of nodes) {
    const useful = node.clickable || node.editable || node.text || node.contentDescription;
    if (!useful) continue;
    const ref = `@e${++index}`;
    refs[ref] = node;
    const label = node.text || node.contentDescription || node.viewId || node.className;
    lines.push(`${ref} ${node.className || ''} ${JSON.stringify(label || '')} [${node.left},${node.top}][${node.right},${node.bottom}]${node.clickable ? ' clickable' : ''}${node.editable ? ' editable' : ''}`);
  }
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(sessionPath(session), JSON.stringify({
    capturedAt: new Date().toISOString(),
    deviceId: commandDeviceId,
    rootPackageName: root?.packageName || null,
    rootClassName: root?.className || null,
    truncated: Boolean(response.result?.truncated),
    refs,
    nodes,
  }, null, 2));
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action || action === '--help' || action === '-h') usage();
  let result;
  switch (action) {
    case 'status': result = await api('GET', '/status'); break;
    case 'select':
      if (!args[0]) usage('deviceId is required');
      result = await api('POST', '/select', { deviceId: args[0], owner });
      break;
    case 'enroll':
      if (!args[0]) usage('deviceId is required');
      result = await api('POST', '/enroll', { deviceId: args[0] });
      break;
    case 'snapshot': await snapshot(args[0]); return;
    case 'press':
      if (!args[0]) usage('global action is required');
      result = await command('global', { action: args[0], ...(args[1] ? { expectedPackage: args[1] } : {}) });
      break;
    case 'tap': result = await command('tap', { x: finite(args[0], 'x'), y: finite(args[1], 'y') }); break;
    case 'system-input': {
      const inputArgs = JSON.parse(args[0] || '{}');
      result = await command('system_input', inputArgs, 60000);
      break;
    }
    case 'adb': {
      const request = JSON.parse(args[0] || '{}');
      result = await command('adb', request, (request.timeoutMs || 60_000) + 20_000);
      if (!result.ok) process.exitCode = Number.isInteger(result.result?.exitCode)
        && result.result.exitCode > 0 ? Math.min(result.result.exitCode, 255) : 1;
      break;
    }
    case 'adb-pair':
      if (!/^\d{6}$/.test(args[0] || '')) usage('six-digit ADB pairing code is required');
      result = await command('adb_pair', { code: args[0] }, 65_000);
      if (!result.ok) process.exitCode = 1;
      break;
    case 'adb-bind':
      result = await command('adb_bind', {}, 65_000);
      if (!result.ok) process.exitCode = 1;
      break;
    case 'swipe':
      result = await command('swipe', {
        startX: finite(args[0], 'startX'), startY: finite(args[1], 'startY'),
        endX: finite(args[2], 'endX'), endY: finite(args[3], 'endY'),
        durationMillis: args[4] === undefined ? 350 : finite(args[4], 'durationMs'),
      });
      break;
    case 'click': {
      if (!args[0]) usage('selector is required');
      const clickSelector = selectorFrom(args[0], args[1]);
      const guardIndex = args.indexOf('--guard-file');
      if (guardIndex >= 0) {
        const status = await api('GET', '/status');
        if (status.active?.supportsAtomicGuards !== true) throw new Error('Atomic UI guards unsupported; update Companion');
        const guard = JSON.parse(fs.readFileSync(args[guardIndex + 1], 'utf8'));
        if (!guard.expectedPackage || !guard.root || !Array.isArray(guard.nodes) || !guard.nodes.length) usage('invalid atomic guard');
        clickSelector.guard = guard;
      }
      result = await command('click', { selector: clickSelector });
      break;
    }
    case 'set-text': {
      if (!args[0] || args[1] === undefined) usage('selector and value are required');
      if (args[1] === '--stdin') {
        const input = fs.readFileSync(0);
        try {
          if (!input.length || input.length > 8192 || input.includes(0)) usage('invalid stdin text');
          result = await command('set_text', { selector: selectorFrom(args[0], args[2]), text: input.toString('utf8') });
          if (result?.ok !== true || result.result?.performed !== true) throw new Error('Sensitive UI input delivery not confirmed');
          result = { ok: true, result: { performed: true } };
        } finally { input.fill(0); }
      } else {
        result = await command('set_text', { selector: selectorFrom(args[0], args[2]), text: args[1] });
      }
      break;
    }
    case 'open':
      if (!args[0]) usage('package name is required');
      result = await command('launch', { packageName: args[0] });
      break;
    case 'screenshot': {
      if (!path.isAbsolute(args[0] || '')) usage('an absolute output path is required');
      const response = await command('screenshot', {}, 30_000);
      fs.mkdirSync(path.dirname(args[0]), { recursive: true });
      fs.writeFileSync(args[0], Buffer.from(response.result.base64, 'base64'));
      result = {
        ok: true,
        path: args[0],
        mimeType: response.result.mimeType,
        activeWindowBefore: response.result.activeWindowBefore || null,
        activeWindowAfter: response.result.activeWindowAfter || null,
      };
      break;
    }
    case 'install':
      result = await installApk(args[0]);
      if (result.state === 'INSTALL_FAILED') process.exitCode = 1;
      break;
    case 'install-status':
      result = await command('install_status', { uploadId: args[0] || '' });
      break;
    case 'wake': result = await command('wake'); break;
    case 'diagnostics': result = await command('diagnostics'); break;
    case 'adb-status': result = await command('adb_tunnel_status', { repair: args.includes('--repair') }); break;
    case 'session-start': {
      const minutesValue = args.find((value) => !value.startsWith('--'));
      const minutes = minutesValue === undefined ? 60 : finite(minutesValue, 'minutes');
      const status = await connectedStatus();
      result = await api('POST', '/control/start', {
        durationMillis: minutes * 60_000,
        owner,
        deviceId: status.active.deviceId,
        force: args.includes('--force'),
        background: args.includes('--background'),
      });
      break;
    }
    case 'session-stop': {
      const status = await api('GET', '/status');
      result = await api('POST', '/control/stop', { owner, deviceId: status.selectedDeviceId || status.active?.deviceId, force: args.includes('--force') });
      break;
    }
    case 'lease': result = await command('lease', { leaseMillis: args[0] === undefined ? 120_000 : finite(args[0], 'milliseconds') }, 20_000, false); break;
    case 'release': result = await command('release_lease', {}, 20_000, false); break;
    case 'raw':
      if (!args[0]) usage('command is required');
      result = await command(
        args[0],
        args[1] ? JSON.parse(args[1]) : {},
        20_000,
        args[0] !== 'lease' && args[0] !== 'release_lease');
      break;
    default: usage(`unknown action ${action}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(process.argv.includes('--stdin') ? 'Sensitive UI input failed; delivery outcome unconfirmed\n' : `${error.message || error}\n`);
  process.exitCode = 1;
});
