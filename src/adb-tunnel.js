'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

const maximumChunkBytes = 512 * 1024;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForAdbListener(initial, inspect, timeoutMs = 130_000, wait = pause, now = Date.now) {
  let status = initial;
  const deadline = now() + timeoutMs;
  // TLS must be handed to the PC promptly so it can request TCP mode. Once TCP
  // exists, wait for hotspot teardown before dispatching any caller mutation.
  while (status.mobileRecoveryRunning && (!status.ready || status.listenerType !== 'tls')) {
    if (now() >= deadline) throw new Error('adb-mobile-bootstrap-timeout');
    await wait(Math.min(500, deadline - now()));
    status = await inspect();
  }
  return status;
}

async function provisionTcpListener(initial, enableTcp, inspect, wait = pause) {
  if (initial.listenerType !== 'tls') return initial;
  let submitted;
  let submissionError;
  try { submitted = await enableTcp(); }
  catch (error) { submissionError = error.message; }
  // Restarting adbd can close the SDK stream before its receipt arrives. Poll
  // the phone's listener instead of repeating a possibly completed transition.
  for (let attempt = 0; attempt < 12; attempt++) {
    await wait(250);
    const status = await inspect();
    if (status.ready && status.listenerType === 'tcp') return status;
  }
  throw new Error(submitted?.result?.error || submissionError || 'adb-tcp-listener-provisioning-failed');
}

