import net from 'node:net';
import process from 'node:process';
import readline from 'node:readline/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pairTvRemote, pressTvRemote } from '../src/tv-remote-direct.mjs';

const clientPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/client.js');

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
}

function tunnelCommand(command, args) {
  const child = spawnSync(process.execPath,
    [clientPath, 'raw', command, JSON.stringify(args)],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (child.status !== 0) throw new Error((child.stderr || child.stdout || command).trim());
  const response = JSON.parse(child.stdout);
  if (!response.ok) throw new Error(response.error?.message || response.error || command);
  return response.result;
}

function openTunnel(purpose) {
  return tunnelCommand('tv_remote_tunnel_open', { purpose });
}

function closeTunnel(tunnel) {
  if (tunnel) tunnelCommand('tv_remote_tunnel_close', { tunnelId: tunnel.tunnelId });
}

export async function runTv(args, deviceId) {
  if (!/^[a-f0-9]{32}$/.test(deviceId || '')) {
    throw new Error('TV control requires --device with the full enrolled device ID');
  }
  const [action, ...rest] = args;
  if (action === 'pair') {
    const host = option(rest, '--host');
    if (host && !net.isIP(host) && !/^[a-z0-9.-]+$/i.test(host)) {
      throw new Error('tv pair --host requires a valid TV address');
    }
    const tunnel = host ? null : openTunnel('tv-pairing');
    try {
      const result = await pairTvRemote(deviceId, host || tunnel.host, async () => {
        process.stdout.write(`${JSON.stringify({ pairingCodeExpected: true })}\n`);
        const input = readline.createInterface({ input: process.stdin, terminal: false });
        try { return await input.question(''); }
        finally { input.close(); }
      }, tunnel ? { port: tunnel.port, route: 'companion-tunnel' } : {});
      process.stdout.write(`${JSON.stringify({ ok: true, result: { ...result,
        connectionRoute: tunnel ? 'companion-tunnel' : 'direct' } }, null, 2)}\n`);
    } finally { closeTunnel(tunnel); }
    return;
  }
  if (action === 'press') {
    if (rest.length !== 1) throw new Error('tv press requires one supported key');
    let tunnel;
    try {
      tunnel = openTunnel('tv-control');
    } catch (error) {
      if (!/tv-remote-tunnel-companion-update-required|Accessibility service is not enabled or not bound/.test(error.message)) throw error;
    }
    try {
      const result = await pressTvRemote(deviceId, rest[0], tunnel);
      process.stdout.write(`${JSON.stringify({ ok: true, result: { ...result,
        connectionRoute: tunnel ? 'companion-tunnel' : 'direct' } }, null, 2)}\n`);
    } finally { closeTunnel(tunnel); }
    return;
  }
  throw new Error('tv requires pair or press KEY');
}
