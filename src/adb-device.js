'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const maximumTimeoutMs = 10 * 60_000;
const maximumCapturedBytes = 4 * 1024 * 1024;
const recoveredBindings = new Map();
const hostCommands = new Set(['connect', 'disconnect', 'pair', 'start-server',
  'kill-server', 'server', 'nodaemon', 'keygen', 'reconnect', 'attach', 'detach',
]);
const hostReadCommands = new Set(['devices', 'version', 'help', 'host-features', 'server-status']);

function isHostAdbCommand(argv = []) {
  return hostCommands.has(argv[0]) || hostReadCommands.has(argv[0]) || argv[0] === 'mdns';
}

function deviceBinding(config, deviceId, prefix = 'adb') {
  const entry = config.systemInput?.devices?.[deviceId];
  const adbPath = config.systemInput?.adbPath;
  if (!entry || !path.isAbsolute(adbPath || '')) throw new Error(`${prefix}-not-configured`);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(entry.serial || '')
      || !/^[A-Za-z0-9_.-]{1,128}$/.test(entry.hardwareSerial || '')) {
    throw new Error(`${prefix}-invalid-device-binding`);
  }
  const recovered = recoveredBindings.get(deviceId);
  return { adbPath, ...entry,
    ...(recovered?.configuredSerial === entry.serial && recovered.hardwareSerial === entry.hardwareSerial
      ? { serial: recovered.serial } : {}) };
}

function validateRequest(request) {
  if (!Array.isArray(request.argv) || !request.argv.length || request.argv.length > 1024
      || request.argv.some(value => typeof value !== 'string' || value.includes('\0') || value.length > 65536)) {
    throw new Error('adb-invalid-arguments');
  }
  // ARLab selects device transports through --device. Native host commands use
  // the SDK directly, without a device selector or a phone readiness probe.
  if (!/^[a-z][a-z0-9-]*$/.test(request.argv[0])) {
    const grouped = /\s/.test(request.argv[0]);
    throw new Error(grouped ? 'adb-grouped-arguments: use --args-file for a JSON argument array or --shell-file for a script'
      : 'adb-device-command-required');
  }
  const timeoutMs = request.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > maximumTimeoutMs) {
    throw new Error('adb-invalid-timeout');
  }
  for (const name of ['cwd', 'outputFile', 'inputFile']) {
    if (request[name] !== undefined && (typeof request[name] !== 'string' || !path.isAbsolute(request[name]))) {
      throw new Error(`adb-${name}-must-be-absolute`);
    }
  }
  if (request.readRemotePath !== undefined && (typeof request.readRemotePath !== 'string'
      || !request.readRemotePath.startsWith('/') || request.readRemotePath.includes('\0')
      || request.inputFile || request.argv[0] !== 'pull')) throw new Error('adb-invalid-file-read');
  if (request.asRoot !== undefined && typeof request.asRoot !== 'boolean') throw new Error('adb-invalid-root-access');
  if ((request.accessPackage !== undefined || request.asRoot) && !request.readRemotePath) throw new Error('adb-file-access-requires-read');
  if (request.accessPackage !== undefined && (typeof request.accessPackage !== 'string'
      || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(request.accessPackage)
      || request.asRoot)) throw new Error('adb-invalid-file-access-package');
  if (request.inputFile && request.outputFile && path.resolve(request.inputFile) === path.resolve(request.outputFile)) {
    throw new Error('adb-input-output-conflict');
  }
  return { ...request, timeoutMs };
}

function quoteAndroidArgument(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readDelegatedFile(request, execute, directory, receivedFile) {
  const identity = request.accessPackage ? ['run-as', request.accessPackage, 'id'] : ['su', '-c', 'id'];
  const access = await execute(['shell', ...identity]);
  if (access.error || access.exitCode !== 0) return access;
  if (request.asRoot && !/\buid=0\b/.test(access.stdout)) {
    return { ...access, error: 'adb-root-not-granted' };
  }
  const encodedFile = path.join(directory, 'encoded.txt');
  const readCommand = `base64 -- ${quoteAndroidArgument(request.readRemotePath)}`;
  const script = request.accessPackage
    ? `run-as ${quoteAndroidArgument(request.accessPackage)} sh -c ${quoteAndroidArgument(readCommand)}`
    : `su -c ${quoteAndroidArgument(readCommand)}`;
  const result = await execute(['shell', script], { timeoutMs: request.timeoutMs, outputFile: encodedFile });
  // The encoded file is private transport scratch space, never a caller artifact.
  const { outputFile, outputBytes, completed, ...execution } = result;
  if (result.error || result.exitCode !== 0) return execution;
  let remainder = '';
  let padded = false;
  await pipeline(fs.createReadStream(encodedFile), new Transform({
    transform(chunk, encoding, done) {
      const encoded = chunk.toString('latin1').replace(/[\r\n]/g, '');
      if (!/^[A-Za-z0-9+/=]*$/.test(encoded) || (padded && encoded.length)) {
        done(new Error('adb-invalid-base64-file-data')); return;
      }
      const combined = remainder + encoded;
      const end = combined.length - combined.length % 4;
      const complete = combined.slice(0, end);
      remainder = combined.slice(end);
      if (complete.includes('=')) padded = true;
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(complete)
          || (padded && remainder.length)) {
        done(new Error('adb-invalid-base64-file-data')); return;
      }
      this.push(Buffer.from(complete, 'base64'));
      done();
    },
    flush(done) { done(remainder.length ? new Error('adb-incomplete-base64-file-data') : null); },
  }), fs.createWriteStream(receivedFile, { flags: 'wx', mode: 0o600 }));
  // Return only the decoded destination's metadata, never the temporary encoded path.
  return { ...execution, accessMode: request.accessPackage ? 'run-as' : 'root',
    ...(request.accessPackage ? { accessPackage: request.accessPackage } : {}) };
}

