'use strict';

const fs = require('node:fs');

const maximumInputBytes = 8 * 1024 * 1024;

function isPrivilegedShellRequest(request = {}) {
  return Array.isArray(request.argv) && ['shell', 'exec-out'].includes(request.argv[0]);
}

function brokerArguments(request) {
  if (!isPrivilegedShellRequest(request)) throw new Error('privileged-shell-command-required');
  const command = request.argv.slice(1);
  if (!command.length) throw new Error('privileged-shell-command-required');
  // A single adb-shell argument is a complete shell script (the same contract
  // used by --shell-file). Multiple arguments are executed without re-parsing,
  // preserving their exact boundaries and avoiding a second injection surface.
  return command.length === 1 ? ['/system/bin/sh', '-c', command[0]] : command;
}

function decodeResult(result, request) {
  const stdout = Buffer.from(result.stdoutBase64 || '', 'base64');
  const stderr = Buffer.from(result.stderrBase64 || '', 'base64');
  if (request.outputFile) {
    fs.writeFileSync(request.outputFile, stdout, { flag: 'wx', mode: 0o600 });
  }
  const stdoutText = stdout.toString('utf8');
  const stderrText = stderr.toString('utf8');
  return {
    transport: 'privileged-shell',
    connectionRoute: 'privileged-shell',
    exitCode: result.exitCode === null ? null : Number(result.exitCode),
    signal: null,
    ...(request.outputFile
      ? { outputFile: request.outputFile, outputBytes: stdout.length,
        completed: Number(result.exitCode) === 0 && !result.error }
      : { stdout: stdoutText,
        ...(!stdout.equals(Buffer.from(stdoutText, 'utf8')) ? { stdoutBase64: stdout.toString('base64') } : {}) }),
    stderr: stderrText,
    ...(result.error ? { error: result.error, outcome: result.outcome || 'confirmed-failed' } : {}),
  };
}

async function executePrivilegedShell(request, invokeCompanion) {
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 600_000) {
    throw new Error('adb-invalid-timeout');
  }
  if (request.outputFile !== undefined && (typeof request.outputFile !== 'string' || !require('node:path').isAbsolute(request.outputFile))) {
    throw new Error('adb-outputFile-must-be-absolute');
  }
  if (request.inputFile !== undefined && (typeof request.inputFile !== 'string' || !require('node:path').isAbsolute(request.inputFile))) {
    throw new Error('adb-inputFile-must-be-absolute');
  }
  let input;
  if (request.inputFile) {
    const details = fs.statSync(request.inputFile, { throwIfNoEntry: false });
    if (!details?.isFile() || details.size > maximumInputBytes) throw new Error('privileged-shell-input-limit-exceeded');
    input = fs.readFileSync(request.inputFile);
  }
  try {
    const response = await invokeCompanion('privileged_shell_exec', {
      argv: brokerArguments(request),
      timeoutMillis: request.timeoutMs,
      ...(input ? { stdinBase64: input.toString('base64') } : {}),
    }, request.timeoutMs + 10_000);
    if (!response.ok) return response;
    const execution = decodeResult(response.result, request);
    return { ok: !execution.error && execution.exitCode === 0, result: execution };
  } finally {
    input?.fill(0);
  }
}

function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function bootstrapPrivilegedShell(executeAdb, invokeCompanion) {
  const existing = await invokeCompanion('privileged_shell_status', {}, 5_000);
  if (existing.ok && existing.result?.ready && existing.result?.uid === 2000) {
    return { ok: true, result: { ready: true, uid: 2000, pid: existing.result.pid,
      connectionRoute: 'companion-privileged-shell' } };
  }
  const prepared = await invokeCompanion('privileged_shell_prepare', {}, 10_000);
  if (!prepared.ok) return prepared;
  const { port, token, classpath, mainClass } = prepared.result || {};
  if (!Number.isInteger(port) || port < 1024 || port > 65535
      || !/^[a-f0-9]{64}$/.test(token || '')
      || typeof classpath !== 'string' || !classpath.startsWith('/data/app/')
      || !/^com\.codex\.remotecompanion\.[A-Za-z0-9_$]+$/.test(mainClass || '')) {
    throw new Error('privileged-shell-invalid-bootstrap-configuration');
  }
  const script = `CLASSPATH=${quoteShell(classpath)} nohup app_process /system/bin ${quoteShell(mainClass)}`
    + ` --port ${port} --token ${token} </dev/null >/dev/null 2>&1 &`;
  const started = await executeAdb({ argv: ['shell', script], timeoutMs: 20_000, route: 'auto' });
  if (!started.ok) return started;
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = await invokeCompanion('privileged_shell_status', {}, 5_000);
    if (status.ok && status.result?.ready && status.result?.uid === 2000) {
      return { ok: true, result: { ready: true, uid: 2000, pid: status.result.pid,
        connectionRoute: 'companion-privileged-shell' } };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('privileged-shell-bootstrap-timeout');
}

module.exports = { bootstrapPrivilegedShell, executePrivilegedShell, isPrivilegedShellRequest };
