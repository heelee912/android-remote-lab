import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { readWebOsState, webOsStatePath } from './webos-direct.mjs';

const execFileAsync = promisify(execFile);

export function webOsLunaConfigPath() {
  return path.join(path.dirname(webOsStatePath()), 'webos-luna-ssh.json');
}

function validateConfig(config) {
  if (!['root', 'prisoner'].includes(config.user)) throw new Error('Luna SSH user must be root or prisoner');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid Luna SSH port');
  for (const field of ['identityFile', 'knownHostsFile']) {
    if (typeof config[field] !== 'string' || !path.isAbsolute(config[field]) || !fs.statSync(config[field]).isFile()) {
      throw new Error(`${field} must be an existing absolute file path`);
    }
  }
  return config;
}

export function configureWebOsLuna(user, port, identityFile, knownHostsFile, file = webOsLunaConfigPath()) {
  const config = validateConfig({ user, port: Number(port), identityFile, knownHostsFile });
  readWebOsState();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return { configured: true, user, port: config.port };
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

export async function requestWebOsLuna(uri, payload, { state = readWebOsState(),
  config = JSON.parse(fs.readFileSync(webOsLunaConfigPath(), 'utf8')),
  execute = execFileAsync } = {}) {
  validateConfig(config);
  if (net.isIP(state.host) !== 4) throw new Error('Paired webOS host must be an IPv4 address');
  if (typeof uri !== 'string' || !/^luna:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(uri)) {
    throw new Error('Luna URI must be luna://SERVICE/METHOD');
  }
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('Luna payload must be a JSON object');
  const program = config.user === 'root' ? 'luna-send' : 'luna-send-pub';
  const command = `${program} -n 1 -f ${shellQuote(uri)} ${shellQuote(JSON.stringify(payload))}`;
  let stdout;
  try {
    ({ stdout } = await execute('ssh', ['-F', 'NUL', '-T', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${config.knownHostsFile}`,
      '-o', 'GlobalKnownHostsFile=NUL', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=8',
      '-p', String(config.port), '-i', config.identityFile, `${config.user}@${state.host}`, command],
    { timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }));
  } catch (error) {
    throw new Error(`Luna SSH request failed; remote outcome may be unconfirmed: ${error.stderr?.trim() || error.message}`);
  }
  let response;
  try { response = JSON.parse(stdout); } catch { throw new Error('Luna returned a non-JSON response'); }
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Luna returned an invalid response');
  if (response.returnValue === false) throw new Error(`Luna request rejected: ${response.errorText || JSON.stringify(response)}`);
  return { transport: 'ssh', user: config.user, response };
}
