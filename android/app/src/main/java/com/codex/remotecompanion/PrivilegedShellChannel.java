package com.codex.remotecompanion;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.SecureRandom;

final class PrivilegedShellChannel {
    private static final String PREFERENCES = "privileged-shell-channel";
    private static final String TOKEN = "token";
    private static final String PORT = "port";
    private static final int FIRST_PORT = 27183;
    private static final int LAST_PORT = 28182;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Context context;

    PrivilegedShellChannel(Context context) {
        this.context = context.createDeviceProtectedStorageContext();
    }

    JSONObject prepare() throws Exception {
        byte[] tokenBytes = new byte[32];
        RANDOM.nextBytes(tokenBytes);
        StringBuilder token = new StringBuilder(64);
        for (byte value : tokenBytes) token.append(String.format("%02x", value & 0xff));
        java.util.Arrays.fill(tokenBytes, (byte) 0);
        SharedPreferences preferences = preferences();
        int previousPort = preferences.getInt(PORT, FIRST_PORT - 1);
        int port = previousPort >= LAST_PORT ? FIRST_PORT : Math.max(FIRST_PORT, previousPort + 1);
        if (!preferences.edit().putString(TOKEN, token.toString()).putInt(PORT, port).commit()) {
            throw new IllegalStateException("Could not persist privileged shell capability");
        }
        return new JSONObject()
                .put("port", port)
                .put("token", token.toString())
                .put("classpath", context.getApplicationInfo().sourceDir)
                .put("mainClass", PrivilegedShellBroker.class.getName());
    }

    JSONObject status() {
        try {
            return request(new JSONObject().put("action", "status"), 2_000L);
        } catch (Throwable error) {
            try {
                return new JSONObject()
                        .put("ready", false)
                        .put("error", error.getClass().getSimpleName() + ": " + safeMessage(error));
            } catch (Exception jsonError) {
                throw new IllegalStateException(jsonError);
            }
        }
    }

    JSONObject execute(JSONArray arguments, String stdinBase64, long timeoutMillis) throws Exception {
        JSONObject request = new JSONObject()
                .put("action", "exec")
                .put("argv", arguments)
                .put("timeoutMillis", timeoutMillis);
        if (stdinBase64 != null) request.put("stdinBase64", stdinBase64);
        return request(request, timeoutMillis + 5_000L);
    }

    private JSONObject request(JSONObject request, long timeoutMillis) throws Exception {
        SharedPreferences preferences = preferences();
        String token = preferences.getString(TOKEN, null);
        int port = preferences.getInt(PORT, 0);
        if (token == null || port == 0) throw new IllegalStateException("Privileged shell is not prepared");
        request.put("token", token);
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 1_500);
            socket.setSoTimeout((int) Math.min(Integer.MAX_VALUE, Math.max(2_000L, timeoutMillis)));
            Protocol.write(new DataOutputStream(socket.getOutputStream()), request);
            JSONObject response = Protocol.read(new DataInputStream(socket.getInputStream()));
            if (!response.optBoolean("ok")) {
                throw new IllegalStateException(response.optString("error", "Privileged shell rejected request"));
            }
            return response.getJSONObject("result");
        }
    }

    private SharedPreferences preferences() {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }
}
