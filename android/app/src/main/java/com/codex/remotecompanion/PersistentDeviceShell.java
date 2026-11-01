package com.codex.remotecompanion;

import android.os.Process;
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
            JSONObject identity = new JSONObject()
                    .put("uid", Process.myUid())
                    .put("kind", "companion-application")
                    .put("requiresAdbd", false);
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
