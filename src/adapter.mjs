#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { loadConfig, ownerId } = require('./config.js');
const config = loadConfig();
const cli = path.join(root, 'client.js');
const stateDir = process.env.ANDROID_REMOTE_LAB_STATE_DIR || config.stateDir;
const clientEnv = { ...process.env };
if (!clientEnv.ANDROID_REMOTE_LAB_OWNER && !clientEnv.CODEX_THREAD_ID) {
  clientEnv.ANDROID_REMOTE_LAB_OWNER = `interactive-shell-${process.ppid}`;
}
const appAliases = new Map([
  ['settings', 'com.android.settings'],
  ['\uC124\uC815', 'com.android.settings'],
  ['home', 'com.sec.android.app.launcher'],
  ['chrome', 'com.android.chrome'],
  ['play-store', 'com.android.vending'],
  ['\uD50C\uB808\uC774\uC2A4\uD1A0\uC5B4', 'com.android.vending'],
]);

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArguments(argv) {
  const flags = new Set();
  const values = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (value === '--json' || value === '--settle' || value === '-i' || value === '--stdin' || value === '--as-root') {
      flags.add(value);
      continue;
    }
    if (['--session', '--guard-file', '--device', '--input', '--expect-package',
      '--timeout-ms', '--output', '--input-file', '--args-file', '--shell-file', '--as-package', '--adb-route'].includes(value)) {
      values.set(value, argv[++index] || fail(`${value} requires a value`));
      continue;
    }
    positionals.push(value);
  }
  return { flags, values, positionals };
}

function runCompanion(args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: clientEnv,
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) fail(result.error.message, 1);
  if (result.status !== 0) fail((result.stderr || result.stdout || 'Companion command failed').trim(), result.status || 1);
  return result.stdout.trim();
}

function parseCompanionJson(args, input) {
  const output = runCompanion(args, input);
  try {
    return JSON.parse(output);
  } catch {
    fail(`Invalid Companion response: ${output}`, 1);
  }
}

