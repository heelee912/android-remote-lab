'use strict';

const fs = require('node:fs');
const path = require('node:path');

const maximumInputBytes = 8 * 1024 * 1024;

function isPersistentDeviceShellRequest(request = {}) {
  return Array.isArray(request.argv) && ['shell', 'exec-out'].includes(request.argv[0]);
}

function commandArguments(request) {
  if (!isPersistentDeviceShellRequest(request)) throw new Error('persistent-device-shell-command-required');
  const command = request.argv.slice(1);
  if (!command.length) throw new Error('persistent-device-shell-command-required');
  return command.length === 1 ? ['/system/bin/sh', '-c', command[0]] : command;
}

function decodedExecution(result, request) {
  const stdout = Buffer.from(result.stdoutBase64 || '', 'base64');
  const stderr = Buffer.from(result.stderrBase64 || '', 'base64');
  if (request.outputFile) fs.writeFileSync(request.outputFile, stdout, { flag: 'wx', mode: 0o600 });
  const stdoutText = stdout.toString('utf8');
  const execution = {
    transport: 'companion-device-shell',
    connectionRoute: 'companion-device-shell',
    executionIdentity: result.executionIdentity || { kind: 'companion-application', requiresAdbd: false },
    ...(result.adapter ? { adapter: result.adapter } : {}),
    exitCode: result.exitCode === null ? null : Number(result.exitCode),
    signal: null,
    ...(request.outputFile
      ? { outputFile: request.outputFile, outputBytes: stdout.length,
        completed: Number(result.exitCode) === 0 && !result.error }
      : { stdout: stdoutText,
        ...(!stdout.equals(Buffer.from(stdoutText, 'utf8')) ? { stdoutBase64: stdout.toString('base64') } : {}) }),
    stderr: stderr.toString('utf8'),
    ...(result.error ? { error: result.error, outcome: result.outcome || 'confirmed-failed' } : {}),
  };
  if (!execution.error && execution.exitCode === 0
      && /(?:Permission Denial|java\.lang\.SecurityException|Security exception)/i
        .test(`${execution.stdout || ''}\n${execution.stderr || ''}`)) {
    execution.error = 'android-command-permission-denied';
    execution.outcome = 'confirmed-failed';
  }
  return { ok: !execution.error && execution.exitCode === 0, result: execution };
}

async function executePersistentDeviceShell(request, invokeCompanion) {
  const timeoutMs = request.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
    throw new Error('adb-invalid-timeout');
  }
  for (const [key, value] of [['outputFile', request.outputFile], ['inputFile', request.inputFile]]) {
    if (value !== undefined && (typeof value !== 'string' || !path.isAbsolute(value))) {
      throw new Error(`adb-${key}-must-be-absolute`);
    }
  }
  let input;
  if (request.inputFile) {
    const details = fs.statSync(request.inputFile, { throwIfNoEntry: false });
    if (!details?.isFile() || details.size > maximumInputBytes) {
      throw new Error('persistent-device-shell-input-limit-exceeded');
    }
    input = fs.readFileSync(request.inputFile);
  }
  try {
    const response = await invokeCompanion('persistent_device_shell_exec', {
      argv: commandArguments(request),
      timeoutMillis: timeoutMs,
      ...(input ? { stdinBase64: input.toString('base64') } : {}),
    }, timeoutMs + 10_000);
    return response.ok ? decodedExecution(response.result, request) : response;
  } finally {
    input?.fill(0);
  }
}

module.exports = { executePersistentDeviceShell, isPersistentDeviceShellRequest };
