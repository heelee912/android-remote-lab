'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deviceAdb, runAdbProcess } = require('../src/adb-device.js');

const deviceId = 'a'.repeat(32);
const config = { systemInput: { adbPath: path.resolve('test-adb'),
  devices: { [deviceId]: { serial: 'test-transport', hardwareSerial: 'TEST_PHONE' } } } };
function fake(hardware = 'TEST_PHONE') {
  const calls = [];
  return { calls, run: async (file, argv) => {
    assert.equal(file, config.systemInput.adbPath);
    assert.deepEqual(argv.slice(0, 2), ['-s', 'test-transport']);
    calls.push(argv.slice(2));
    return { exitCode: 0, stdout: argv[2] === 'get-state' ? 'device\n'
      : argv.slice(2).join(' ') === 'shell getprop ro.serialno' ? hardware : 'result', stderr: '' };
  } };
}
test('arbitrary device commands retain the selected hardware binding and arguments', async () => {
  for (const argv of [['shell', 'run-as', 'com.example.debug', 'cat', 'files/test'],
    ['pull', '/sdcard/path with spaces', path.resolve('received.bin')], ['root'],
    ['exec-out', 'screencap', '-p'], ['logcat', '-d'], ['reverse', 'tcp:8080', 'tcp:8080']]) {
    const adb = fake();
    const result = await deviceAdb(config, deviceId, { argv }, () => true, adb.run);
    assert.equal(result.ok, true);
    assert.deepEqual(adb.calls.at(-1), argv);
  }
});
test('caller dispatch is marked only after transport and hardware verification', async () => {
  const adb = fake();
  let dispatched = false;
  await deviceAdb(config, deviceId, { argv: ['shell', 'id'] }, () => true, adb.run, () => {
    assert.deepEqual(adb.calls.at(-1), ['shell', 'getprop', 'ro.serialno']);
    dispatched = true;
  });
  assert.equal(dispatched, true);
  dispatched = false;
  await assert.rejects(deviceAdb(config, deviceId, { argv: ['shell', 'id'] }, () => true, fake('WRONG').run,
    () => { dispatched = true; }), /device-mismatch/);
  assert.equal(dispatched, false);
});
test('device selection uses the ARLab target and mismatched hardware cannot dispatch a command', async () => {
  for (const argv of [['-s', 'other', 'shell'], ['--one-device', 'other'], []]) {
    const adb = fake();
    await assert.rejects(deviceAdb(config, deviceId, { argv }, () => true, adb.run));
    assert.equal(adb.calls.length, 0);
  }
  const wrong = fake('OTHER_PHONE');
  await assert.rejects(deviceAdb(config, deviceId, { argv: ['shell', 'id'] }, () => true, wrong.run), /device-mismatch/);
  assert.equal(wrong.calls.length, 2);
  await assert.rejects(deviceAdb(config, deviceId, { argv: ['shell', 'id'] }, () => false, fake().run), /lease-expired/);
});
test('read-only host diagnostics work offline without dispatching a phone shell', async () => {
  const calls = [];
  const result = await deviceAdb(config, deviceId, { argv: ['mdns', 'services'] }, () => true,
    async (file, argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: 'List of discovered mdns services', stderr: '' };
    });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['mdns', 'services']]);
});
test('native host commands execute unchanged without a live phone transport', async () => {
  for (const argv of [['connect', '192.0.2.1:5555'], ['disconnect', '192.0.2.1:5555'],
    ['pair', '192.0.2.1:37000', '123456'], ['start-server'], ['kill-server'],
    ['server'], ['nodaemon', 'server'], ['keygen', path.resolve('test-key')],
    ['reconnect', 'offline'], ['attach', 'TEST_PHONE'], ['detach', 'TEST_PHONE'],
    ['devices', '-l'], ['server-status']]) {
    const calls = [];
    const result = await deviceAdb(config, deviceId, { argv }, () => true, async (file, actual) => {
      assert.equal(file, config.systemInput.adbPath);
      calls.push(actual);
      return { exitCode: 0, stdout: 'native host result', stderr: '' };
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [argv]);
  }
});
test('host connect and pair failures remain failures when the SDK exits zero', async () => {
  for (const command of ['connect', 'pair']) {
    const output = 'cannot connect to 192.0.2.1:5555: connection refused';
    const result = await deviceAdb(config, deviceId, { argv: [command, '192.0.2.1:5555'] }, () => true,
      async () => ({ exitCode: 0, stdout: output, stderr: '' }));
    assert.equal(result.ok, false);
    assert.equal(result.result.exitCode, 0);
    assert.equal(result.result.stdout, output);
    assert.equal(result.result.error, 'adb-host-command-failed');
  }
});
test('remote exit codes and permission errors remain failures with original stderr', async () => {
  const adb = fake();
  const result = await deviceAdb(config, deviceId, { argv: ['shell', 'cat', '/data/private'] }, () => true,
    async (...args) => args[1].includes('/data/private')
      ? { exitCode: 13, stdout: '', stderr: 'Permission denied' } : adb.run(...args));
  assert.equal(result.ok, false);
  assert.equal(result.result.exitCode, 13);
  assert.equal(result.result.stderr, 'Permission denied');
});
test('Android content permission exceptions are failures even when its native exit is zero', async () => {
  const adb = fake();
  const result = await deviceAdb(config, deviceId, { argv: ['shell', 'content', 'query', '--uri', 'content://example/private'] }, () => true,
    async (...args) => args[1].includes('content')
      ? { exitCode: 0, stdout: '', stderr: 'Error while accessing provider:example\njava.lang.SecurityException: Permission Denial' }
      : adb.run(...args));
  assert.equal(result.ok, false);
  assert.equal(result.result.exitCode, 0);
  assert.equal(result.result.error, 'adb-android-command-failed');
  assert.match(result.result.stderr, /Permission Denial/);
});
test('rotated wireless port reconnects only the advertised selected hardware and verifies it', async () => {
  for (const hardware of ['WIRELESS_PHONE', 'WRONG_PHONE']) {
    const id = (hardware === 'WIRELESS_PHONE' ? 'b' : 'c').repeat(32);
    const wireless = { systemInput: { adbPath: path.resolve('test-adb'), devices: {
      [id]: { serial: '192.0.2.1:1234', hardwareSerial: 'WIRELESS_PHONE' },
    } } };
    const calls = [];
    const result = deviceAdb(wireless, id, { argv: ['shell', 'id'] }, () => true, async (file, argv) => {
      calls.push(argv);
      const command = argv.slice(2).join(' ');
      const stdout = command === 'get-state' ? (argv[1].endsWith(':5678') ? 'device' : '')
        : command === 'mdns services' ? 'adb-OTHER_PHONE-x _adb-tls-connect._tcp 192.0.2.2:9999\nadb-WIRELESS_PHONE-x _adb-tls-connect._tcp 192.0.2.1:5678'
          : command === 'shell getprop ro.serialno' ? hardware : 'connected';
      return { exitCode: command === 'get-state' && !stdout ? 1 : 0, stdout, stderr: '' };
    });
    if (hardware === 'WRONG_PHONE') {
      await assert.rejects(result, /device-mismatch/);
      assert.equal(calls.some(argv => argv.slice(2).join(' ') === 'shell id'), false);
    } else {
      assert.equal((await result).ok, true);
      assert.deepEqual(calls.at(-1), ['-s', '192.0.2.1:5678', 'shell', 'id']);
    }
    assert.equal(calls.some(argv => argv.includes('192.0.2.2:9999')), false);
  }
});
test('binary output and input stream without text conversion or replacing existing output', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlab-adb-bytes-'));
  try {
    const inputFile = path.join(directory, 'input.bin');
    const outputFile = path.join(directory, 'output.bin');
    const bytes = Buffer.from([0, 255, 128, 10, 13, 1]);
    fs.writeFileSync(inputFile, bytes);
    const result = await runAdbProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'],
      { inputFile, outputFile, timeoutMs: 5000 }, () => true);
    assert.equal(result.completed, true);
    assert.deepEqual(fs.readFileSync(outputFile), bytes);
    await assert.rejects(runAdbProcess(process.execPath, ['-e', ''],
      { outputFile, timeoutMs: 5000 }, () => true), /EEXIST/);
    const inline = await runAdbProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.from([255,0,128]))'],
      { timeoutMs: 5000 }, () => true);
    assert.deepEqual(Buffer.from(inline.stdoutBase64, 'base64'), Buffer.from([255, 0, 128]));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('file read uses native transfer so CR/LF bytes and apostrophes survive exactly', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlab-read-regression-'));
  const bytes = Buffer.from([0, 10, 13, 10, 255, 128]);
  const remote = "/sdcard/file's binary.bin";
  const outputFile = path.join(directory, 'original.bin');
  const adb = fake();
  const run = async (file, argv, options, owns) => {
    if (argv[2] !== 'pull') return adb.run(file, argv, options, owns);
    assert.equal(argv[3], remote);
    fs.writeFileSync(argv[4], bytes);
    return { exitCode: 0, stdout: '1 file pulled', stderr: '' };
  };
  try {
    let result = await deviceAdb(config, deviceId, { argv: ['pull'], readRemotePath: remote, outputFile }, () => true, run);
    assert.equal(result.ok, true);
    assert.deepEqual(fs.readFileSync(outputFile), bytes);
    await assert.rejects(deviceAdb(config, deviceId, { argv: ['pull'], readRemotePath: remote, outputFile }, () => true, run), /EEXIST/);
    result = await deviceAdb(config, deviceId, { argv: ['pull'], readRemotePath: remote }, () => true, run);
    assert.deepEqual(Buffer.from(result.result.stdoutBase64, 'base64'), bytes);
    result = await deviceAdb(config, deviceId, { argv: ['pull'], readRemotePath: remote }, () => true,
      async (file, argv, ...rest) => argv[2] === 'pull'
        ? { exitCode: 1, stdout: '', stderr: 'Permission denied' } : run(file, argv, ...rest));
    assert.equal(result.ok, false);
    assert.equal(result.result.stderr, 'Permission denied');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('long commands terminate on timeout or expired ownership and never report success', async () => {
  for (const expired of [false, true]) {
    const started = Date.now();
    const result = await runAdbProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
      { timeoutMs: expired ? 5000 : 150 }, () => !expired || Date.now() - started < 100);
    assert.equal(result.error, expired ? 'adb-control-lease-expired' : 'adb-timeout');
    assert.equal(result.outcome, 'unconfirmed');
    assert.notEqual(result.exitCode, 0);
  }
});

test('delegated private reads preserve binary bytes and quote package and path without shared staging', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arlab-delegated-read-'));
  const bytes = Buffer.alloc(256 * 1024 + 1);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
  const remote = "/data/user/0/com.example.debug/files/file's ; data.bin";
  const temporary = [];
  try {
    for (const scope of [{ accessPackage: 'com.example.debug' }, { asRoot: true }]) {
      const adb = fake();
      const outputFile = path.join(directory, scope.asRoot ? 'root.bin' : 'app.bin');
      const result = await deviceAdb(config, deviceId,
        { argv: ['pull'], readRemotePath: remote, outputFile, ...scope }, () => true,
        async (file, argv, options, owns) => {
          if (options.outputFile) {
            temporary.push(options.outputFile);
            const script = argv[3];
            assert.match(script, /base64 --/);
            assert.match(script, /file.*data\.bin/);
            assert.equal(script.includes('/sdcard/'), false);
            assert.equal(argv.length, 4);
            fs.writeFileSync(options.outputFile, bytes.toString('base64').replace(/.{76}/g, '$&\r\n'));
            return { exitCode: 0, stdout: '', stderr: '', outputFile: options.outputFile, completed: true };
          }
          if (argv.at(-1) === 'id') return { exitCode: 0, stdout: scope.asRoot ? 'uid=0(root)' : 'uid=10123(app)', stderr: '' };
          return adb.run(file, argv, options, owns);
        });
      assert.equal(result.ok, true);
      assert.equal(result.result.accessMode, scope.asRoot ? 'root' : 'run-as');
      assert.equal(result.result.outputFile, outputFile);
      assert.equal(result.result.outputBytes, bytes.length);
      assert.deepEqual(fs.readFileSync(outputFile), bytes);
    }
    assert.equal(temporary.every(file => !fs.existsSync(path.dirname(file))), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('private access fails visibly on denied identities, invalid scopes, and corrupt transfers', async () => {
  const request = { argv: ['pull'], readRemotePath: '/data/user/0/com.example.debug/files/test', accessPackage: 'com.example.debug' };
  for (const invalid of [{ ...request, accessPackage: 'com.example;id' }, { ...request, asRoot: true },
    { argv: ['shell', 'id'], accessPackage: 'com.example.debug' }, { ...request, asRoot: 'yes' }]) {
    const adb = fake();
    await assert.rejects(deviceAdb(config, deviceId, invalid, () => true, adb.run), /adb-(invalid|file-access)/);
    assert.equal(adb.calls.length, 0);
  }
  for (const mode of ['denied', 'not-root', 'corrupt', 'read-denied']) {
    const adb = fake();
    let scratch;
    const result = deviceAdb(config, deviceId, mode === 'not-root'
      ? { ...request, accessPackage: undefined, asRoot: true } : request, () => true,
    async (file, argv, options, owns) => {
      if (argv.at(-1) === 'id') return { exitCode: mode === 'denied' ? 1 : 0,
        stdout: 'uid=10123(app)', stderr: mode === 'denied' ? 'package not debuggable' : '' };
      if (options.outputFile) {
        scratch = options.outputFile;
        fs.writeFileSync(scratch, mode === 'corrupt' ? 'AA=A' : '');
        return { exitCode: mode === 'read-denied' ? 1 : 0, stdout: '', stderr: 'Permission denied', outputFile: scratch };
      }
      return adb.run(file, argv, options, owns);
    });
    if (mode === 'corrupt') await assert.rejects(result, /invalid-base64/);
    else {
      const response = await result;
      assert.equal(response.ok, false);
      assert.equal(response.result.outputFile, undefined);
      if (mode === 'not-root') assert.equal(response.result.error, 'adb-root-not-granted');
    }
    if (scratch) assert.equal(fs.existsSync(path.dirname(scratch)), false);
  }
});
