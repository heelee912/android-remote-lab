'use strict';

const { execFile } = require('node:child_process');
const { deviceBinding } = require('./adb-device.js');

function execute(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, {
    windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout.trim());
    const reason = /device.*not found|device offline|unauthorized|no devices/i.test(stderr || '')
      ? 'system-input-adb-unavailable'
      : error.code === 'ENOENT' ? 'system-input-adb-executable-unavailable'
        : error.killed ? 'system-input-adb-timeout' : 'system-input-adb-failed';
    reject(new Error(reason));
  }));
}

// This runs inside the relay's per-device control queue, after its ownership check.
// Configuration is local only; neither callers nor snapshots may choose an ADB target.
async function systemInput(config, deviceId, args, stillOwnsDevice, run = execute) {
  const entry = deviceBinding(config, deviceId, 'system-input');
  const { adbPath } = entry;
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(args.expectedPackage || '')) {
    throw new Error('system-input-expected-package-required');
  }
  const coordinate = value => {
    if (!Number.isInteger(value) || value < 0 || value > 20000) throw new Error('system-input-invalid-coordinate');
    return String(value);
  };
  let input;
  if (args.action === 'tap') input = ['tap', coordinate(args.x), coordinate(args.y)];
  else if (args.action === 'swipe') {
    if (!Number.isInteger(args.durationMillis) || args.durationMillis < 50 || args.durationMillis > 2000) {
      throw new Error('system-input-invalid-duration');
    }
    input = ['swipe', coordinate(args.startX), coordinate(args.startY),
      coordinate(args.endX), coordinate(args.endY), String(args.durationMillis)];
  } else throw new Error('system-input-unsupported-action');

  const adb = (...command) => run(adbPath, ['-s', entry.serial, ...command]);
  if (await adb('get-state') !== 'device') throw new Error('system-input-adb-unavailable');
  if (await adb('shell', 'getprop', 'ro.serialno') !== entry.hardwareSerial) {
    throw new Error('system-input-device-mismatch');
  }
  const policy = await adb('shell', 'dumpsys', 'window', 'policy');
  const keyguard = policy.split('KeyguardServiceDelegate')[1]?.split('KeyguardStateMonitor')[0] || '';
  if (!/^\s*showing=false\s*$/m.test(keyguard)
      || !/^\s*inputRestricted=false\s*$/m.test(keyguard)
      || !/^\s*screenState=SCREEN_STATE_ON\s*$/m.test(keyguard)) {
    throw new Error('system-input-screen-not-unlocked');
  }
  const windows = await adb('shell', 'dumpsys', 'window', 'displays');
  const focus = windows.match(/mCurrentFocus=Window\{[^\n]*?\s([A-Za-z0-9_.]+)\//)?.[1];
  if (focus !== args.expectedPackage) throw new Error('system-input-foreground-mismatch');
  if (!stillOwnsDevice()) throw new Error('system-input-control-lease-expired');
  await adb('shell', 'input', 'touchscreen', ...input);
  // Shell completion is dispatch evidence. The caller must read back the actual UI/result.
  return { ok: true, result: { dispatched: true, transport: 'adb', deviceId } };
}

module.exports = { systemInput };
