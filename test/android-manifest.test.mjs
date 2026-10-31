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
    execFileSync(binary('javac'), ['-d', directory, policy, harness], { windowsHide: true, timeout: 60000 });
    execFileSync(binary('java'), ['-cp', directory, 'com.codex.remotecompanion.RelayNetworkPolicyProbe'],
      { windowsHide: true, timeout: 60000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('ADB recovery restarts stale enabled listeners and keeps TCP alive across Wi-Fi loss', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'arlab-adb-recovery-'));
  const binary = name => process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? `${name}.exe` : name) : name;
  try {
    const harness = path.join(directory, 'AdbListenerRecoveryProbe.java');
    writeFileSync(harness, `package com.codex.remotecompanion;
public final class AdbListenerRecoveryProbe {
  static final class Phone implements AdbListenerRecovery.Device {
    boolean adb, wireless = true, cycled, failWrite;
    boolean readAdbSetting;
    int adbSetting, adbWrites, port, readyAfter = 1800, wirelessWrites, probeMillis;
    long elapsed;
    public int listeningPort() { elapsed += probeMillis; return port > 0 ? port : cycled && wireless && elapsed >= readyAfter ? 5555 : 0; }
    public boolean adbEnabled() { return readAdbSetting ? AdbListenerRecovery.settingEnabled(adbSetting) : adb; }
    public boolean wirelessEnabled() { return wireless; }
    public void setAdbEnabled(boolean value) { if (failWrite) throw new IllegalStateException("setting rejected"); adbWrites++; adb = value; if (readAdbSetting) adbSetting = value ? 1 : 0; }
    public void setWirelessEnabled(boolean value) { wirelessWrites++; if (!value) cycled = true; wireless = value; }
    public long monotonicMillis() { return elapsed; }
    public void await(long millis) { elapsed += millis; }
  }
  public static void main(String[] args) throws Exception {
    Phone stale = new Phone();
    if (AdbListenerRecovery.recover(stale, true) != 5555 || !stale.adb || !stale.cycled || stale.wirelessWrites != 2)
      throw new AssertionError("Enabled-but-dead listener requires a real off/on transition and ADB service retention");
    Phone healthy = new Phone(); healthy.port = 5555;
    if (AdbListenerRecovery.recover(healthy, true) != 5555 || !healthy.adb || healthy.wirelessWrites != 0 || healthy.elapsed != 0)
      throw new AssertionError("Working TCP must be retained without restarting wireless debugging");
    Phone nonstandard = new Phone(); nonstandard.port = 5555; nonstandard.readAdbSetting = true; nonstandard.adbSetting = 2;
    if (AdbListenerRecovery.recover(nonstandard, true) != 5555 || nonstandard.adbSetting != 2 || nonstandard.adbWrites != 0)
      throw new AssertionError("An active positive ADB setting must not be rewritten during recovery");
    if (AdbListenerRecovery.settingEnabled(0) || AdbListenerRecovery.settingEnabled(-1)
        || !AdbListenerRecovery.settingEnabled(1) || !AdbListenerRecovery.settingEnabled(2))
      throw new AssertionError("ADB settings must follow Android's positive-value semantics");
    Phone denied = new Phone();
    if (AdbListenerRecovery.recover(denied, false) != 0 || denied.adb || denied.wirelessWrites != 0)
      throw new AssertionError("An absent Android grant must produce no settings writes");
    Phone late = new Phone(); late.readyAfter = 4000;
    if (AdbListenerRecovery.recover(late, true) != 5555) throw new AssertionError("Listener startup can exceed one second");
    Phone missing = new Phone(); missing.readyAfter = Integer.MAX_VALUE;
    if (AdbListenerRecovery.recover(missing, true) != 0 || missing.elapsed > 5000)
      throw new AssertionError("Unavailable listener must remain a bounded failure");
    Phone slow = new Phone(); slow.readyAfter = Integer.MAX_VALUE; slow.probeMillis = 500;
    if (AdbListenerRecovery.recover(slow, true) != 0 || slow.elapsed > 6000)
      throw new AssertionError("The deadline must include time spent probing, not only explicit sleeps");
    Phone failed = new Phone(); failed.failWrite = true;
    try { AdbListenerRecovery.recover(failed, true); throw new AssertionError("Settings failure was hidden"); }
    catch (IllegalStateException expected) { }
  }
}`);
    const source = fileURLToPath(new URL('../android/app/src/main/java/com/codex/remotecompanion/AdbListenerRecovery.java', import.meta.url));
    execFileSync(binary('javac'), ['-d', directory, source, harness], { windowsHide: true, timeout: 60000 });
    execFileSync(binary('java'), ['-cp', directory, 'com.codex.remotecompanion.AdbListenerRecoveryProbe'],
      { windowsHide: true, timeout: 60000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
