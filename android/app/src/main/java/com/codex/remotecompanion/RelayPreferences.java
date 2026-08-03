package com.codex.remotecompanion;

import android.content.Context;
import android.content.SharedPreferences;

import java.net.IDN;
import java.util.Locale;

final class RelayPreferences {
    private static final String FILE = "relay";
    private static final String HOST = "host";
    private static final String PORT = "port";
    private static final int DEFAULT_PORT = 10000;

    private RelayPreferences() {
    }

    static String host(Context context) {
        SharedPreferences preferences = preferences(context);
        String existing = preferences.getString(HOST, "");
        if ((existing == null || existing.isBlank()) && !BuildConfig.DEFAULT_RELAY_HOST.isBlank()) {
            save(context, BuildConfig.DEFAULT_RELAY_HOST, DEFAULT_PORT);
            return normalizeHost(BuildConfig.DEFAULT_RELAY_HOST);
        }
        return existing == null ? "" : existing;
    }

    static int port(Context context) {
        return preferences(context).getInt(PORT, DEFAULT_PORT);
    }

    static boolean configured(Context context) {
        return !host(context).isBlank();
    }

    static void save(Context context, String host, int port) {
        String normalized = normalizeHost(host);
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Port must be between 1 and 65535");
        preferences(context).edit().putString(HOST, normalized).putInt(PORT, port).apply();
    }

    static String endpoint(Context context) {
        String host = host(context);
        return host.isBlank() ? "Not configured" : host + ":" + port(context);
    }

    private static SharedPreferences preferences(Context context) {
        Context storage = context.createDeviceProtectedStorageContext();
        return storage.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    private static String normalizeHost(String value) {
        String input = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        if (input.isBlank()) throw new IllegalArgumentException("Relay host is required");
        if (input.contains("://") || input.contains("/") || input.contains("\\") || input.contains(":")) {
            throw new IllegalArgumentException("Enter a DNS host without a scheme, path, or port");
        }
        String ascii = IDN.toASCII(input, IDN.USE_STD3_ASCII_RULES);
        if (ascii.length() > 253 || !ascii.contains(".")) {
            throw new IllegalArgumentException("A fully qualified DNS host is required");
        }
        return ascii;
    }
}
