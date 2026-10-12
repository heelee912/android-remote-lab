package com.codex.remotecompanion;

import android.app.Instrumentation;
import android.os.Bundle;
import android.util.Base64;
import java.io.File;
import java.io.FileInputStream;
import java.security.MessageDigest;
import java.util.Locale;
import org.json.JSONObject;

/** Exercises the production uploader/installer on an isolated test device. */
final class InstallProbeInstrumentation {
    static void run(Instrumentation instrumentation, Bundle arguments) {
        Bundle result = new Bundle();
        try {
            if ("install-status".equals(arguments.getString("probe"))) {
                result.putString("install_status", ApkInstaller.status(instrumentation.getTargetContext(), "").toString());
                instrumentation.finish(-1, result);
                return;
            }
            File apk = new File(arguments.getString("apk"));
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[256 * 1024];
            try (FileInputStream input = new FileInputStream(apk)) {
                int count;
                while ((count = input.read(buffer)) >= 0) if (count > 0) digest.update(buffer, 0, count);
            }
            String id = hex(digest.digest());
            JSONObject begin = ApkInstaller.begin(instrumentation.getTargetContext(), apk.length(), id, apk.getName());
            if (begin.optBoolean("permissionRequired")) throw new AssertionError("Install source permission missing");
            long offset = begin.getLong("receivedBytes");
            try (FileInputStream input = new FileInputStream(apk)) {
                if (input.skip(offset) != offset) throw new AssertionError("Resume offset unavailable");
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (count == 0) continue;
                    byte[] chunk = java.util.Arrays.copyOf(buffer, count);
                    ApkInstaller.append(instrumentation.getTargetContext(), id, offset,
                            Base64.encodeToString(chunk, Base64.NO_WRAP),
                            hex(MessageDigest.getInstance("SHA-256").digest(chunk)));
                    offset += count;
                }
            }
            result.putString("install_commit", ApkInstaller.commit(instrumentation.getTargetContext(), id).toString());
            instrumentation.finish(-1, result);
        } catch (Throwable error) {
            result.putString("install_failure", error.toString());
            instrumentation.finish(0, result);
        }
    }
    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder();
        for (byte b : bytes) value.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        return value.toString();
    }
}
