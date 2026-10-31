'use strict';

const { runAdbProcess } = require('./adb-device.js');

const transportPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const networkTransportPattern = /^(?!127\.)(?:[A-Za-z0-9_.-]+|\[[0-9a-fA-F:]+\]):\d{1,5}$/;

async function adb(adbPath, args, run) {
  return run(adbPath, args, { timeoutMs: 5_000 }, () => true);
}

async function connectedIdentities(adbPath, run) {
  const listed = await adb(adbPath, ['devices'], run);
  if (listed.error || listed.exitCode !== 0) throw new Error('adb-presence-list-failed');
  const serials = listed.stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(([serial, state]) => state === 'device' && transportPattern.test(serial))
    .map(([serial]) => serial);
  const identities = new Map();
  for (const serial of serials) {
    const identity = await adb(adbPath, ['-s', serial, 'shell', 'getprop', 'ro.serialno'], run);
    if (!identity.error && identity.exitCode === 0 && transportPattern.test(identity.stdout.trim())) {
      identities.set(serial, identity.stdout.trim());
    }
  }
  return identities;
}

function discoveredAddress(stdout, hardwareSerial) {
  const matches = stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(([name, service, address]) => name?.startsWith(`adb-${hardwareSerial}-`)
      && service === '_adb-tls-connect._tcp' && networkTransportPattern.test(address || ''))
    .map(([, , address]) => address);
  return matches.length === 1 ? matches[0] : null;
}

async function reconcileAdbPresence(config, run = runAdbProcess) {
  const adbPath = config.systemInput?.adbPath;
  const bindings = Object.values(config.systemInput?.devices || {});
  if (!adbPath || !bindings.length) return { connected: 0, missing: 0 };
  const identities = await connectedIdentities(adbPath, run);
  let connected = 0;
  let missing = 0;
  for (const binding of bindings) {
    if (!transportPattern.test(binding.hardwareSerial || '')) continue;
    if ([...identities.values()].includes(binding.hardwareSerial)) continue;
    const candidates = [];
    if (networkTransportPattern.test(binding.serial || '')) candidates.push(binding.serial);
    const discovery = await adb(adbPath, ['mdns', 'services'], run);
    if (!discovery.error && discovery.exitCode === 0) {
      const address = discoveredAddress(discovery.stdout, binding.hardwareSerial);
      if (address && !candidates.includes(address)) candidates.push(address);
    }
    let verified = false;
    for (const serial of candidates) {
      const wasConnected = identities.has(serial);
      const attempt = await adb(adbPath, ['connect', serial], run);
      if (attempt.error || attempt.exitCode !== 0
          || /^(?:cannot connect|cannot resolve|failed to |unable to connect|error:)/mi
            .test(`${attempt.stdout}\n${attempt.stderr}`)) continue;
      const identity = await adb(adbPath, ['-s', serial, 'shell', 'getprop', 'ro.serialno'], run);
      if (!identity.error && identity.exitCode === 0 && identity.stdout.trim() === binding.hardwareSerial) {
        identities.set(serial, binding.hardwareSerial);
        connected++;
        verified = true;
        break;
      }
      // Disconnect only a transport introduced by this pass. Another task may
      // already be using a different device that inherited an old IP address.
      if (!wasConnected) await adb(adbPath, ['disconnect', serial], run);
    }
    if (!verified) missing++;
  }
  return { connected, missing };
}

module.exports = { reconcileAdbPresence, discoveredAddress, connectedIdentities };
