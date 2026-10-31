import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { arcRecoveryDecision, inspectAndRestoreArc } from '../src/webos-arc-guard.mjs';

test('ARC recovery applies only to the watched set-top input after ARC was observed', () => {
  const base = { powerState: 'Active', foregroundApp: 'com.webos.app.hdmi3',
    output: 'tv_external_speaker', savedArcAudio: { volume: 5, mute: false } };
  assert.equal(arcRecoveryDecision(base), 'restore-arc');
  assert.equal(arcRecoveryDecision({ ...base, foregroundApp: 'com.webos.app.hdmi1' }), 'other-input');
  assert.equal(arcRecoveryDecision({ ...base, savedArcAudio: null }), 'unarmed');
  assert.equal(arcRecoveryDecision({ ...base, output: 'bt_soundbar' }), 'other-output');
  assert.equal(arcRecoveryDecision({ ...base, output: 'external_arc', arcDevicePower: 1 }),
    'restore-standby-arc');
  assert.equal(arcRecoveryDecision({ ...base, output: 'external_arc', arcDevicePower: 0 }),
    'remember-arc');
  assert.equal(arcRecoveryDecision({ ...base, powerState: 'Screen Off',
    output: 'external_arc', arcDevicePower: 0 }), 'remember-arc');
  assert.equal(arcRecoveryDecision({ ...base, powerState: 'Standby' }), 'tv-inactive');
});

