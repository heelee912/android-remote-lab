'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultBaseDir() {
  return process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'AndroidRemoteLab')
    : path.join(os.homedir(), '.android-remote-lab');
}

function configPath() {
  return process.env.ANDROID_REMOTE_LAB_CONFIG || path.join(defaultBaseDir(), 'config.json');
}

function loadConfig(required = true) {
  const file = configPath();
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`Android Remote Lab is not configured. Run: arlab setup`);
    return null;
  }
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  for (const key of ['stateDir', 'runtimeDir', 'relayHost']) {
    if (!value[key] || typeof value[key] !== 'string') throw new Error(`Invalid config field: ${key}`);
  }
  return {
    ...value,
    configPath: file,
    ingressPort: Number(value.ingressPort || 7001),
    apiPort: Number(value.apiPort || 7011),
    publicPort: Number(value.publicPort || 10000),
  };
}

function ownerId() {
  const raw = process.env.ANDROID_REMOTE_LAB_OWNER
    || process.env.CODEX_THREAD_ID
    || `interactive-shell-${process.ppid}`;
  return String(raw).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 128);
}

module.exports = { configPath, defaultBaseDir, loadConfig, ownerId };
