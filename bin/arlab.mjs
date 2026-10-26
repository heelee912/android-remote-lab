#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { doctor } from '../src/doctor.mjs';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function runNode(script, args) {
  const env = { ...process.env };
  if (!env.ANDROID_REMOTE_LAB_OWNER && !env.CODEX_THREAD_ID) {
    env.ANDROID_REMOTE_LAB_OWNER = `interactive-shell-${process.ppid}`;
  }
  const result = spawnSync(process.execPath, [path.join(packageRoot, script), ...args], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true, env,
    input: args[0] === 'fill' && args.includes('--stdin') ? fs.readFileSync(0) : undefined,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
}

function installSkill() {
  const source = path.join(packageRoot, 'skills', 'android-remote-device-lab');
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const destination = path.join(codexHome, 'skills', 'android-remote-device-lab');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ ok: true, skill: 'android-remote-device-lab', destination }, null, 2)}\n`);
}

function setup(args) {
  const script = path.join(packageRoot, 'windows', 'Install-Runtime.ps1');
  const commandArgs = [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-PackageRoot', packageRoot,
  ];
  const host = option(args, '--host');
  const publicPort = option(args, '--port');
  const importState = option(args, '--import-state');
  const replaceTask = option(args, '--replace-task');
  if (host) commandArgs.push('-RelayHost', host);
  if (publicPort) commandArgs.push('-PublicPort', publicPort);
  if (importState) commandArgs.push('-ImportState', importState);
  if (replaceTask) commandArgs.push('-ReplaceTaskName', replaceTask);
  if (args.includes('--system')) commandArgs.push('-System');
  if (args.includes('--no-funnel')) commandArgs.push('-NoFunnel');
  const result = spawnSync('powershell.exe', commandArgs, { stdio: 'inherit', windowsHide: true });
  process.exit(result.status ?? 1);
}

function usage() {
  process.stdout.write(`Android Remote Lab\n\n` +
    `  arlab setup [--host DNS_NAME] [--port 10000] [--system] [--no-funnel]\n` +
    `              [--import-state PATH] [--replace-task TASK_NAME]\n` +
    `  arlab doctor [--repair] [--background] [--json]\n` +
    `  arlab status\n` +
    `  arlab enroll DEVICE_ID\n` +
    `  arlab select DEVICE_ID (saved per owner; stop this owner session before switching)\n` +
    `  arlab session start [MINUTES] [--background] [--force]\n` +
    `  arlab session stop [--force]\n` +
    `  arlab device <agent-device-compatible command...> [--device DEVICE_ID]\n` +
    `      includes: install <APK_PATH>, install-status [UPLOAD_ID]\n` +
    `      adb [--json] [--output LOCAL_FILE] [--timeout-ms 60000] -- COMMAND [ARGS...]\n` +
    `      adb-status [--repair] [--json]\n` +
    `      adb-pair SIX_DIGIT_CODE [--json] (selected device's pairing screen must be open)\n` +
    `      adb-bind [--json] (resume pairing without a new code)\n` +
    `      adb/files accept --adb-route auto|direct|companion before --\n` +
    `      files list|stat|read REMOTE_PATH; files pull REMOTE LOCAL; files push LOCAL REMOTE\n` +
    `  arlab skill install\n`);
}

const argv = process.argv.slice(2);
const delimiterIndex = argv.indexOf('--');
const deviceIndex = argv.findIndex((value, index) => value === '--device'
  && (delimiterIndex < 0 || index < delimiterIndex));
if (deviceIndex >= 0) {
  const deviceId = argv[deviceIndex + 1];
  if (!/^[a-f0-9]{32}$/.test(deviceId || '')) fail('--device requires a full device ID', 2);
  process.env.ANDROID_REMOTE_LAB_DEVICE_ID = deviceId;
  argv.splice(deviceIndex, 2);
}
const [command, ...args] = argv;
switch (command) {
  case 'setup': setup(args); break;
  case 'doctor': {
    const result = await doctor({ repair: args.includes('--repair'), background: args.includes('--background') });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : result.state === 'WAITING_FOR_PHONE' ? 3 : 2);
    break;
  }
  case 'status': runNode('src/client.js', ['status']); break;
  case 'enroll': runNode('src/client.js', ['enroll', ...args]); break;
  case 'select': runNode('src/client.js', ['select', ...args]); break;
  case 'session': {
    const [action, ...rest] = args;
    if (action === 'start') runNode('src/client.js', ['session-start', ...rest]);
    if (action === 'stop') runNode('src/client.js', ['session-stop', ...rest]);
    fail('session requires start or stop', 2);
    break;
  }
  case 'device': runNode('src/adapter.mjs', args); break;
  case 'skill':
    if (args[0] === 'install') installSkill();
    else fail('skill requires install', 2);
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined: usage(); break;
  default: fail(`Unknown command: ${command}`, 2);
}
