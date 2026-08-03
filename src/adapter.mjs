#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { loadConfig } = require('./config.js');
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
    if (value === '--json' || value === '--settle' || value === '-i') {
      flags.add(value);
      continue;
    }
    if (value === '--session') {
      values.set(value, argv[++index] || fail('--session requires a value'));
      continue;
    }
    positionals.push(value);
  }
  return { flags, values, positionals };
}

function runCompanion(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: clientEnv,
  });
  if (result.error) fail(result.error.message, 1);
  if (result.status !== 0) fail((result.stderr || result.stdout || 'Companion command failed').trim(), result.status || 1);
  return result.stdout.trim();
}

function parseCompanionJson(args) {
  const output = runCompanion(args);
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
    process.stdout.write(`${JSON.stringify({ ok: true, data: value }, null, 2)}\n`);
    return;
  }
  if (typeof value === 'string') process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function snapshot(session, json) {
  const text = runCompanion(['snapshot', session]);
  if (!json) return emit(text, false);
  const file = path.join(stateDir, 'sessions', `${safeSession(session)}.json`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodes = Object.entries(stored.refs).map(([ref, node]) => ({ ref, ...node }));
  emit({
    session,
    capturedAt: stored.capturedAt,
    rootPackageName: stored.rootPackageName || null,
    rootClassName: stored.rootClassName || null,
    truncated: Boolean(stored.truncated),
    nodes,
  }, true);
}

function usage() {
  process.stdout.write([
    'agent-device-companion <command> [args] [--session name] [--json]',
    'Commands: devices, capabilities, connection, diagnostics, open, snapshot, press, click, fill, swipe, home, back, app-switcher, screenshot, install, install-status, close',
  ].join('\n') + '\n');
}

const parsed = parseArguments(process.argv.slice(2));
const [command, ...args] = parsed.positionals;
const json = parsed.flags.has('--json');
const session = safeSession(parsed.values.get('--session'));
if (!command || command === '--help' || command === '-h' || command === 'help') {
  usage();
  process.exit(0);
}

switch (command) {
  case 'devices': {
    const status = parseCompanionJson(['status']);
    const devices = status.active ? [{
      id: status.active.deviceId,
      name: 'Enrolled Android device',
      platform: 'android',
      transport: 'companion',
    }] : [];
    emit({ devices }, json);
    break;
  }
  case 'capabilities':
    emit({ availableCommands: ['diagnostics', 'open', 'snapshot', 'press', 'click', 'fill', 'swipe', 'home', 'back', 'app-switcher', 'screenshot', 'install', 'install-status', 'close'] }, json);
    break;
  case 'connection':
  case 'status':
    emit(parseCompanionJson(['status']), json);
    break;
  case 'diagnostics':
    emit(parseCompanionJson(['diagnostics']), json);
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
    ]);
    if (command === 'press' && globalKeys.has(key)) {
      emit(parseCompanionJson(['press', globalKeys.get(key)]), json);
    } else if (args.length >= 2 && Number.isFinite(Number(args[0])) && Number.isFinite(Number(args[1]))) {
      emit(parseCompanionJson(['tap', args[0], args[1]]), json);
    } else {
      emit(parseCompanionJson(['click', selector(args[0]), session]), json);
    }
    break;
  }
  case 'fill':
    if (!args[0] || args[1] === undefined) fail('fill requires a target and text');
    emit(parseCompanionJson(['set-text', selector(args[0]), args[1], session]), json);
    break;
  case 'swipe':
    if (args.length < 4) fail('swipe requires x1 y1 x2 y2 [durationMs]');
    emit(parseCompanionJson(['swipe', ...args.slice(0, 5)]), json);
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
