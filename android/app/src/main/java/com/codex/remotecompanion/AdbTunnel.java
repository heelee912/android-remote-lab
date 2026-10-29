package com.codex.remotecompanion;

import android.content.Context;
import android.content.pm.PackageManager;
import android.provider.Settings;
import android.os.SystemClock;
import android.util.Base64;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import org.json.JSONObject;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/** Carries selected ADB or TV remote bytes only to services on this device. */
final class AdbTunnel implements AutoCloseable {
    private final Context context;
    private final java.util.function.Consumer<String> audit;
    private final MobileAdbRecovery mobileRecovery;
    private final Map<String, SocketChannel> sockets = new HashMap<>();
    private static final int CHUNK_BYTES = 128 * 1024;
    private final NsdManager discovery;
    private final ArrayDeque<DiscoveryCandidate> pendingServices = new ArrayDeque<>();
    private volatile int discoveredPort;
    private volatile String discoveredService;
    private volatile int discoveredPairingPort;
    private volatile String discoveredPairingService;
    private boolean resolving;
    private volatile boolean closed;
    private long propertiesReadAt = Long.MIN_VALUE;
    private int cachedTcpPort;
    private int cachedTlsPort;
    private long lastUiRecoveryAt = Long.MIN_VALUE;
    private String uiRecoveryError;
    private final NsdManager.DiscoveryListener discoveryListener = new NsdManager.DiscoveryListener() {
        public void onDiscoveryStarted(String type) { }
        public void onDiscoveryStopped(String type) { }
        public void onStartDiscoveryFailed(String type, int error) { }
        public void onStopDiscoveryFailed(String type, int error) { }
        public void onServiceLost(NsdServiceInfo service) {
            if (service.getServiceName().equals(discoveredService)) discoveredPort = 0;
        }
        public void onServiceFound(NsdServiceInfo service) {
            queueService(service, false);
        }
    };
    private final NsdManager.DiscoveryListener pairingDiscoveryListener = new NsdManager.DiscoveryListener() {
        public void onDiscoveryStarted(String type) { }
        public void onDiscoveryStopped(String type) { }
        public void onStartDiscoveryFailed(String type, int error) { }
        public void onStopDiscoveryFailed(String type, int error) { }
        public void onServiceLost(NsdServiceInfo service) {
            if (service.getServiceName().equals(discoveredPairingService)) discoveredPairingPort = 0;
        }
        public void onServiceFound(NsdServiceInfo service) { queueService(service, true); }
    };
    private NsdManager.DiscoveryListener mobileDiscovery;

    private static final class DiscoveryCandidate {
        final NsdServiceInfo service;
        final boolean pairing;

        DiscoveryCandidate(NsdServiceInfo service, boolean pairing) {
            this.service = service;
            this.pairing = pairing;
        }
    }

    private void queueService(NsdServiceInfo service, boolean pairing) {
        synchronized (pendingServices) {
            if (closed || pendingServices.size() >= 64) return;
            pendingServices.add(new DiscoveryCandidate(service, pairing));
        }
        resolveNextService();
    }

    private synchronized void discoverMobileInterface() {
        if (closed || mobileDiscovery != null) return;
        // Register after the local interface exists. A discovery registered on
        // mobile data alone may never query the subsequently created interface.
        mobileDiscovery = new NsdManager.DiscoveryListener() {
            public void onDiscoveryStarted(String type) { }
            public void onDiscoveryStopped(String type) { }
            public void onStartDiscoveryFailed(String type, int error) { }
            public void onStopDiscoveryFailed(String type, int error) { }
            public void onServiceFound(NsdServiceInfo service) { discoveryListener.onServiceFound(service); }
            public void onServiceLost(NsdServiceInfo service) { discoveryListener.onServiceLost(service); }
        };
        discovery.discoverServices("_adb-tls-connect._tcp.", NsdManager.PROTOCOL_DNS_SD, mobileDiscovery);
    }

