package com.codex.remotecompanion;

import android.content.ContentResolver;
import android.content.Context;
import android.os.Process;
import android.provider.Settings;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Executes device commands inside Companion without starting or contacting adbd.
 *
 * The child keeps Companion's Android UID and therefore combines the normal Unix
 * permissions of that UID with permissions granted to Companion. Operations that
 * require Android's shell UID belong in explicit adapters instead of pretending
 * this process has a different identity.
 */
final class PersistentDeviceShell {
    private static final int MAX_ARGUMENTS = 1024;
    private static final int MAX_ARGUMENT_BYTES = 64 * 1024;
    private static final int MAX_INPUT_BYTES = 8 * 1024 * 1024;
    private static final int MAX_STREAM_BYTES = 3 * 1024 * 1024;
    private static final long MAX_TIMEOUT_MILLIS = 10 * 60_000L;
    private final ContentResolver contentResolver;

    PersistentDeviceShell(Context context) {
        this.contentResolver = context.getContentResolver();
    }

    JSONObject status() throws Exception {
        return new JSONObject()
                .put("ready", true)
                .put("uid", Process.myUid())
                .put("pid", Process.myPid())
                .put("requiresAdbd", false)
                .put("executionIdentity", "companion-application");
    }

    JSONObject execute(JSONArray encodedArguments, String stdinBase64, long timeoutMillis)
            throws Exception {
        List<String> arguments = validatedArguments(encodedArguments);
        if (timeoutMillis < 100L || timeoutMillis > MAX_TIMEOUT_MILLIS) {
            throw new IllegalArgumentException("Invalid persistent shell timeout");
        }
        byte[] standardInput = stdinBase64 == null
                ? new byte[0] : Base64.decode(stdinBase64, Base64.DEFAULT);
        if (standardInput.length > MAX_INPUT_BYTES) {
            throw new IllegalArgumentException("Input exceeds persistent shell limit");
        }
        JSONObject adapted = executeAndroidAdapter(arguments);
        if (adapted != null) {
            java.util.Arrays.fill(standardInput, (byte) 0);
            return adapted;
        }

        java.lang.Process child = new ProcessBuilder(arguments).start();
        StreamCapture stdout = new StreamCapture(child.getInputStream(), child);
        StreamCapture stderr = new StreamCapture(child.getErrorStream(), child);
        Thread stdoutThread = new Thread(stdout, "persistent-device-shell-stdout");
        Thread stderrThread = new Thread(stderr, "persistent-device-shell-stderr");
        stdoutThread.start();
        stderrThread.start();
        try {
            child.getOutputStream().write(standardInput);
            child.getOutputStream().close();
            boolean completed = child.waitFor(timeoutMillis, TimeUnit.MILLISECONDS);
            if (!completed) {
                child.destroy();
                if (!child.waitFor(1_000L, TimeUnit.MILLISECONDS)) child.destroyForcibly();
            }
            stdoutThread.join(2_000L);
            stderrThread.join(2_000L);
            JSONObject identity = identity();
            if (stdout.overflow || stderr.overflow) {
                return failed("persistent-device-shell-output-limit-exceeded", "confirmed-failed", identity);
            }
            if (!completed) {
                return failed("persistent-device-shell-timeout", "unconfirmed", identity)
                        .put("exitCode", JSONObject.NULL);
            }
            return new JSONObject()
                    .put("exitCode", child.exitValue())
                    .put("stdoutBase64", Base64.encodeToString(stdout.bytes(), Base64.NO_WRAP))
                    .put("stderrBase64", Base64.encodeToString(stderr.bytes(), Base64.NO_WRAP))
                    .put("executionIdentity", identity);
        } finally {
            child.destroy();
            java.util.Arrays.fill(standardInput, (byte) 0);
        }
    }

    private JSONObject executeAndroidAdapter(List<String> arguments) throws Exception {
        if ("settings".equals(arguments.get(0))) return executeSettings(arguments);
        if (arguments.size() == 2 && "am".equals(arguments.get(0))
                && "get-current-user".equals(arguments.get(1))) {
            return succeeded(currentUserId() + "\n", "android-current-user");
        }
        return null;
    }

