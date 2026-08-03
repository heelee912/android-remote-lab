import assert from 'node:assert/strict';
import { classifyState } from '../src/doctor.mjs';

assert.equal(classifyState({ infrastructure: false, active: null }), 'INFRASTRUCTURE_UNHEALTHY');
assert.equal(classifyState({ infrastructure: true, active: null }), 'WAITING_FOR_PHONE');
assert.equal(classifyState({
  infrastructure: true,
  active: { keyguardLocked: true, accessibilityReady: true, versionCode: 7 },
}), 'PHONE_LOCKED');
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
}), 'COMPANION_UPDATE_REQUIRED');
assert.equal(classifyState({
  infrastructure: true,
  active: { keyguardLocked: null, accessibilityReady: null, versionCode: null },
}), 'CONNECTED_UNVERIFIED');
assert.equal(classifyState({
  infrastructure: true,
  active: { keyguardLocked: false, accessibilityReady: true, versionCode: 7 },
}), 'READY');

process.stdout.write('doctor state classification: PASS\n');
