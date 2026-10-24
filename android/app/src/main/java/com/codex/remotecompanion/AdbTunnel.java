package com.codex.remotecompanion;

import android.content.Context;
import android.content.pm.PackageManager;
import android.provider.Settings;
import android.util.Base64;
import org.json.JSONObject;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/** Carries ADB bytes only to this phone's loopback debugging service. */
final class AdbTunnel implements AutoCloseable {
    private final Context context;
    private final Map<String, Socket> sockets = new HashMap<>();
    private static final int CHUNK_BYTES = 48 * 1024;

    AdbTunnel(Context context) { this.context = context; }

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
        int port = propertyPort("service.adb.tls.port");
        if (repair && port == 0 && canRepair) {
            Settings.Global.putInt(context.getContentResolver(), "adb_wifi_enabled", 1);
            for (int attempt = 0; attempt < 10 && port == 0; attempt++) {
                Thread.sleep(100L);
                port = propertyPort("service.adb.tls.port");
            }
        }
        return new JSONObject().put("supported", true).put("tlsPort", port)
                .put("canRepair", canRepair).put("ready", port > 0);
    }

    JSONObject dispatch(String command, JSONObject args) throws Exception {
        switch (command) {
            case "adb_tunnel_status": return status(args.optBoolean("repair", false));
            case "adb_tunnel_open": {
                if (sockets.size() >= 4) throw new IllegalStateException("ADB tunnel capacity reached");
                int port = status(true).getInt("tlsPort");
                if (port == 0) throw new IllegalStateException("ADB wireless listener is not running");
                Socket socket = new Socket();
                try {
                    socket.connect(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 3000);
                    socket.setSoTimeout(25);
                    socket.setTcpNoDelay(true);
                    String id = UUID.randomUUID().toString();
                    sockets.put(id, socket);
                    return new JSONObject().put("streamId", id);
                } catch (Exception error) { socket.close(); throw error; }
            }
            case "adb_tunnel_read": {
                Socket socket = requireSocket(args.getString("streamId"));
                byte[] bytes = new byte[CHUNK_BYTES];
                try {
                    int count = socket.getInputStream().read(bytes);
                    if (count < 0) { closeStream(args.getString("streamId")); return new JSONObject().put("eof", true); }
                    return new JSONObject().put("base64", Base64.encodeToString(bytes, 0, count, Base64.NO_WRAP));
                } catch (SocketTimeoutException timeout) { return new JSONObject().put("base64", ""); }
            }
            case "adb_tunnel_write": {
                String encoded = args.getString("base64");
                if (encoded.length() > CHUNK_BYTES * 4 / 3 + 4) throw new IllegalArgumentException("ADB chunk is too large");
                byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
                if (bytes.length > CHUNK_BYTES) throw new IllegalArgumentException("ADB chunk is too large");
                requireSocket(args.getString("streamId")).getOutputStream().write(bytes);
                return new JSONObject().put("written", bytes.length);
            }
            case "adb_tunnel_close":
                closeStream(args.getString("streamId"));
                return new JSONObject().put("closed", true);
            default: throw new IllegalArgumentException("Unknown ADB tunnel operation");
        }
    }

    private Socket requireSocket(String id) {
        Socket socket = sockets.get(id);
        if (socket == null || socket.isClosed()) throw new IllegalStateException("ADB tunnel stream is closed");
        return socket;
    }

    private void closeStream(String id) throws Exception {
        Socket socket = sockets.remove(id);
        if (socket != null) socket.close();
    }

    public void close() {
        for (Socket socket : sockets.values()) try { socket.close(); } catch (Exception ignored) { }
        sockets.clear();
    }
}
