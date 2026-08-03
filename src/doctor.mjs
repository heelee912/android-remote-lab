import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadConfig } = require('./config.js');

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
}

function powershell(script) {
  return run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
}

function apiStatus(config) {
  const tokenPath = path.join(config.stateDir, 'local-api-token.txt');
  if (!fs.existsSync(tokenPath)) return Promise.resolve({ ok: false, error: 'local-api-token-missing' });
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port: config.apiPort,
      path: '/status',
      method: 'GET',
      headers: { 'x-companion-token': token },
      timeout: 3000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve({ ok: false, error: 'invalid-local-api-response' }); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ ok: false, error: error.code || error.message }));
    request.end();
  });
}

function taskState(config, repair) {
  const escaped = String(config.taskName || 'AndroidRemoteLabRelay').replace(/'/g, "''");
  let result = powershell(`$t=Get-ScheduledTask -TaskName '${escaped}' -ErrorAction SilentlyContinue; if($t){$t.State.ToString()}else{'Missing'}`);
  let state = result.stdout.trim() || 'Unknown';
  if (repair && state !== 'Running' && state !== 'Missing') {
    powershell(`Start-ScheduledTask -TaskName '${escaped}'`);
    result = powershell(`(Get-ScheduledTask -TaskName '${escaped}').State.ToString()`);
    state = result.stdout.trim() || state;
  }
  return state;
}

function funnelState(config, repair) {
  let result = run('tailscale.exe', ['funnel', 'status', '--json']);
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch {}
  const expected = `127.0.0.1:${config.ingressPort}`;
  let forward = parsed?.TCP?.[String(config.publicPort)]?.TCPForward || null;
  if (repair && forward !== expected) {
    run('tailscale.exe', [
      'funnel', '--bg', '--yes', '--tls-terminated-tcp', String(config.publicPort),
      `tcp://127.0.0.1:${config.ingressPort}`,
    ]);
    result = run('tailscale.exe', ['funnel', 'status', '--json']);
    try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
    forward = parsed?.TCP?.[String(config.publicPort)]?.TCPForward || null;
  }
  return {
    ok: forward === expected,
    expected,
    actual: forward,
    tlsHost: parsed?.TCP?.[String(config.publicPort)]?.TerminateTLS || null,
  };
}

function processState(config) {
  const runtime = String(config.runtimeDir).replace(/'/g, "''");
  const script = [
    `$p=@(Get-CimInstance Win32_Process)`,
    `$launcher=@($p|?{$_.Name -eq 'CompanionRelayLauncher.exe' -and $_.ExecutablePath -like '${runtime}*'})`,
    `$relay=@($p|?{$_.Name -eq 'node.exe' -and $_.CommandLine -like '*AndroidRemoteLab*relay.js*'})`,
    `$ids=@($launcher.ProcessId)+@($relay.ProcessId)`,
    `$conhost=@($p|?{$_.Name -eq 'conhost.exe' -and $ids -contains $_.ParentProcessId})`,
    `[pscustomobject]@{launchers=$launcher.Count;relays=$relay.Count;consoleHosts=$conhost.Count}|ConvertTo-Json -Compress`,
  ].join(';');
  const result = powershell(script);
  try { return JSON.parse(result.stdout); }
  catch { return { launchers: 0, relays: 0, consoleHosts: null }; }
}

export function classifyState({ infrastructure, active, minimumCompanionVersionCode = 7 }) {
  if (!infrastructure) return 'INFRASTRUCTURE_UNHEALTHY';
  if (!active) return 'WAITING_FOR_PHONE';
  if (active.keyguardLocked === true) return 'PHONE_LOCKED';
  if (active.accessibilityReady === false) return 'ACCESSIBILITY_UNAVAILABLE';
  const deviceVerified = active.keyguardLocked === false && active.accessibilityReady === true;
  const companionVersionCode = Number(active.versionCode);
  if (deviceVerified && (!Number.isSafeInteger(companionVersionCode)
      || companionVersionCode < minimumCompanionVersionCode)) return 'COMPANION_UPDATE_REQUIRED';
  if (!deviceVerified) return 'CONNECTED_UNVERIFIED';
  return 'READY';
}

export async function doctor({ repair = false } = {}) {
  let config;
  try { config = loadConfig(); }
  catch (error) {
    return { ok: false, state: 'NOT_CONFIGURED', error: error.message };
  }
  let task = taskState(config, repair);
  if (repair && task === 'Running') await new Promise((resolve) => setTimeout(resolve, 1500));
  let local = await apiStatus(config);
  if (repair && !local.ok && task !== 'Missing') {
    task = taskState(config, true);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    local = await apiStatus(config);
  }
  const funnel = funnelState(config, repair);
  const processes = processState(config);
  const infrastructure = task === 'Running'
    && local.ok === true
    && funnel.ok
    && processes.launchers === 1
    && processes.relays === 1
    && processes.consoleHosts === 0;
  const minimumCompanionVersionCode = 7;
  const state = classifyState({ infrastructure, active: local.active, minimumCompanionVersionCode });
  return {
    ok: state === 'READY',
    state,
    endpoint: `${config.relayHost}:${config.publicPort}`,
    task,
    funnel,
    processes,
    device: local.active || null,
    controlLease: local.controlLease || null,
    pendingDevices: local.pendingDevices || [],
    limits: {
      preUnlockControl: false,
      unattendedApkInstall: false,
      secureWindowScreenshots: false,
      wirelessAdbRecovery: false,
      minimumCompanionVersionCode,
    },
  };
}