test('scheduled ARC inspection never changes TV audio while the set-top is on screen', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webos-arc-observe-'));
  const stateFile = path.join(directory, 'audio.json');
  const calls = [];
  let output = 'external_arc';
  let soundbarPower = 0;
  const connection = {
    async request(uri) {
      calls.push(uri);
      if (uri === 'com.webos.service.tvpower/power/getPowerState') return reply({ state: 'Active' });
      if (uri === 'com.webos.applicationManager/getForegroundAppInfo') {
        return reply({ appId: 'com.webos.app.hdmi3' });
      }
      if (uri === 'com.webos.service.apiadapter/audio/getSoundOutput') {
        return reply({ soundOutput: output });
      }
      if (uri === 'com.webos.service.eim/getAllInputStatus') {
        return reply({ arcDevice: true, arcDevicePower: soundbarPower });
      }
      if (uri === 'audio/getStatus') return reply({ volume: 0, mute: false });
      throw new Error(`Unexpected TV write: ${uri}`);
    },
  };
  try {
    const connect = (action) => action(connection);
    const observed = await inspectAndRestoreArc({ stateFile, connect });
    assert.equal(observed.audioControl, 'none');
    output = 'tv_external_speaker';
    soundbarPower = 1;
    const fallback = await inspectAndRestoreArc({ stateFile, connect });
    assert.equal(fallback.action, 'restore-arc');
    assert.equal(fallback.audioControl, 'none');
    assert.ok(!calls.some((uri) => uri.startsWith('audio/set')
      || uri.startsWith('audio/volume') || uri.endsWith('/changeSoundOutput')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit ARC recovery restores prior audio after fallback without keepalive mute pulses', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webos-arc-guard-'));
  const stateFile = path.join(directory, 'audio.json');
  const tv = { output: 'external_arc', volume: 5, mute: true, powerState: 'Active',
    foreground: 'com.webos.app.hdmi3', arcDevicePower: 0 };
  const calls = [];
  let currentTimeMs = 1_000_000;
  const connection = {
    async request(uri, data) {
      calls.push(uri);
      if (uri === 'com.webos.service.tvpower/power/getPowerState') {
        return reply({ state: tv.powerState });
      }
      if (uri === 'com.webos.applicationManager/getForegroundAppInfo') return reply({ appId: tv.foreground });
      if (uri === 'com.webos.service.apiadapter/audio/getSoundOutput') return reply({ soundOutput: tv.output });
      if (uri === 'com.webos.service.eim/getAllInputStatus') {
        return reply({ arcDevice: true, arcDevicePower: tv.arcDevicePower });
      }
      if (uri === 'audio/getStatus') return reply({ volume: tv.volume, mute: tv.mute });
      if (uri === 'com.webos.service.apiadapter/audio/changeSoundOutput') {
        tv.output = data.output; tv.volume = 0; tv.mute = true;
        return reply({});
      }
      if (uri === 'audio/volumeUp') { if (!tv.mute) tv.volume += 1; return reply({}); }
      if (uri === 'audio/volumeDown') { if (!tv.mute) tv.volume -= 1; return reply({}); }
      if (uri === 'audio/setMute') {
        tv.mute = data.mute;
        if (!data.mute && tv.output === 'external_arc') tv.arcDevicePower = 0;
        return reply({});
      }
      throw new Error(`Unexpected operation: ${uri}`);
    },
  };
  const connect = (action) => action(connection);
  const timing = { now: () => currentTimeMs, sleep: async () => {} };
  try {
    assert.equal((await inspectAndRestoreArc({ stateFile, connect, ...timing, repair: true })).action, 'remember-arc');
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')),
      { volume: 5, mute: true, keepaliveAtMs: null });
    tv.volume = 0; tv.mute = false;
    tv.powerState = 'Screen Off';
    await inspectAndRestoreArc({ stateFile, connect, ...timing, repair: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')),
      { volume: 5, mute: true, keepaliveAtMs: null });
    assert.equal(tv.mute, false);
    const muteCallsAfterPulse = calls.filter((uri) => uri === 'audio/setMute').length;
    currentTimeMs += 9 * 60 * 1000;
    tv.mute = false;
    await inspectAndRestoreArc({ stateFile, connect, ...timing, repair: true });
    assert.equal(tv.mute, false);
    assert.equal(calls.filter((uri) => uri === 'audio/setMute').length, muteCallsAfterPulse);
    currentTimeMs += 60 * 1000;
    await inspectAndRestoreArc({ stateFile, connect, ...timing, repair: true });
    assert.equal(calls.filter((uri) => uri === 'audio/setMute').length, muteCallsAfterPulse);
    tv.output = 'tv_external_speaker'; tv.volume = 5; tv.mute = false;
    const result = await inspectAndRestoreArc({ stateFile, connect, ...timing, repair: true });
    assert.deepEqual(result, { action: 'restored', output: 'external_arc',
      volume: 5, mute: true, arcDevicePower: 0 });
    assert.equal(calls.filter((uri) => uri === 'audio/volumeUp').length, 5);
    tv.arcDevicePower = 1;
    const dormant = await inspectAndRestoreArc({ stateFile, connect, ...timing, repair: true });
    assert.equal(dormant.arcDevicePower, 0);
    assert.equal(tv.output, 'external_arc');
    assert.equal(calls.filter((uri) => uri === 'com.webos.service.apiadapter/audio/changeSoundOutput').length, 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ARC recovery does not report success while the soundbar stays in standby', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webos-arc-standby-'));
  const stateFile = path.join(directory, 'audio.json');
  fs.writeFileSync(stateFile, JSON.stringify({ volume: 1, mute: true }));
  let output = 'tv_external_speaker';
  const connection = {
    async request(uri, data) {
      if (uri === 'com.webos.service.tvpower/power/getPowerState') return reply({ state: 'Active' });
      if (uri === 'com.webos.applicationManager/getForegroundAppInfo') {
        return reply({ appId: 'com.webos.app.hdmi3' });
      }
      if (uri === 'com.webos.service.apiadapter/audio/getSoundOutput') {
        return reply({ soundOutput: output });
      }
      if (uri === 'com.webos.service.eim/getAllInputStatus') {
        return reply({ arcDevice: true, arcDevicePower: 1 });
      }
      if (uri === 'audio/getStatus') return reply({ volume: 1, mute: true });
      if (uri === 'audio/setMute') return reply({ mute: data.mute });
      if (uri === 'com.webos.service.apiadapter/audio/changeSoundOutput') {
        output = data.output;
        return reply({});
      }
      throw new Error(`Unexpected operation: ${uri}`);
    },
  };
  try {
    await assert.rejects(inspectAndRestoreArc({ stateFile, repair: true,
      connect: (action) => action(connection), sleep: async () => {} }),
    /soundbar remained in standby/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ARC recovery does not reassert mute while ARC is already healthy', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webos-arc-mute-'));
  const stateFile = path.join(directory, 'audio.json');
  const tv = { output: 'external_arc', volume: 0, mute: true, arcDevicePower: 0 };
  let elapsedMs = 0;
  let delayedUnmuteAtMs = null;
  let delayedUnmuteCount = 0;
  const connection = {
    async request(uri, data) {
      if (uri === 'com.webos.service.tvpower/power/getPowerState') {
        return reply({ state: 'Screen Off' });
      }
      if (uri === 'com.webos.applicationManager/getForegroundAppInfo') {
        return reply({ appId: 'com.webos.app.hdmi3' });
      }
      if (uri === 'com.webos.service.apiadapter/audio/getSoundOutput') {
        return reply({ soundOutput: tv.output });
      }
      if (uri === 'com.webos.service.eim/getAllInputStatus') {
        return reply({ arcDevice: true, arcDevicePower: tv.arcDevicePower });
      }
      if (uri === 'audio/getStatus') return reply({ volume: tv.volume, mute: tv.mute });
      if (uri === 'com.webos.service.apiadapter/audio/changeSoundOutput') {
        tv.output = data.output;
        if (data.output === 'external_arc') delayedUnmuteAtMs = elapsedMs + 12_000;
        return reply({});
      }
      if (uri === 'audio/setMute') {
        tv.mute = data.mute;
        if (tv.output === 'external_arc' && !data.mute) tv.arcDevicePower = 0;
        return reply({});
      }
      throw new Error(`Unexpected operation: ${uri}`);
    },
  };
  const connect = (action) => action(connection);
  const timing = { now: () => 1_000_000, sleep: async (milliseconds) => {
    elapsedMs += milliseconds;
    if (delayedUnmuteAtMs !== null && elapsedMs >= delayedUnmuteAtMs) {
      tv.mute = false;
      delayedUnmuteAtMs = null;
      delayedUnmuteCount += 1;
    }
  } };
  try {
    await inspectAndRestoreArc({ stateFile, connect, ...timing, repair: true });
    tv.output = 'tv_external_speaker';
    tv.arcDevicePower = 1;
    tv.mute = false;
    const restored = await inspectAndRestoreArc({ stateFile, connect, ...timing, repair: true });
    assert.ok(elapsedMs >= 24_000);
    assert.equal(delayedUnmuteCount, 1);
    assert.deepEqual({ volume: restored.volume, mute: restored.mute, power: restored.arcDevicePower },
      { volume: 0, mute: true, power: 0 });
    assert.equal(tv.mute, true);
    tv.mute = false;
    await inspectAndRestoreArc({ stateFile, connect, ...timing, repair: true });
    assert.equal(tv.mute, false);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).mute, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function reply(fields) { return { type: 'response', payload: { returnValue: true, ...fields } }; }
