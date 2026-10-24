package com.codex.remotecompanion;

import android.content.Context;
import android.content.pm.PackageManager;
import android.provider.Settings;
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

/** Carries ADB bytes only to this phone's loopback debugging service. */
final class AdbTunnel implements AutoCloseable {
    private final Context context;
    private final Map<String, SocketChannel> sockets = new HashMap<>();
    private static final int CHUNK_BYTES = 512 * 1024;
    private final NsdManager discovery;
    private final ArrayDeque<NsdServiceInfo> pendingServices = new ArrayDeque<>();
    private volatile int discoveredPort;
    private volatile String discoveredService;
    private boolean resolving;
    private volatile boolean closed;
    private final NsdManager.DiscoveryListener discoveryListener = new NsdManager.DiscoveryListener() {
        public void onDiscoveryStarted(String type) { }
        public void onDiscoveryStopped(String type) { }
        public void onStartDiscoveryFailed(String type, int error) { }
        public void onStopDiscoveryFailed(String type, int error) { }
        public void onServiceLost(NsdServiceInfo service) {
            if (service.getServiceName().equals(discoveredService)) discoveredPort = 0;
        }
        public void onServiceFound(NsdServiceInfo service) {
            synchronized (pendingServices) {
                if (closed || pendingServices.size() >= 64) return;
                pendingServices.add(service);
            }
            resolveNextService();
        }
    };

    private void resolveNextService() {
        NsdServiceInfo service;
        synchronized (pendingServices) {
            if (closed || resolving || pendingServices.isEmpty()) return;
            resolving = true;
            service = pendingServices.remove();
        }
        try {
            discovery.resolveService(service, new NsdManager.ResolveListener() {
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
                                discoveredPort = value.getPort();
                                discoveredService = value.getServiceName();
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

    AdbTunnel(Context context) {
        this.context = context;
        discovery = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
        discovery.discoverServices("_adb-tls-connect._tcp.", NsdManager.PROTOCOL_DNS_SD, discoveryListener);
    }

    private int listenerPort() throws Exception {
        int property = propertyPort("service.adb.tls.port");
        return property > 0 ? property : discoveredPort;
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
        if (!process.waitFor(2, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            throw new IllegalStateException("ADB port discovery timed out");
        }
        byte[] bytes = new byte[64];
        int count = process.getInputStream().read(bytes);
        String value = count > 0 ? new String(bytes, 0, count, java.nio.charset.StandardCharsets.US_ASCII).trim() : "";
        try { int port = Integer.parseInt(value); return port > 0 && port <= 65535 ? port : 0; }
        catch (NumberFormatException error) { return 0; }
    }

    JSONObject status(boolean repair) throws Exception {
        boolean canRepair = context.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED;
        // `adb tcpip 5555` is an explicit one-time provisioning operation over
        // an authenticated ADB transport. This listener survives Wi-Fi changes;
        // it still requires the PC's authorized ADB key inside the outer TLS.
        int tcpPort = propertyPort("service.adb.tcp.port");
        if (listening(tcpPort > 0 ? tcpPort : 5555)) {
            return new JSONObject().put("supported", true).put("tlsPort", 0)
                    .put("chunkBytes", CHUNK_BYTES)
                    .put("port", tcpPort > 0 ? tcpPort : 5555).put("listenerType", "tcp")
                    .put("canRepair", canRepair).put("ready", true);
        }
        int port = listenerPort();
        if (!listening(port)) port = 0;
        if (repair && port == 0 && canRepair) {
            Settings.Global.putInt(context.getContentResolver(), "adb_wifi_enabled", 1);
            for (int attempt = 0; attempt < 10 && port == 0; attempt++) {
                Thread.sleep(100L);
                int candidate = listenerPort();
                port = listening(candidate) ? candidate : 0;
            }
        }
        return new JSONObject().put("supported", true).put("tlsPort", port)
                .put("chunkBytes", CHUNK_BYTES)
                .put("port", port).put("listenerType", "tls")
                .put("canRepair", canRepair).put("ready", port > 0);
    }

    JSONObject dispatch(String command, JSONObject args) throws Exception {
        switch (command) {
            case "adb_tunnel_status": return status(args.optBoolean("repair", false));
            case "adb_tunnel_open": {
                if (sockets.size() >= 4) throw new IllegalStateException("ADB tunnel capacity reached");
                int port = status(true).getInt("port");
                if (port == 0) throw new IllegalStateException("ADB wireless listener is not running");
                SocketChannel channel = SocketChannel.open();
                Socket socket = channel.socket();
                try {
                    socket.setSendBufferSize(2 * 1024 * 1024);
                    socket.setReceiveBufferSize(2 * 1024 * 1024);
                    socket.connect(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 3000);
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
        synchronized (pendingServices) { pendingServices.clear(); }
        try { discovery.stopServiceDiscovery(discoveryListener); } catch (Exception ignored) { }
        for (SocketChannel socket : sockets.values()) try { socket.close(); } catch (Exception ignored) { }
        sockets.clear();
    }
}
