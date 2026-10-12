package com.codex.remotecompanion;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

import org.json.JSONObject;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Locale;

final class ApkInstaller {
    static final String RESULT_ACTION = "com.codex.remotecompanion.INSTALL_RESULT";
    private static final long MAX_APK_BYTES = 512L * 1024L * 1024L;
    private static final int MAX_CHUNK_BYTES = 512 * 1024;
    private static final long STALE_AFTER_MILLIS = 24L * 60L * 60L * 1000L;

    private ApkInstaller() {
    }

    static synchronized JSONObject begin(
            Context context,
            long sizeBytes,
            String sha256,
            String fileName) throws Exception {
        if (sizeBytes <= 0L || sizeBytes > MAX_APK_BYTES) {
            throw new IllegalArgumentException("APK size must be between 1 byte and 512 MiB");
        }
        String uploadId = normalizeId(sha256);
        cleanup(context);

        if (!context.getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + context.getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(settings);
            return new JSONObject()
                    .put("uploadId", uploadId)
                    .put("permissionRequired", true)
                    .put("submitted", false);
        }

        File metadataFile = metadataFile(context, uploadId);
        JSONObject metadata = read(metadataFile);
        if (metadata != null
                && metadata.optLong("sizeBytes") == sizeBytes
                && uploadId.equals(metadata.optString("sha256"))
                && sessionExists(context, metadata.optInt("sessionId", -1))) {
            return uploadStatus(metadata).put("resumed", true);
        }
        abandon(context, metadata);

        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setSize(sizeBytes);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Let Android complete eligible self/installer-owned updates without
            // a confirmation. New/foreign installs still need confirmation;
            // an OS verifier may also display its own review during submission.
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        }
        int sessionId = context.getPackageManager().getPackageInstaller().createSession(params);
        metadata = new JSONObject()
                .put("uploadId", uploadId)
                .put("sha256", uploadId)
                .put("sizeBytes", sizeBytes)
                .put("receivedBytes", 0L)
                .put("sessionId", sessionId)
                .put("fileName", safeFileName(fileName))
                .put("status", "uploading")
                .put("updatedAt", System.currentTimeMillis());
        write(metadataFile, metadata);
        return uploadStatus(metadata).put("resumed", false);
    }

    static synchronized JSONObject append(
            Context context,
            String id,
            long offset,
            String encoded,
            String expectedChunkSha256) throws Exception {
        String uploadId = normalizeId(id);
        JSONObject metadata = requireMetadata(context, uploadId);
        long received = metadata.getLong("receivedBytes");
        long size = metadata.getLong("sizeBytes");
        if (offset != received) {
            throw new IllegalStateException("Chunk offset mismatch; expected " + received);
        }
        if (encoded == null || encoded.length() > (MAX_CHUNK_BYTES * 4 / 3) + 16) {
            throw new IllegalArgumentException("Encoded APK chunk is too large");
        }
        byte[] chunk = Base64.decode(encoded, Base64.DEFAULT);
        if (chunk.length <= 0 || chunk.length > MAX_CHUNK_BYTES || received + chunk.length > size) {
            throw new IllegalArgumentException("Invalid APK chunk size");
        }
        String actualChunkSha256 = hex(MessageDigest.getInstance("SHA-256").digest(chunk));
        if (!actualChunkSha256.equals(normalizeId(expectedChunkSha256))) {
            throw new SecurityException("APK chunk digest mismatch");
        }

        int sessionId = metadata.getInt("sessionId");
        try (PackageInstaller.Session session = context.getPackageManager()
                .getPackageInstaller().openSession(sessionId);
             OutputStream output = session.openWrite("base.apk", offset, size)) {
            output.write(chunk);
            output.flush();
            session.fsync(output);
        }
        metadata.put("receivedBytes", received + chunk.length)
                .put("updatedAt", System.currentTimeMillis());
        write(metadataFile(context, uploadId), metadata);
        return uploadStatus(metadata);
    }

    static synchronized JSONObject commit(Context context, String id) throws Exception {
        String uploadId = normalizeId(id);
        JSONObject metadata = requireMetadata(context, uploadId);
        if (metadata.getLong("receivedBytes") != metadata.getLong("sizeBytes")) {
            throw new IllegalStateException("APK upload is incomplete");
        }
        int sessionId = metadata.getInt("sessionId");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        File verifiedApk = File.createTempFile("verified-install-", ".apk", context.getCacheDir());
        PackageInfo archive;
        try {
            try (PackageInstaller.Session session = context.getPackageManager()
                    .getPackageInstaller().openSession(sessionId);
                 InputStream input = session.openRead("base.apk");
                 OutputStream copy = new java.io.FileOutputStream(verifiedApk)) {
                byte[] buffer = new byte[1024 * 1024];
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (count > 0) {
                        digest.update(buffer, 0, count);
                        copy.write(buffer, 0, count);
                    }
                }
            }
            if (!uploadId.equals(hex(digest.digest()))) {
                abandon(context, metadata);
                metadataFile(context, uploadId).delete();
                throw new SecurityException("Complete APK digest mismatch");
            }
            archive = context.getPackageManager().getPackageArchiveInfo(verifiedApk.getAbsolutePath(), 0);
            if (archive == null) throw new IllegalArgumentException("APK package metadata is invalid");
        } finally { verifiedApk.delete(); }
        metadata.put("packageName", archive.packageName)
                .put("expectedPackageName", archive.packageName)
                .put("versionCode", archive.getLongVersionCode())
                .put("submittedAt", System.currentTimeMillis())
                .put("status", "submitted")
                .put("updatedAt", System.currentTimeMillis());
        // Persist before commit: replacing this very app can terminate the process.
        write(metadataFile(context, uploadId), metadata);
        write(latestFile(context), metadata);
        Intent result = new Intent(context, InstallResultReceiver.class)
                .setAction(RESULT_ACTION)
                .putExtra("uploadId", uploadId);
        PendingIntent pending = PendingIntent.getBroadcast(
                context,
                sessionId,
                result,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        try (PackageInstaller.Session session = context.getPackageManager()
                .getPackageInstaller().openSession(sessionId)) {
            session.commit(pending.getIntentSender());
        } catch (Exception error) {
            metadata.put("status", "failed").put("message", "Commit failed: " + error.getClass().getSimpleName());
            write(metadataFile(context, uploadId), metadata);
            write(latestFile(context), metadata);
            throw error;
        }
        return uploadStatus(metadata).put("submitted", true);
    }

    static synchronized JSONObject status(Context context, String id) throws Exception {
        JSONObject value;
        if (id == null || id.isBlank()) {
            value = read(latestFile(context));
        } else {
            value = read(metadataFile(context, normalizeId(id)));
        }
        if (value != null && ("submitted".equals(value.optString("status"))
                || "pending-user-action".equals(value.optString("status")))) {
            reconcileInstalled(context, value);
        }
        return value == null
                ? new JSONObject().put("status", "none")
                : new JSONObject(value.toString());
    }

    static synchronized void recordResult(
            Context context,
            String id,
            int statusCode,
            String status,
            String packageName,
            String message) {
        try {
            String uploadId = normalizeId(id);
            JSONObject metadata = read(metadataFile(context, uploadId));
            if (metadata == null) metadata = new JSONObject().put("uploadId", uploadId);
            metadata.put("statusCode", statusCode)
                    .put("status", status)
                    .put("packageName", packageName == null ? JSONObject.NULL : packageName)
                    .put("message", message == null ? JSONObject.NULL : message)
                    .put("updatedAt", System.currentTimeMillis());
            write(metadataFile(context, uploadId), metadata);
            write(latestFile(context), metadata);
        } catch (Throwable ignored) {
        }
    }

    static boolean canRequestPackageInstalls(Context context) {
        return context.getPackageManager().canRequestPackageInstalls();
    }

    private static void reconcileInstalled(Context context, JSONObject value) {
        try {
            String packageName = value.optString("expectedPackageName", value.optString("packageName"));
            if (packageName.isBlank() || !value.has("submittedAt") || !value.has("versionCode")) return;
            PackageInfo installed = context.getPackageManager().getPackageInfo(packageName, 0);
            if (installed.getLongVersionCode() != value.getLong("versionCode")
                    || installed.lastUpdateTime < value.getLong("submittedAt")) return;
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = new java.io.FileInputStream(installed.applicationInfo.sourceDir)) {
                byte[] buffer = new byte[1024 * 1024];
                int count;
                while ((count = input.read(buffer)) >= 0) if (count > 0) digest.update(buffer, 0, count);
            }
            if (!value.getString("sha256").equals(hex(digest.digest()))) return;
            value.put("status", "success").put("statusCode", PackageInstaller.STATUS_SUCCESS)
                    .put("message", "Installed APK and update time verified after replacement")
                    .put("updatedAt", System.currentTimeMillis());
            write(metadataFile(context, value.getString("uploadId")), value);
            write(latestFile(context), value);
        } catch (Exception ignored) { /* Keep the last authoritative installer result. */ }
    }

    private static JSONObject requireMetadata(Context context, String uploadId) throws Exception {
        JSONObject metadata = read(metadataFile(context, uploadId));
        if (metadata == null) throw new IllegalStateException("Unknown APK upload");
        if (!sessionExists(context, metadata.optInt("sessionId", -1))) {
            throw new IllegalStateException("APK installer session is no longer available");
        }
        return metadata;
    }

    private static JSONObject uploadStatus(JSONObject metadata) throws Exception {
        return new JSONObject()
                .put("uploadId", metadata.getString("uploadId"))
                .put("sizeBytes", metadata.getLong("sizeBytes"))
                .put("receivedBytes", metadata.getLong("receivedBytes"))
                .put("status", metadata.getString("status"))
                .put("permissionRequired", false);
    }

    private static boolean sessionExists(Context context, int sessionId) {
        return sessionId >= 0
                && context.getPackageManager().getPackageInstaller().getSessionInfo(sessionId) != null;
    }

    private static void cleanup(Context context) {
        File[] files = directory(context).listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - STALE_AFTER_MILLIS;
        for (File file : files) {
            if (file.getName().equals("latest.json")) continue;
            JSONObject metadata = read(file);
            if (metadata != null && metadata.optLong("updatedAt", 0L) >= cutoff) continue;
            abandon(context, metadata);
            file.delete();
        }
    }

    private static void abandon(Context context, JSONObject metadata) {
        if (metadata == null) return;
        int sessionId = metadata.optInt("sessionId", -1);
        if (sessionId < 0) return;
        try {
            context.getPackageManager().getPackageInstaller().abandonSession(sessionId);
        } catch (Throwable ignored) {
        }
    }

    private static File directory(Context context) {
        Context storage = context.createDeviceProtectedStorageContext();
        File directory = new File(storage.getFilesDir(), "apk-installer");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IllegalStateException("Unable to create APK installer storage");
        }
        return directory;
    }

    private static File metadataFile(Context context, String uploadId) {
        return new File(directory(context), uploadId + ".json");
    }

    private static File latestFile(Context context) {
        return new File(directory(context), "latest.json");
    }

    private static JSONObject read(File file) {
        if (!file.isFile()) return null;
        try (FileReader reader = new FileReader(file)) {
            StringBuilder content = new StringBuilder();
            char[] buffer = new char[4096];
            int count;
            while ((count = reader.read(buffer)) >= 0) content.append(buffer, 0, count);
            return new JSONObject(content.toString());
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static void write(File destination, JSONObject value) throws Exception {
        File temporary = new File(destination.getParentFile(), destination.getName() + ".tmp");
        try (FileWriter writer = new FileWriter(temporary, false)) {
            writer.write(value.toString());
            writer.flush();
        }
        try {
            Files.move(
                    temporary.toPath(),
                    destination.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(
                    temporary.toPath(),
                    destination.toPath(),
                    StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static String normalizeId(String value) {
        String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        if (!normalized.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("A SHA-256 upload ID is required");
        }
        return normalized;
    }

    private static String safeFileName(String value) {
        String name = value == null ? "app.apk" : new File(value).getName();
        name = name.replaceAll("[^A-Za-z0-9._-]", "_");
        return name.isBlank() ? "app.apk" : name.substring(0, Math.min(name.length(), 120));
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) value.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return value.toString();
    }
}
