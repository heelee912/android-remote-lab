import assert from 'node:assert/strict';
import { classifyState, classifyBackgroundState, waitForDeviceReadiness } from '../src/doctor.mjs';

assert.equal(classifyState({ infrastructure: false, active: null }), 'INFRASTRUCTURE_UNHEALTHY');
assert.equal(classifyState({ infrastructure: true, active: null }), 'WAITING_FOR_PHONE');
assert.equal(classifyState({
  infrastructure: true,
  active: { keyguardLocked: true, accessibilityReady: true, versionCode: 7 },
}), 'LEGACY_LOCK_UNVERIFIED');
assert.equal(classifyState({
  infrastructure: true,
  active: { keyguardLocked: false, accessibilityReady: false, versionCode: 7 },
}), 'ACCESSIBILITY_UNAVAILABLE');
assert.equal(classifyState({
  infrastructure: true,
  active: { keyguardLocked: false, accessibilityReady: true, versionCode: 6 },
}), 'COMPANION_UPDATE_REQUIRED');
assert.equal(classifyState({
  infrastructure: true,
  active: { keyguardLocked: false, accessibilityReady: true, versionCode: null },
}), 'CONNECTED_UNVERIFIED');
assert.equal(classifyState({
  infrastructure: true,
  active: { keyguardLocked: null, accessibilityReady: null, versionCode: null },
}), 'CONNECTED_UNVERIFIED');
assert.equal(classifyState({
  infrastructure: true,
  active: { keyguardLocked: false, accessibilityReady: true, versionCode: 7 },
}), 'READY');

for (const active of [
  { versionCode: 15, secureKeyguardLocked: true, screenInteractive: false, userUnlocked: true, accessibilityReady: false },
  { versionCode: 9, secureKeyguardLocked: false, screenInteractive: false, userUnlocked: false },
  { versionCode: 7, keyguardLocked: true },
]) {
  assert.equal(classifyBackgroundState({ infrastructure: true, active }), 'BACKGROUND_READY');
  assert.notEqual(classifyState({ infrastructure: true, active }), 'READY');
}
assert.equal(classifyBackgroundState({ infrastructure: false, active: { versionCode: 15 } }), 'INFRASTRUCTURE_UNHEALTHY');
assert.equal(classifyBackgroundState({ infrastructure: true, active: null }), 'WAITING_FOR_PHONE');
assert.equal(classifyBackgroundState({ infrastructure: true, active: { versionCode: null } }), 'CONNECTED_UNVERIFIED');
let readCount = 0;
const reconnected = await waitForDeviceReadiness(async () => {
  readCount++;
  return { selectedDeviceId: 'phone', active: readCount === 1 ? null
    : { deviceId: 'phone', versionCode: readCount === 2 ? null : 20 } };
}, { selectedDeviceId: 'phone', active: null });
assert.equal(reconnected.active.versionCode, 20, 'Repair spans offline, authenticated and ready states');
assert.equal(readCount, 3);
await assert.rejects(waitForDeviceReadiness(async () => ({ selectedDeviceId: 'other', active: null }),
  { selectedDeviceId: 'phone', active: null }), /selected-device-changed/);
const offline = await waitForDeviceReadiness(async () => ({ selectedDeviceId: 'phone', active: null }),
  { selectedDeviceId: 'phone', active: null }, 20);
assert.equal(offline.active, null, 'An offline timeout remains an actual offline result');
process.stdout.write('doctor interactive and background state classification: PASS\n');
