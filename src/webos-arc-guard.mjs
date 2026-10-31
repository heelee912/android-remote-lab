import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withRegisteredWebOs } from './webos-direct.mjs';

const ARC_OUTPUT = 'external_arc';
const FALLBACK_OUTPUT = 'tv_external_speaker';
const SETTOP_INPUT = 'com.webos.app.hdmi3';
const ARC_AVAILABLE_POWER_STATES = new Set(['Active', 'Screen Off']);

export function arcGuardStatePath(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'AndroidRemoteLab', 'webos-arc-guard.json');
}

function payload(response, operation) {
  if (response.type === 'error' || response.payload?.returnValue === false) {
    throw new Error(`${operation}: ${response.error || response.payload?.errorText || 'TV rejected request'}`);
  }
  return response.payload;
}

function readSavedArcAudio(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(saved.volume) || saved.volume < 0 || saved.volume > 100
        || typeof saved.mute !== 'boolean') return null;
    return { volume: saved.volume, mute: saved.mute,
      keepaliveAtMs: Number.isSafeInteger(saved.keepaliveAtMs) && saved.keepaliveAtMs >= 0
        ? saved.keepaliveAtMs : null };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function saveArcAudio(file, audio) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ volume: audio.volume, mute: audio.mute,
    keepaliveAtMs: audio.keepaliveAtMs ?? null }), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function arcRecoveryDecision({ powerState, foregroundApp, output, arcDevicePower, savedArcAudio }) {
  if (!ARC_AVAILABLE_POWER_STATES.has(powerState)) return 'tv-inactive';
  if (foregroundApp !== SETTOP_INPUT) return 'other-input';
  if (output === ARC_OUTPUT && arcDevicePower === 1 && savedArcAudio) return 'restore-standby-arc';
  if (output === ARC_OUTPUT) return 'remember-arc';
  if (output !== FALLBACK_OUTPUT) return 'other-output';
  return savedArcAudio ? 'restore-arc' : 'unarmed';
}

async function request(connection, operation, data = {}) {
  return payload(await connection.request(operation, data), operation);
}

async function restoreVolume(connection, target) {
  const audio = await request(connection, 'audio/getStatus');
  if (!Number.isInteger(audio.volume) || audio.volume < 0 || audio.volume > 100) {
    throw new Error('TV did not report a valid ARC volume');
  }
  await request(connection, 'audio/setMute', { mute: true });
  await request(connection, 'audio/setMute', { mute: false });
  let restored = false;
  try {
    const step = audio.volume < target.volume ? 'audio/volumeUp' : 'audio/volumeDown';
    for (let level = audio.volume; level !== target.volume;
      level += step === 'audio/volumeUp' ? 1 : -1) {
      await request(connection, step);
    }
    const readback = await request(connection, 'audio/getStatus');
    if (readback.volume !== target.volume) throw new Error('ARC volume did not reach the saved level');
    restored = true;
  } finally {
    await request(connection, 'audio/setMute', { mute: restored ? target.mute : true });
  }
}

async function readArcDevicePower(connection) {
  const status = await request(connection, 'com.webos.service.eim/getAllInputStatus');
  return status.arcDevice === true && Number.isInteger(status.arcDevicePower)
    ? status.arcDevicePower : null;
}

async function waitForArcPower(connection, sleep) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const arcDevicePower = await readArcDevicePower(connection);
    if (arcDevicePower === 0) return arcDevicePower;
    if (attempt < 5) await sleep(2000);
  }
  throw new Error('ARC output was restored but the soundbar remained in standby');
}

async function confirmRestoredAudio(connection, target, sleep) {
  // LG can clear mute several seconds after ARC reports that the soundbar is awake.
  const settlingChecks = target.volume === 0 && target.mute ? 12 : 3;
  for (let attempt = 0; attempt < settlingChecks; attempt += 1) {
    await sleep(2000);
    const audio = await request(connection, 'audio/getStatus');
    if (audio.volume === target.volume && audio.mute === target.mute) continue;
    if (audio.volume !== target.volume) await restoreVolume(connection, target);
    else await request(connection, 'audio/setMute', { mute: target.mute });
  }
  const audio = await request(connection, 'audio/getStatus');
  if (audio.volume !== target.volume || audio.mute !== target.mute) {
    throw new Error('ARC volume or mute changed after soundbar wake');
  }
  return audio;
}

export async function inspectAndRestoreArc({ stateFile = arcGuardStatePath(),
  connect = withRegisteredWebOs, sleep = delay, repair = false } = {}) {
  const savedArcAudio = readSavedArcAudio(stateFile);
  return connect(async (connection) => {
    const power = await request(connection, 'com.webos.service.tvpower/power/getPowerState');
    if (!ARC_AVAILABLE_POWER_STATES.has(power.state)) return { action: 'tv-inactive' };
    const foreground = await request(connection, 'com.webos.applicationManager/getForegroundAppInfo');
    if (foreground.appId !== SETTOP_INPUT) return { action: 'other-input' };
    const output = await request(connection, 'com.webos.service.apiadapter/audio/getSoundOutput');
    const arcDevicePower = await readArcDevicePower(connection);
    const decision = arcRecoveryDecision({ powerState: power.state, foregroundApp: foreground.appId,
      output: output.soundOutput, arcDevicePower, savedArcAudio });
    if (!repair) {
      if (decision === 'remember-arc') {
        const audio = await request(connection, 'audio/getStatus');
        if (Number.isInteger(audio.volume) && typeof audio.mute === 'boolean') {
          saveArcAudio(stateFile, { volume: audio.volume, mute: audio.mute,
            keepaliveAtMs: savedArcAudio?.keepaliveAtMs ?? null });
        }
      }
      return { action: decision, output: output.soundOutput, arcDevicePower,
        audioControl: 'none' };
    }
    if (decision === 'remember-arc') {
      const audio = await request(connection, 'audio/getStatus');
      if (Number.isInteger(audio.volume) && typeof audio.mute === 'boolean') {
        const transientZero = audio.volume === 0 && savedArcAudio?.volume > 0;
        // LG can clear mute during an ARC handshake while leaving volume at zero.
        const preserveZeroMute = audio.volume === 0 && savedArcAudio?.volume === 0
          && savedArcAudio.mute === true;
        saveArcAudio(stateFile, { ...(transientZero || preserveZeroMute ? savedArcAudio : audio),
          keepaliveAtMs: null });
      }
      return { action: decision, output: output.soundOutput, arcDevicePower };
    }
    if (decision !== 'restore-arc' && decision !== 'restore-standby-arc') {
      return { action: decision, output: output.soundOutput, arcDevicePower };
    }
    if (decision === 'restore-standby-arc') {
      await request(connection, 'audio/setMute', { mute: true });
      await request(connection, 'com.webos.service.apiadapter/audio/changeSoundOutput',
        { output: FALLBACK_OUTPUT });
    }
    await request(connection, 'com.webos.service.apiadapter/audio/changeSoundOutput', { output: ARC_OUTPUT });
    const readback = await request(connection, 'com.webos.service.apiadapter/audio/getSoundOutput');
    if (readback.soundOutput !== ARC_OUTPUT) throw new Error('ARC output did not persist after recovery');
    await restoreVolume(connection, savedArcAudio);
    const restoredArcDevicePower = await waitForArcPower(connection, sleep);
    const audio = await confirmRestoredAudio(connection, savedArcAudio, sleep);
    return { action: 'restored', output: readback.soundOutput,
      volume: audio.volume, mute: audio.mute, arcDevicePower: restoredArcDevicePower };
  });
}