// The listener exists only on loopback, and only during the requesting owner's
// device lease. The existing signed Companion connection carries every byte.
async function createAdbTunnel(invoke, ownsDevice, onClose = () => {}, options = {}) {
  const purpose = options.purpose === 'pairing' ? 'pairing' : 'connect';
  const connections = new Set();
  const streams = new Set();
  let closed = false;
  let lastError = null;
  const statistics = { writtenBytes: 0, readBytes: 0, writeCalls: 0, readCalls: 0, partialWrites: 0 };
  let watchdog;
  const releaseStream = streamId => {
    if (!streams.delete(streamId)) return;
    invoke('adb_tunnel_close', { streamId }).catch(() => {});
  };
  const call = async (command, args = {}) => {
    if (closed || !ownsDevice()) throw new Error('adb-control-lease-expired');
    const response = await invoke(command, args);
    if (!response.ok) throw new Error(response.error?.message || response.error?.code || 'adb-tunnel-operation-failed');
    return response.result;
  };
  let status = purpose === 'pairing'
    ? await call('adb_tunnel_status')
    : await waitForAdbListener(await call('adb_tunnel_status', { repair: true }),
      () => call('adb_tunnel_status'));
  if (purpose === 'pairing') {
    for (let attempt = 0; attempt < 20 && !status.pairingPort; attempt++) {
      await pause(250);
      status = await call('adb_tunnel_status');
    }
  }
  const listenerPort = purpose === 'pairing' ? status.pairingPort : status.port || status.tlsPort;
  if (purpose === 'pairing' && (!Number.isInteger(listenerPort) || listenerPort < 1 || listenerPort > 65535)) {
    throw new Error('adb-pairing-service-unavailable');
  }
  if (purpose === 'connect' && !status.ready) throw new Error(status.mobileRecoveryError
    || (status.canRepair ? 'adb-listener-unavailable-after-repair' : 'adb-listener-provisioning-required'));
  const chunkBytes = status.chunkBytes ?? 48 * 1024;
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1024 || chunkBytes > maximumChunkBytes) {
    throw new Error('adb-tunnel-invalid-chunk-size');
  }
  const server = net.createServer({ pauseOnConnect: true, highWaterMark: chunkBytes }, socket => {
    if (closed || !ownsDevice() || connections.size >= 4) { socket.destroy(); return; }
    connections.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => {});
    let streamId;
    const failed = error => { lastError = error.message || 'adb-tunnel-stream-failed'; socket.destroy(); };
    const outgoing = [];
    let queuedBytes = 0;
    let writing = false;
    let flushTimer;
    const flush = async () => {
      if (writing || socket.destroyed) return;
      writing = true;
      try {
        while (queuedBytes && !socket.destroyed) {
          const bytes = Buffer.allocUnsafe(Math.min(chunkBytes, queuedBytes));
          let copied = 0;
          while (copied < bytes.length) {
            const first = outgoing[0];
            const count = Math.min(first.length, bytes.length - copied);
            first.copy(bytes, copied, 0, count);
            copied += count;
            if (count === first.length) outgoing.shift();
            else outgoing[0] = first.subarray(count);
          }
          queuedBytes -= bytes.length;
          for (let offset = 0; offset < bytes.length && !socket.destroyed;) {
            const chunk = bytes.subarray(offset);
            const result = await call('adb_tunnel_write', { streamId, base64: chunk.toString('base64') });
            statistics.writeCalls++;
            if (!Number.isInteger(result.written) || result.written < 0 || result.written > chunk.length) {
              throw new Error('adb-tunnel-write-incomplete');
            }
            offset += result.written;
            statistics.writtenBytes += result.written;
            if (result.written !== chunk.length) statistics.partialWrites++;
            if (!result.written) await pause(10);
          }
          if (queuedBytes < chunkBytes * 2 && !socket.destroyed) socket.resume();
        }
      } catch (error) { failed(error); }
      finally { writing = false; }
    };
    socket.on('data', bytes => {
      outgoing.push(bytes);
      queuedBytes += bytes.length;
      // ADB TLS emits many small records. Batch those records while an RPC is in
      // flight instead of paying one internet round-trip for every TCP packet.
      if (queuedBytes >= chunkBytes * 4) socket.pause();
      if (!writing && !flushTimer) flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, 2);
    });
    socket.once('close', () => {
      connections.delete(socket);
      clearTimeout(flushTimer);
      outgoing.length = 0;
      queuedBytes = 0;
      if (streamId) releaseStream(streamId);
    });
    (async () => {
      const opened = await call('adb_tunnel_open', purpose === 'pairing' ? { purpose } : {});
      streamId = opened.streamId;
      if (typeof streamId !== 'string' || !/^[a-f0-9-]{36}$/.test(streamId)) throw new Error('adb-tunnel-invalid-stream');
      streams.add(streamId);
      if (socket.destroyed) { releaseStream(streamId); return; }
      socket.resume();
      let idleDelay = 10;
      while (!socket.destroyed && !closed && ownsDevice()) {
        const received = await call('adb_tunnel_read', { streamId });
        statistics.readCalls++;
        if (received.eof) { socket.end(); return; }
        if (typeof received.base64 !== 'string' || received.base64.length > Math.ceil(chunkBytes / 3) * 4
            || received.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(received.base64)) {
          throw new Error('adb-tunnel-invalid-data');
        }
        if (!received.base64) {
          await pause(idleDelay);
          idleDelay = Math.min(idleDelay * 2, 500);
        } else {
          idleDelay = 10;
          const bytes = Buffer.from(received.base64, 'base64');
          statistics.readBytes += bytes.length;
          if (!socket.write(bytes)) {
            await new Promise(resolve => {
              const finished = () => {
                socket.off('drain', finished);
                socket.off('close', finished);
                resolve();
              };
              socket.once('drain', finished);
              socket.once('close', finished);
            });
          }
        }
      }
      if (!ownsDevice()) close();
      if (!socket.destroyed) socket.destroy();
    })().catch(error => {
      failed(error);
      // An SDK server retries a failed endpoint on its own. Retiring this
      // endpoint prevents those retries from flooding the phone command reader.
      close();
    });
  });
  server.on('error', () => close());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(watchdog);
    for (const socket of connections) socket.destroy();
    for (const streamId of [...streams]) releaseStream(streamId);
    server.close();
    onClose();
  }
  watchdog = setInterval(() => { if (!ownsDevice()) close(); }, 500);
  watchdog.unref();
  return { serial: `127.0.0.1:${server.address().port}`, close,
    listenerPort,
    listenerType: purpose === 'pairing' ? 'pairing' : status.listenerType || 'tls',
    get lastError() { return lastError; },
    get statistics() { return { ...statistics }; },
    instanceId: crypto.randomUUID(), get closed() { return closed; } };
}

module.exports = { createAdbTunnel, provisionTcpListener, waitForAdbListener };