async function readRemoteFile(request, execute) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlab-read-'));
  const receivedFile = path.join(directory, 'received.bin');
  try {
    // Native sync transfer avoids exec-out's separate argument quoting and the
    // Windows shell command's newline conversion. Its exit code reports failures.
    const result = request.accessPackage || request.asRoot
      ? await readDelegatedFile(request, execute, directory, receivedFile)
      : await execute(['pull', request.readRemotePath, receivedFile],
        { timeoutMs: request.timeoutMs, cwd: request.cwd });
    if (result.error || result.exitCode !== 0) return result;
    const size = fs.statSync(receivedFile).size;
    if (request.outputFile) {
      fs.copyFileSync(receivedFile, request.outputFile, fs.constants.COPYFILE_EXCL);
      return { ...result, outputFile: request.outputFile, outputBytes: size, completed: true };
    }
    if (size > maximumCapturedBytes) return { ...result, exitCode: 1,
      error: 'adb-output-limit-exceeded', stderr: 'Use --output LOCAL_FILE for files larger than 4 MiB.' };
    const bytes = fs.readFileSync(receivedFile);
    const text = bytes.toString('utf8');
    return { ...result, stdout: text, outputBytes: size,
      ...(!bytes.equals(Buffer.from(text, 'utf8')) ? { stdoutBase64: bytes.toString('base64') } : {}) };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function runAdbProcess(file, argv, options, stillOwnsDevice) {
  return new Promise((resolve, reject) => {
    let input;
    let output;
    try {
      if (options.inputFile) input = fs.openSync(options.inputFile, 'r');
      // Exclusive creation prevents accidental replacement of an existing local file.
      if (options.outputFile) output = fs.openSync(options.outputFile, 'wx', 0o600);
    } catch (error) {
      if (input !== undefined) fs.closeSync(input);
      reject(error);
      return;
    }
    const child = spawn(file, argv, { windowsHide: true, cwd: options.cwd,
      stdio: [input ?? 'ignore', output ?? 'pipe', 'pipe'] });
    if (input !== undefined) fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let failure;
    const stop = reason => { if (!failure) { failure = reason; child.kill(); } };
    const capture = (chunks, chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > maximumCapturedBytes) stop('adb-output-limit-exceeded');
      else chunks.push(chunk);
    };
    child.stdout?.on('data', chunk => capture(stdout, chunk));
    child.stderr.on('data', chunk => capture(stderr, chunk));
    child.once('error', error => { failure = error.code === 'ENOENT' ? 'adb-executable-unavailable' : error.message; });
    const timeout = setTimeout(() => stop('adb-timeout'), options.timeoutMs);
    const leaseCheck = setInterval(() => {
      if (!stillOwnsDevice()) stop('adb-control-lease-expired');
    }, 200);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      clearInterval(leaseCheck);
      const bytes = Buffer.concat(stdout);
      const text = bytes.toString('utf8');
      resolve({ exitCode, signal, stdout: text, stderr: Buffer.concat(stderr).toString('utf8'),
        ...(!bytes.equals(Buffer.from(text, 'utf8')) ? { stdoutBase64: bytes.toString('base64') } : {}),
        ...(failure ? { error: failure, outcome: 'unconfirmed' } : {}),
        ...(options.outputFile ? { outputFile: options.outputFile,
          outputBytes: fs.statSync(options.outputFile).size, completed: exitCode === 0 && !failure } : {}) });
    });
  });
}

