import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('eligible Android updates have the ordinary installer update permission', () => {
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /<uses-permission\b[^>]*android:name="android\.permission\.UPDATE_PACKAGES_WITHOUT_USER_ACTION"/);
  assert.doesNotMatch(manifest, /android:name="android\.permission\.INSTALL_PACKAGES"/);
});

test('launch can resolve launcher activities without fixed target packages', () => {
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  const queries = manifest.match(/<queries\b[^>]*>([\s\S]*?)<\/queries>/)?.[1] ?? '';
  const intents = [...queries.matchAll(/<intent\b[^>]*>([\s\S]*?)<\/intent>/g)];
  assert.ok(intents.some(([, intent]) =>
    /<action\b[^>]*android:name="android\.intent\.action\.MAIN"/.test(intent)
    && /<category\b[^>]*android:name="android\.intent\.category\.LAUNCHER"/.test(intent)),
  'PackageManager launcher lookup requires a MAIN/LAUNCHER visibility query');
});

test('relay network policy accepts validated internet and rejects offline or captive connectivity', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'arlab-network-policy-'));
  const binary = name => process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? `${name}.exe` : name) : name;
  try {
    const harness = path.join(directory, 'RelayNetworkPolicyProbe.java');
    writeFileSync(harness, `package com.codex.remotecompanion;
public final class RelayNetworkPolicyProbe {
  public static void main(String[] args) {
    if (!RelayNetworkPolicy.canConnect(true, true)) throw new AssertionError("Validated internet must connect without a transport restriction");
    if (RelayNetworkPolicy.canConnect(true, false)) throw new AssertionError("Captive internet must wait");
    if (RelayNetworkPolicy.canConnect(false, true)) throw new AssertionError("Missing internet capability must wait");
    if (RelayNetworkPolicy.canConnect(false, false)) throw new AssertionError("Offline must wait");
  }
}`);
    const policy = fileURLToPath(new URL('../android/app/src/main/java/com/codex/remotecompanion/RelayNetworkPolicy.java', import.meta.url));
    execFileSync(binary('javac'), ['-d', directory, policy, harness], { windowsHide: true, timeout: 15000 });
    execFileSync(binary('java'), ['-cp', directory, 'com.codex.remotecompanion.RelayNetworkPolicyProbe'],
      { windowsHide: true, timeout: 15000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