function safeSession(value) {
  return String(value || 'agent-device').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function selector(value) {
  if (/^@e\d+$/.test(value)) return value;
  const match = value.match(/^(?:text|label)=(?:"([\s\S]*)"|'([\s\S]*)'|([^\s]+))$/);
  if (match) return `text=${match[1] ?? match[2] ?? match[3]}`;
  const id = value.match(/^id=(?:"([\s\S]*)"|'([\s\S]*)'|([^\s]+))$/);
  if (id) return `viewId=${id[1] ?? id[2] ?? id[3]}`;
  return value;
}

function emit(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: value?.ok !== false, data: value }, null, 2)}\n`);
    return;
  }
  if (typeof value === 'string') process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function snapshot(session, json) {
  const text = runCompanion(['snapshot', session]);
  if (!json) return emit(text, false);
  const file = path.join(stateDir, 'sessions', `owner-${encodeURIComponent(clientEnv.ANDROID_REMOTE_LAB_OWNER || clientEnv.CODEX_THREAD_ID || ownerId())}`, `${safeSession(session)}.json`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodes = Object.entries(stored.refs).map(([ref, node]) => ({ ref, ...node }));
  emit({
    session,
    capturedAt: stored.capturedAt,
    deviceId: stored.deviceId || null,
    rootPackageName: stored.rootPackageName || null,
    rootClassName: stored.rootClassName || null,
    truncated: Boolean(stored.truncated),
    nodes,
    tree: stored.nodes || nodes,
  }, true);
}

function usage() {
  process.stdout.write([
    'agent-device-companion <command> [args] [--session name] [--json]',
    'Commands: devices, capabilities, connection, diagnostics, adb-status, adb-pair, adb-bind, wake, open, snapshot, press, click, fill, swipe, home, back, app-switcher, screenshot, install, install-status, adb, files, close',
    'ADB: adb [--json] [--timeout-ms 60000] [--output LOCAL_FILE] [--input-file LOCAL_FILE] -- COMMAND [ARGS...]',
    'First remote ADB authorization: adb-pair SIX_DIGIT_CODE (pairing screen must be open on the selected Android device)',
    'Resume after successful pairing: adb-bind (connects through Companion and saves the verified hardware identity)',
    'Scripts: adb --args-file ARGV_JSON_FILE or adb --shell-file UTF8_SCRIPT_FILE [--json]',
    'Files: files list|stat|read REMOTE_PATH [--output LOCAL_FILE]; files pull REMOTE_PATH LOCAL_PATH; files push LOCAL_PATH REMOTE_PATH',
    'Private file read: files read REMOTE_PATH --as-package PACKAGE or --as-root (existing Android permission required)',
    'Directional press: dpad-up/down/left/right/center or enter --expect-package PACKAGE (Companion 1.1.8+, Android 13+)',
    'Coordinate click/press/swipe: --input adb --expect-package PACKAGE (configured authorized ADB target required)',
  ].join('\n') + '\n');
}

const parsed = parseArguments(process.argv.slice(2));
if (parsed.values.has('--device')) {
  const deviceId = parsed.values.get('--device');
  if (!/^[a-f0-9]{32}$/.test(deviceId)) fail('--device requires a full device ID');
  clientEnv.ANDROID_REMOTE_LAB_DEVICE_ID = deviceId;
}
const [command, ...args] = parsed.positionals;
const json = parsed.flags.has('--json');
const session = safeSession(parsed.values.get('--session'));
const inputTransport = parsed.values.get('--input') || 'accessibility';
if (parsed.values.has('--adb-route') && (!['adb', 'files'].includes(command)
    || !['auto', 'direct', 'companion'].includes(parsed.values.get('--adb-route')))) {
  fail('--adb-route requires adb/files and one of auto, direct, companion');
}
if (!['accessibility', 'adb'].includes(inputTransport)) fail('--input must be accessibility or adb');
if (inputTransport === 'adb' && !['click', 'press', 'swipe'].includes(command)) fail('--input adb supports coordinate click/press and swipe only');
if (inputTransport === 'adb' && parsed.values.has('--guard-file')) fail('--input adb does not support atomic accessibility guards');

function systemInput(action, coordinates) {
  const expectedPackage = parsed.values.get('--expect-package');
  if (!expectedPackage) fail('--input adb requires --expect-package');
  return parseCompanionJson(['system-input', JSON.stringify({ action, ...coordinates, expectedPackage })]);
}

function adbCommand(argv, extra = {}) {
  const request = { argv, cwd: process.cwd(), ...extra,
    ...(parsed.values.has('--adb-route') ? { route: parsed.values.get('--adb-route') } : {}),
    timeoutMs: Number(parsed.values.get('--timeout-ms') || 60_000),
    ...(parsed.values.has('--output') ? { outputFile: path.resolve(parsed.values.get('--output')) } : {}),
    ...(parsed.values.has('--input-file') ? { inputFile: path.resolve(parsed.values.get('--input-file')) } : {}) };
  const child = spawnSync(process.execPath, [cli, 'adb', JSON.stringify(request)], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true, env: clientEnv, maxBuffer: 32 * 1024 * 1024,
  });
  if (child.error) fail(child.error.message, 1);
  let response;
  try { response = JSON.parse(child.stdout); }
  catch { fail((child.stderr || 'Invalid ADB response').trim(), child.status || 1); }
  emit(response, json);
  process.exitCode = child.status ?? 1;
}

function adbArguments(args) {
  const argsFile = parsed.values.get('--args-file');
  const shellFile = parsed.values.get('--shell-file');
  if ((argsFile && shellFile) || ((argsFile || shellFile) && args.length)) {
    fail('use exactly one of command arguments, --args-file, or --shell-file');
  }
  const readText = file => fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, '');
  if (shellFile) return ['shell', readText(shellFile).replace(/\r\n/g, '\n')];
  if (!argsFile) return args;
  let argv;
  try { argv = JSON.parse(readText(argsFile)); }
  catch { fail('--args-file must contain a UTF-8 JSON array of argument strings'); }
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string')) {
    fail('--args-file must contain a nonempty JSON array of argument strings');
  }
  return argv;
}

function fileCommand([action, source, destination, ...extra]) {
  if (!source || extra.length) fail('files requires an action and its exact path arguments');
  const accessPackage = parsed.values.get('--as-package');
  const asRoot = parsed.flags.has('--as-root');
  if ((accessPackage || asRoot) && action !== 'read') fail('--as-package/--as-root currently require files read');
  if (accessPackage && asRoot) fail('choose either --as-package or --as-root');
  // ADB joins shell arguments on Android. Quote each path for that shell, including
  // spaces, apostrophes and metacharacters; never run file paths as shell programs.
  const remotePath = value => {
    if (!value.startsWith('/') || value.includes('\0')) fail('remote file path must be absolute');
    return `'${value.replaceAll("'", "'\\''")}'`;
  };
  if (['list', 'stat', 'read'].includes(action)) {
    if (destination) fail('use --output LOCAL_FILE to save read output');
    if (action === 'read') {
      remotePath(source);
      return adbCommand(['pull'], { readRemotePath: source,
        ...(accessPackage ? { accessPackage } : {}), ...(asRoot ? { asRoot: true } : {}) });
    }
    const commands = { list: ['shell', 'ls', '-la', '--'], stat: ['shell', 'stat', '--'] };
    return adbCommand([...commands[action], remotePath(source)]);
  }
  if (!destination) fail('files pull/push requires source and destination');
  if (action === 'pull') {
    remotePath(source);
    return adbCommand(['pull', source, path.resolve(destination)]);
  }
  if (action === 'push') {
    remotePath(destination);
    return adbCommand(['push', path.resolve(source), destination]);
  }
  fail(`Unsupported file action: ${action}`);
}
if (!command || command === '--help' || command === '-h' || command === 'help') {
  usage();
  process.exit(0);
}

switch (command) {
  case 'devices': {
    const status = parseCompanionJson(['status']);
    const devices = (status.connectedDevices || (status.active ? [status.active] : [])).map((device) => ({
      id: device.deviceId,
      selected: device.deviceId === (status.selectedDeviceId || status.active?.deviceId),
      name: 'Enrolled Android device',
      platform: 'android',
      transport: 'companion',
    }));
    emit({ devices }, json);
    break;
  }
  case 'capabilities':
    emit({ availableCommands: ['diagnostics', 'adb-status', 'adb-pair', 'adb-bind', 'wake', 'open', 'snapshot', 'press', 'click', 'fill', 'swipe', 'home', 'back', 'app-switcher', 'screenshot', 'install', 'install-status', 'adb', 'files', 'close'],
      adb: { transport: 'companion-tunnel (Companion 1.2.0+) or configured direct ADB', deviceBinding: 'hardware-serial',
        status: 'adb-status [--repair]', minimumTunnelVersionCode: 16,
        firstRemotePairing: 'adb-pair SIX_DIGIT_CODE; adb-bind resumes a successful pair if binding was interrupted',
        minimumPairingVersionCode: 26,
        routeSelection: 'auto: verified direct ADB, then Companion tunnel on pre-dispatch connection failure',
        routeOverride: '--adb-route auto|direct|companion',
        requiresUnlockedScreen: false, requiresDisplayWake: false,
        fileActions: ['list', 'stat', 'read', 'pull', 'push'], maximumTimeoutMs: 600000,
        privateFiles: 'Android shell permissions; run-as/root required for protected app data',
        privateFileAccess: { shell: true, runAs: '--as-package PACKAGE (debuggable app required)',
          root: '--as-root (existing su authorization required; does not root the phone)' } },
      background: { commands: ['adb', 'files', 'diagnostics', 'adb-status', 'install', 'install-status'], automatic: true,
        session: 'arlab session start --background', preflight: 'arlab doctor --background --json',
        readiness: 'BACKGROUND_READY', uiReadinessSeparate: true } }, json);
    break;
  case 'adb': adbCommand(adbArguments(args)); break;
  case 'adb-pair': {
    if (args.length !== 1 || !/^\d{6}$/.test(args[0])) fail('adb-pair requires the six-digit code shown on the selected device');
    const child = spawnSync(process.execPath, [cli, 'adb-pair', args[0]], {
      cwd: process.cwd(), encoding: 'utf8', windowsHide: true, env: clientEnv,
      maxBuffer: 1024 * 1024,
    });
    if (child.error) fail(child.error.message, 1);
    let response;
    try { response = JSON.parse(child.stdout); }
    catch { fail((child.stderr || 'Invalid ADB pairing response').trim(), child.status || 1); }
    emit(response, json);
    process.exitCode = child.status ?? 1;
    break;
  }
  case 'adb-bind':
    emit(parseCompanionJson(['adb-bind']), json);
    break;
  case 'files': fileCommand(args); break;
  case 'connection':
  case 'status':
    emit(parseCompanionJson(['status']), json);
    break;
  case 'wake':
    emit(parseCompanionJson(['wake']), json);
    break;
  case 'diagnostics':
    emit(parseCompanionJson(['diagnostics']), json);
    break;
  case 'adb-status':
    emit(parseCompanionJson(['adb-status', ...(args.includes('--repair') ? ['--repair'] : [])]), json);
    break;
  case 'open': {
    if (!args[0]) fail('open requires a package or supported app alias');
    const target = appAliases.get(args[0].toLowerCase()) || appAliases.get(args[0]) || args[0];
    emit(parseCompanionJson(['open', target]), json);
    break;
  }
  case 'snapshot':
    snapshot(session, json);
    break;
  case 'press':
  case 'click': {
    if (!args[0]) fail(`${command} requires a target`);
    const key = String(args[0]).toLowerCase();
    const globalKeys = new Map([
      ['back', 'back'],
      ['home', 'home'],
      ['recents', 'recents'],
      ['app-switcher', 'recents'],
      ['notifications', 'notifications'],
      ['quick-settings', 'quick_settings'],
      ['dpad-up', 'dpad_up'], ['dpad-down', 'dpad_down'],
      ['dpad-left', 'dpad_left'], ['dpad-right', 'dpad_right'],
      ['dpad-center', 'dpad_center'], ['enter', 'dpad_center'],
    ]);
    if (command === 'press' && globalKeys.has(key)) {
      if (inputTransport === 'adb') fail('--input adb requires coordinates');
      if (globalKeys.get(key).startsWith('dpad_') && !parsed.values.get('--expect-package')) fail('direction keys require --expect-package');
      emit(parseCompanionJson(['press', globalKeys.get(key), ...(parsed.values.get('--expect-package') ? [parsed.values.get('--expect-package')] : [])]), json);
    } else if (args.length >= 2 && Number.isFinite(Number(args[0])) && Number.isFinite(Number(args[1]))) {
      emit(inputTransport === 'adb'
        ? systemInput('tap', { x: Number(args[0]), y: Number(args[1]) })
        : parseCompanionJson(['tap', args[0], args[1]]), json);
    } else {
      if (inputTransport === 'adb') fail('--input adb requires coordinates');
      emit(parseCompanionJson(['click', selector(args[0]), session, ...(parsed.values.has('--guard-file') ? ['--guard-file', parsed.values.get('--guard-file')] : [])]), json);
    }
    break;
  }
  case 'fill': {
    if (!args[0]) fail('fill requires a target');
    if (parsed.flags.has('--stdin')) {
      if (args[1] !== undefined) fail('stdin fill cannot also contain argument text');
      const input = fs.readFileSync(0);
      try {
        if (!input.length || input.length > 8192 || input.includes(0)) fail('invalid stdin text');
        emit(parseCompanionJson(['set-text', selector(args[0]), '--stdin', session], input), json);
      } finally { input.fill(0); }
    } else {
      if (args[1] === undefined) fail('fill requires a target and text');
      emit(parseCompanionJson(['set-text', selector(args[0]), args[1], session]), json);
    }
    break;
  }
  case 'swipe':
    if (args.length < 4) fail('swipe requires x1 y1 x2 y2 [durationMs]');
    emit(inputTransport === 'adb'
      ? systemInput('swipe', { startX: Number(args[0]), startY: Number(args[1]),
        endX: Number(args[2]), endY: Number(args[3]), durationMillis: Number(args[4] ?? 350) })
      : parseCompanionJson(['swipe', ...args.slice(0, 5)]), json);
    break;
  case 'home':
  case 'back':
    emit(parseCompanionJson(['press', command]), json);
    break;
  case 'app-switcher':
    emit(parseCompanionJson(['press', 'recents']), json);
    break;
  case 'screenshot': {
    const destination = path.resolve(args[0] || `companion-screenshot-${Date.now()}.png`);
    emit(parseCompanionJson(['screenshot', destination]), json);
    break;
  }
  case 'install': {
    if (!args[0]) fail('install requires an APK path');
    emit(parseCompanionJson(['install', path.resolve(args[0])]), json);
    break;
  }
  case 'install-status':
    emit(parseCompanionJson(['install-status', ...(args[0] ? [args[0]] : [])]), json);
    break;
  case 'close':
    emit(parseCompanionJson(['session-stop']), json);
    break;
  default:
    fail(`Unsupported Companion adapter command: ${command}`);
}