async function deviceAdb(config, deviceId, input, stillOwnsDevice, run = runAdbProcess, onDispatch = () => {}) {
  const request = validateRequest(input);
  const binding = deviceBinding(config, deviceId);
  const execute = (argv, options = {}) => run(binding.adbPath, ['-s', binding.serial, ...argv],
    { timeoutMs: 20_000, ...options }, stillOwnsDevice);
  if (!stillOwnsDevice()) throw new Error('adb-control-lease-expired');
  if (isHostAdbCommand(request.argv)) {
    onDispatch();
    const result = await run(binding.adbPath, request.argv, request, stillOwnsDevice);
    // The SDK can return zero for a refused connect/pair while printing the
    // actual failure on stdout. Preserve that response and expose its failure.
    if (['connect', 'pair'].includes(request.argv[0]) && result.exitCode === 0
        && /^(?:cannot connect|cannot resolve|failed to |unable to connect|error:)/mi.test(`${result.stdout}\n${result.stderr}`)) {
      result.error = 'adb-host-command-failed';
    }
    return { ok: !result.error && result.exitCode === 0, result: { transport: 'adb', deviceId, ...result } };
  }
  let state = await execute(['get-state']);
  if (state.exitCode !== 0 && !state.error && binding.route === 'companion-tunnel') {
    const connected = await execute(['connect', binding.serial]);
    if (!connected.error && connected.exitCode === 0) state = await execute(['get-state']);
  } else if (state.exitCode !== 0 && !state.error) {
    // Wireless debugging ports rotate. Discovery is read-only, and connection
    // reuses existing ADB keys; hardware is verified before any caller command.
    const discovery = await execute(['mdns', 'services']);
    const candidates = discovery.stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/))
      .filter(fields => fields[0]?.startsWith(`adb-${binding.hardwareSerial}-`)
        && fields[1] === '_adb-tls-connect._tcp' && /^[A-Za-z0-9_.:-]+:\d+$/.test(fields[2] || ''));
    if (candidates.length > 1) throw new Error('adb-multiple-matching-transports');
    const serial = candidates[0]?.[2] || binding.serial;
    if (serial.includes(':') && stillOwnsDevice()) {
      const connected = await execute(['connect', serial]);
      if (!connected.error && connected.exitCode === 0) {
        binding.serial = serial;
        state = await execute(['get-state']);
      }
    }
  }
  if ((state.exitCode !== 0 || state.error || state.stdout.trim() !== 'device')
      && binding.route !== 'companion-tunnel') {
    // A USB hardware serial may be the original binding even when the same
    // authorized device is now reachable through a connected TCP transport.
    const devices = await run(binding.adbPath, ['devices'], { timeoutMs: 10_000 }, stillOwnsDevice);
    if (!devices.error && devices.exitCode === 0) {
      const candidates = devices.stdout.split(/\r?\n/)
        .map(line => line.trim().split(/\s+/))
        .filter(([serial, status]) => status === 'device' && serial !== binding.serial
          && /^[A-Za-z0-9_.:-]{1,128}$/.test(serial))
        .map(([serial]) => serial)
        .sort((left, right) => Number(left.startsWith('127.')) - Number(right.startsWith('127.')))
        .slice(0, 8);
      for (const serial of candidates) {
        if (!stillOwnsDevice()) throw new Error('adb-control-lease-expired');
        const identity = await run(binding.adbPath, ['-s', serial, 'shell', 'getprop', 'ro.serialno'],
          { timeoutMs: 3_000 }, stillOwnsDevice);
        if (identity.error || identity.exitCode !== 0
            || identity.stdout.trim() !== binding.hardwareSerial) continue;
        binding.serial = serial;
        state = await execute(['get-state']);
        if (!state.error && state.exitCode === 0 && state.stdout.trim() === 'device') break;
      }
    }
  }
  if (state.exitCode !== 0 || state.error || state.stdout.trim() !== 'device') {
    throw new Error(state.error || 'adb-transport-unavailable');
  }
  const hardware = await execute(['shell', 'getprop', 'ro.serialno']);
  if (hardware.exitCode !== 0 || hardware.error || hardware.stdout.trim() !== binding.hardwareSerial) {
    throw new Error('adb-device-mismatch');
  }
  if (!stillOwnsDevice()) throw new Error('adb-control-lease-expired');
  recoveredBindings.set(deviceId, { serial: binding.serial, hardwareSerial: binding.hardwareSerial,
    configuredSerial: config.systemInput.devices[deviceId].serial });
  onDispatch();
  const result = request.readRemotePath ? await readRemoteFile(request, execute) : await execute(request.argv, request);
  // Some Android command tools print SecurityException but still exit 0. Retain
  // their native exit code and output while exposing the actual operation failure.
  const shellTool = request.argv[0] === 'shell' ? request.argv.slice(1).find(value => !value.startsWith('-')) : null;
  if (['content', 'pm', 'cmd', 'am'].includes(shellTool) && result.exitCode === 0
      && /^(?:Error while accessing provider:|Error: java\.lang\.SecurityException|java\.lang\.SecurityException:|Exception occurred while executing)/m.test(result.stderr)) {
    result.error = 'adb-android-command-failed';
  }
  // `service call` prints Binder exceptions in a Parcel and may still exit 0.
  // The exception marker is the first word; a later negative return value is
  // ordinary method data and must not be classified as an exception.
  const serviceCall = shellTool === 'service' && request.argv.includes('call');
  if (serviceCall && result.exitCode === 0
      && /^Result:\s*Parcel\(\s*(?:0x0+:\s*)?fffffff[1-9a-f]\b/im.test(result.stdout)) {
    result.error = 'adb-android-command-failed';
  }
  return { ok: !result.error && result.exitCode === 0, result: { transport: 'adb', deviceId,
    connectionRoute: binding.route || 'configured-direct', ...result } };
}

module.exports = { deviceAdb, deviceBinding, isHostAdbCommand, runAdbProcess };