    private JSONObject executeSettings(List<String> arguments) throws Exception {
        int cursor = 1;
        if (arguments.size() > cursor + 1 && "--user".equals(arguments.get(cursor))) {
            String requestedUser = arguments.get(cursor + 1);
            if (!("current".equals(requestedUser)
                    || Integer.toString(currentUserId()).equals(requestedUser))) {
                return failed("persistent-settings-cross-user-unsupported", "confirmed-failed", identity());
            }
            cursor += 2;
        }
        if (arguments.size() < cursor + 3) {
            return failed("persistent-settings-invalid-arguments", "confirmed-failed", identity());
        }
        String action = arguments.get(cursor++);
        String namespace = arguments.get(cursor++);
        String key = arguments.get(cursor++);
        if (!key.matches("[A-Za-z0-9_.:-]{1,200}")) {
            return failed("persistent-settings-invalid-key", "confirmed-failed", identity());
        }
        if ("get".equals(action) && arguments.size() == cursor) {
            String value = readSetting(namespace, key);
            return succeeded((value == null ? "null" : value) + "\n", "android-settings-provider");
        }
        if ("put".equals(action) && arguments.size() == cursor + 1) {
            boolean written = writeSetting(namespace, key, arguments.get(cursor));
            return written ? succeeded("", "android-settings-provider")
                    : failed("persistent-settings-write-rejected", "confirmed-failed", identity());
        }
        if ("delete".equals(action) && arguments.size() == cursor) {
            boolean deleted = deleteSetting(namespace, key);
            return succeeded("Deleted " + (deleted ? "1" : "0") + " rows\n",
                    "android-settings-provider");
        }
        return failed("persistent-settings-invalid-arguments", "confirmed-failed", identity());
    }

    private String readSetting(String namespace, String key) {
        switch (namespace) {
            case "global": return Settings.Global.getString(contentResolver, key);
            case "secure": return Settings.Secure.getString(contentResolver, key);
            case "system": return Settings.System.getString(contentResolver, key);
            default: throw new IllegalArgumentException("Unsupported settings namespace");
        }
    }

    private boolean writeSetting(String namespace, String key, String value) {
        switch (namespace) {
            case "global": return Settings.Global.putString(contentResolver, key, value);
            case "secure": return Settings.Secure.putString(contentResolver, key, value);
            case "system": return Settings.System.putString(contentResolver, key, value);
            default: throw new IllegalArgumentException("Unsupported settings namespace");
        }
    }

    private boolean deleteSetting(String namespace, String key) {
        switch (namespace) {
            case "global": return Settings.Global.putString(contentResolver, key, null);
            case "secure": return Settings.Secure.putString(contentResolver, key, null);
            case "system": return Settings.System.putString(contentResolver, key, null);
            default: throw new IllegalArgumentException("Unsupported settings namespace");
        }
    }

    private JSONObject succeeded(String stdout, String adapter) throws Exception {
        return new JSONObject()
                .put("exitCode", 0)
                .put("stdoutBase64", Base64.encodeToString(
                        stdout.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP))
                .put("stderrBase64", "")
                .put("adapter", adapter)
                .put("executionIdentity", identity());
    }

    private static JSONObject identity() throws Exception {
        return new JSONObject()
                .put("uid", Process.myUid())
                .put("kind", "companion-application")
                .put("requiresAdbd", false);
    }

    private static int currentUserId() {
        // Android assigns each user a fixed 100000-UID range (AID_USER_OFFSET).
        return Process.myUid() / 100_000;
    }

    private static JSONObject failed(String error, String outcome, JSONObject identity) throws Exception {
        return new JSONObject()
                .put("exitCode", 1)
                .put("error", error)
                .put("outcome", outcome)
                .put("executionIdentity", identity);
    }

    private static List<String> validatedArguments(JSONArray encodedArguments) throws Exception {
        if (encodedArguments.length() == 0 || encodedArguments.length() > MAX_ARGUMENTS) {
            throw new IllegalArgumentException("Invalid persistent shell argument count");
        }
        List<String> arguments = new ArrayList<>(encodedArguments.length());
        int argumentBytes = 0;
        for (int index = 0; index < encodedArguments.length(); index++) {
            String value = encodedArguments.getString(index);
            if (value.indexOf('\0') >= 0) throw new IllegalArgumentException("NUL in argument");
            argumentBytes += value.getBytes(StandardCharsets.UTF_8).length;
            if (argumentBytes > MAX_ARGUMENT_BYTES) {
                throw new IllegalArgumentException("Persistent shell arguments exceed limit");
            }
            arguments.add(value);
        }
        return arguments;
    }

    private static final class StreamCapture implements Runnable {
        private final InputStream input;
        private final java.lang.Process child;
        private final ByteArrayOutputStream output = new ByteArrayOutputStream();
        private volatile boolean overflow;

        StreamCapture(InputStream input, java.lang.Process child) {
            this.input = input;
            this.child = child;
        }

        @Override
        public void run() {
            byte[] buffer = new byte[32 * 1024];
            try {
                int length;
                while ((length = input.read(buffer)) != -1) {
                    if (output.size() + length > MAX_STREAM_BYTES) {
                        overflow = true;
                        child.destroy();
                        return;
                    }
                    output.write(buffer, 0, length);
                }
            } catch (Exception ignored) {
            }
        }

        byte[] bytes() {
            return output.toByteArray();
        }
    }
}