    private void resolveNextService() {
        DiscoveryCandidate candidate;
        synchronized (pendingServices) {
            if (closed || resolving || pendingServices.isEmpty()) return;
            resolving = true;
            candidate = pendingServices.remove();
        }
        try {
            discovery.resolveService(candidate.service, new NsdManager.ResolveListener() {
                private void complete() {
                    synchronized (pendingServices) { resolving = false; }
                    resolveNextService();
                }
                public void onResolveFailed(NsdServiceInfo value, int error) { complete(); }
                public void onServiceResolved(NsdServiceInfo value) {
                    try {
                        InetAddress host = value.getHost();
                        if (host == null || closed) return;
                        for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                            if (Collections.list(network.getInetAddresses()).contains(host)) {
                                if (candidate.pairing) {
                                    discoveredPairingPort = value.getPort();
                                    discoveredPairingService = value.getServiceName();
                                } else {
                                    discoveredPort = value.getPort();
                                    discoveredService = value.getServiceName();
                                }
                                break;
                            }
                        }
                    } catch (Exception ignored) { }
                    finally { complete(); }
                }
            });
        } catch (RuntimeException error) {
            synchronized (pendingServices) { resolving = false; }
            resolveNextService();
        }
    }

    AdbTunnel(Context context, java.util.function.Consumer<String> audit) {
        this.context = context;
        this.audit = audit;
        mobileRecovery = new MobileAdbRecovery(context, audit, this::discoverMobileInterface);
        discovery = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
        discovery.discoverServices("_adb-tls-connect._tcp.", NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        try {
            discovery.discoverServices("_adb-tls-pairing._tcp.", NsdManager.PROTOCOL_DNS_SD,
                    pairingDiscoveryListener);
        } catch (RuntimeException error) {
            audit.accept("ADB pairing discovery unavailable: " + error.getClass().getSimpleName());
        }
    }

    private int listenerPort() throws Exception {
        return cachedTlsPort > 0 ? cachedTlsPort : discoveredPort;
    }

    private static boolean listening(int port) {
        if (port <= 0 || port > 65535) return false;
        try (Socket probe = new Socket()) {
            probe.connect(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 200);
            return true;
        } catch (java.io.IOException error) { return false; }
    }

    private static int propertyPort(String property) throws Exception {
        Process process = new ProcessBuilder("/system/bin/getprop", property).start();
        if (!process.waitFor(1, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            throw new IllegalStateException("ADB port discovery timed out");
        }
        byte[] bytes = new byte[64];
        int count = process.getInputStream().read(bytes);
        String value = count > 0 ? new String(bytes, 0, count, java.nio.charset.StandardCharsets.US_ASCII).trim() : "";
        try { int port = Integer.parseInt(value); return port > 0 && port <= 65535 ? port : 0; }
        catch (NumberFormatException error) { return 0; }
    }

    private int reachablePort() throws Exception {
        long now = SystemClock.elapsedRealtime();
        // Socket polling must not spawn two getprop processes on every 100 ms
        // iteration. A delayed property query otherwise stalls the command reader.
        if (propertiesReadAt == Long.MIN_VALUE || now - propertiesReadAt >= 1000L) {
            cachedTcpPort = propertyPort("service.adb.tcp.port");
            cachedTlsPort = propertyPort("service.adb.tls.port");
            propertiesReadAt = SystemClock.elapsedRealtime();
        }
        if (listening(cachedTcpPort > 0 ? cachedTcpPort : 5555)) return cachedTcpPort > 0 ? cachedTcpPort : 5555;
        int tlsPort = listenerPort();
        return listening(tlsPort) ? tlsPort : 0;
    }

    private boolean enabled(String setting) {
        return AdbListenerRecovery.settingEnabled(
                Settings.Global.getInt(context.getContentResolver(), setting, 0));
    }

    private void setEnabled(String setting, boolean value) {
        if (!Settings.Global.putInt(context.getContentResolver(), setting, value ? 1 : 0)) {
            throw new IllegalStateException("Android did not apply " + setting);
        }
    }

    JSONObject status(boolean repair) throws Exception {
        boolean canRepair = context.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED;
        boolean adbBefore = enabled("adb_enabled");
        boolean wirelessBefore = enabled("adb_wifi_enabled");
        int initialPort = reachablePort();
        int port = repair ? AdbListenerRecovery.recover(new AdbListenerRecovery.Device() {
            public int listeningPort() throws Exception { return reachablePort(); }
            public boolean adbEnabled() { return enabled("adb_enabled"); }
            public boolean wirelessEnabled() { return enabled("adb_wifi_enabled"); }
            public void setAdbEnabled(boolean value) { setEnabled("adb_enabled", value); }
            public void setWirelessEnabled(boolean value) { setEnabled("adb_wifi_enabled", value); }
            public long monotonicMillis() { return SystemClock.elapsedRealtime(); }
            public void await(long milliseconds) throws InterruptedException { Thread.sleep(milliseconds); }
        }, canRepair) : initialPort;
        if (repair && canRepair && port == 0 && WirelessDebuggingUiRecovery.canAttempt(context)
                && (lastUiRecoveryAt == Long.MIN_VALUE
                        || SystemClock.elapsedRealtime() - lastUiRecoveryAt >= 30_000L)) {
            lastUiRecoveryAt = SystemClock.elapsedRealtime();
            try {
                WirelessDebuggingUiRecovery.enable(context, this::reachablePort);
                uiRecoveryError = null;
                long deadline = SystemClock.elapsedRealtime() + 4_500L;
                while (port == 0 && SystemClock.elapsedRealtime() < deadline) {
                    Thread.sleep(100L);
                    port = reachablePort();
                }
            } catch (Exception error) {
                uiRecoveryError = error.getClass().getSimpleName() + ": " + error.getMessage();
                audit.accept("wireless debugging UI recovery failed: " + uiRecoveryError);
            }
        }
        if (repair && canRepair && port == 0) mobileRecovery.start();
        boolean tcp = port > 0 && port == (cachedTcpPort > 0 ? cachedTcpPort : 5555);
        return new JSONObject().put("supported", true).put("tlsPort", tcp ? 0 : port)
                .put("chunkBytes", CHUNK_BYTES)
                .put("port", port).put("listenerType", tcp ? "tcp" : "tls")
                .put("adbEnabled", enabled("adb_enabled"))
                .put("wirelessEnabled", enabled("adb_wifi_enabled"))
                .put("repairAttempted", repair && canRepair && (!adbBefore || initialPort == 0))
                .put("wirelessRestarted", repair && canRepair && initialPort == 0 && wirelessBefore)
                .put("mobileRecoveryRunning", mobileRecovery.isRunning())
                .put("mobileRecoveryError", mobileRecovery.lastError() == null ? JSONObject.NULL : mobileRecovery.lastError())
                .put("uiRecoveryError", uiRecoveryError == null ? JSONObject.NULL : uiRecoveryError)
                .put("pairingPort", discoveredPairingPort)
                .put("canRepair", canRepair).put("ready", port > 0);
    }

    JSONObject dispatch(String command, JSONObject args) throws Exception {
        switch (command) {
            case "adb_tunnel_status": return status(args.optBoolean("repair", false));
            case "adb_tunnel_open": {
                if (sockets.size() >= 4) throw new IllegalStateException("ADB tunnel capacity reached");
                // Tunnel creation already repairs the listener. Native SDK
                // reconnects must fail promptly rather than queue repair loops.
                String purpose = args.optString("purpose", "connect");
                boolean pairing = "pairing".equals(purpose);
                boolean tvPairing = "tv-pairing".equals(purpose);
                boolean tvControl = "tv-control".equals(purpose);
                if (!pairing && !tvPairing && !tvControl && !"connect".equals(purpose)) {
                    throw new IllegalArgumentException("Unsupported local tunnel purpose");
                }
                int port = tvPairing ? 6467 : tvControl ? 6466
                        : pairing ? discoveredPairingPort : status(false).getInt("port");
                if (port == 0) throw new IllegalStateException(pairing
                        ? "ADB pairing service is not running" : "ADB wireless listener is not running");
                SocketChannel channel = SocketChannel.open();
                Socket socket = channel.socket();
                try {
                    socket.setSendBufferSize(2 * 1024 * 1024);
                    socket.setReceiveBufferSize(2 * 1024 * 1024);
                    InetAddress address = tvPairing || tvControl
                            ? TvRemoteControl.activeInterfaceAddress(context) : null;
                    // Some TV remote services accept TCP on loopback but close
                    // its TLS session there. Use this device's active interface.
                    if (address == null) address = InetAddress.getByName("127.0.0.1");
                    socket.connect(new InetSocketAddress(address, port), 3000);
                    socket.setTcpNoDelay(true);
                    channel.configureBlocking(false);
                    String id = UUID.randomUUID().toString();
                    sockets.put(id, channel);
                    return new JSONObject().put("streamId", id);
                } catch (Exception error) { channel.close(); throw error; }
            }
            case "adb_tunnel_read": {
                SocketChannel socket = requireSocket(args.getString("streamId"));
                byte[] bytes = new byte[CHUNK_BYTES];
                int count = socket.read(ByteBuffer.wrap(bytes));
                if (count < 0) { closeStream(args.getString("streamId")); return new JSONObject().put("eof", true); }
                return new JSONObject().put("base64", Base64.encodeToString(bytes, 0, count, Base64.NO_WRAP));
            }
            case "adb_tunnel_write": {
                String id = args.getString("streamId");
                String encoded = args.getString("base64");
                if (encoded.length() > CHUNK_BYTES * 4 / 3 + 4) throw new IllegalArgumentException("ADB chunk is too large");
                byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
                if (bytes.length > CHUNK_BYTES) throw new IllegalArgumentException("ADB chunk is too large");
                // Full ADB buffers must not prevent reading the opposite direction
                // or servicing heartbeats. The PC retries only unwritten bytes.
                int written = requireSocket(id).write(ByteBuffer.wrap(bytes));
                return new JSONObject().put("written", written);
            }
            case "adb_tunnel_close":
                closeStream(args.getString("streamId"));
                return new JSONObject().put("closed", true);
            default: throw new IllegalArgumentException("Unknown ADB tunnel operation");
        }
    }

    private SocketChannel requireSocket(String id) {
        SocketChannel socket = sockets.get(id);
        if (socket == null || !socket.isOpen()) throw new IllegalStateException("ADB tunnel stream is closed");
        return socket;
    }

    private void closeStream(String id) throws Exception {
        SocketChannel socket = sockets.remove(id);
        if (socket != null) socket.close();
    }

    public void close() {
        closed = true;
        mobileRecovery.close();
        synchronized (pendingServices) { pendingServices.clear(); }
        try { discovery.stopServiceDiscovery(discoveryListener); } catch (Exception ignored) { }
        try { discovery.stopServiceDiscovery(pairingDiscoveryListener); } catch (Exception ignored) { }
        if (mobileDiscovery != null) {
            try { discovery.stopServiceDiscovery(mobileDiscovery); } catch (Exception ignored) { }
        }
        for (SocketChannel socket : sockets.values()) try { socket.close(); } catch (Exception ignored) { }
        sockets.clear();
    }
}
