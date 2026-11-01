package com.codex.remotecompanion;

import android.content.Context;
import android.os.Build;
import android.os.Environment;
import android.util.Base64;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.RandomAccessFile;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Locale;

/** Transfers shared-storage files through the authenticated Companion connection without ADB. */
final class SharedFileTransfer {
    private static final long MAX_FILE_BYTES = 2L * 1024L * 1024L * 1024L;
    private static final int MAX_CHUNK_BYTES = 512 * 1024;

    private SharedFileTransfer() { }

    static synchronized JSONObject beginUpload(
            Context context, String destinationPath, long sizeBytes, String sha256) throws Exception {
        assertStorageAccess();
        if (sizeBytes < 0L || sizeBytes > MAX_FILE_BYTES) {
            throw new IllegalArgumentException("Shared file size must be between 0 bytes and 2 GiB");
        }
        String uploadId = normalizeDigest(sha256);
        File destination = resolveSharedPath(destinationPath, false);
        File parent = destination.getParentFile();
        if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) {
            throw new IllegalStateException("Unable to create shared file directory");
        }
        File part = partFile(context, uploadId);
        File metadataFile = metadataFile(context, uploadId);
        JSONObject metadata = readMetadata(metadataFile);
        boolean resumable = metadata != null
                && uploadId.equals(metadata.optString("sha256"))
                && destination.getCanonicalPath().equals(metadata.optString("destination"))
                && sizeBytes == metadata.optLong("sizeBytes", -1L)
                && part.isFile() && part.length() <= sizeBytes;
        if (!resumable) {
            if (part.exists() && !part.delete()) throw new IllegalStateException("Unable to reset shared upload");
            if (!part.createNewFile()) throw new IllegalStateException("Unable to create shared upload");
            metadata = new JSONObject()
                    .put("uploadId", uploadId)
                    .put("sha256", uploadId)
                    .put("destination", destination.getCanonicalPath())
                    .put("sizeBytes", sizeBytes);
        }
        metadata.put("receivedBytes", part.length()).put("updatedAt", System.currentTimeMillis());
        writeMetadata(metadataFile, metadata);
        return uploadStatus(metadata).put("resumed", resumable);
    }

    static synchronized JSONObject appendUpload(
            Context context, String id, long offset, String encoded, String expectedChunkSha256) throws Exception {
        String uploadId = normalizeDigest(id);
        JSONObject metadata = requireMetadata(context, uploadId);
        File part = partFile(context, uploadId);
        long received = part.length();
        long sizeBytes = metadata.getLong("sizeBytes");
        if (offset != received) throw new IllegalStateException("Chunk offset mismatch; expected " + received);
        if (encoded == null || encoded.length() > (MAX_CHUNK_BYTES * 4 / 3) + 16) {
            throw new IllegalArgumentException("Encoded shared file chunk is too large");
        }
        byte[] chunk = Base64.decode(encoded, Base64.DEFAULT);
        if (chunk.length <= 0 || chunk.length > MAX_CHUNK_BYTES || received + chunk.length > sizeBytes) {
            throw new IllegalArgumentException("Invalid shared file chunk size");
        }
        if (!hex(MessageDigest.getInstance("SHA-256").digest(chunk))
                .equals(normalizeDigest(expectedChunkSha256))) {
            throw new SecurityException("Shared file chunk digest mismatch");
        }
        try (FileOutputStream output = new FileOutputStream(part, true)) {
            output.write(chunk);
            output.getFD().sync();
        }
        metadata.put("receivedBytes", part.length()).put("updatedAt", System.currentTimeMillis());
        writeMetadata(metadataFile(context, uploadId), metadata);
        return uploadStatus(metadata);
    }

    static synchronized JSONObject commitUpload(Context context, String id) throws Exception {
        assertStorageAccess();
        String uploadId = normalizeDigest(id);
        JSONObject metadata = requireMetadata(context, uploadId);
        File part = partFile(context, uploadId);
        if (part.length() != metadata.getLong("sizeBytes")) {
            throw new IllegalStateException("Shared file upload is incomplete");
        }
        if (!uploadId.equals(digest(part))) throw new SecurityException("Complete shared file digest mismatch");
        File destination = resolveSharedPath(metadata.getString("destination"), false);
        File sibling = new File(destination.getParentFile(), ".arlab-" + uploadId + ".part");
        try {
            Files.copy(part.toPath(), sibling.toPath(), StandardCopyOption.REPLACE_EXISTING);
            try {
                Files.move(sibling.toPath(), destination.toPath(),
                        StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(sibling.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            if (sibling.exists()) sibling.delete();
        }
        if (destination.length() != part.length() || !uploadId.equals(digest(destination))) {
            throw new SecurityException("Committed shared file verification failed");
        }
        if (!part.delete()) part.deleteOnExit();
        metadataFile(context, uploadId).delete();
        return new JSONObject().put("completed", true).put("path", destination.getCanonicalPath())
                .put("sizeBytes", destination.length()).put("sha256", uploadId);
    }

    static JSONObject beginDownload(Context context, String sourcePath) throws Exception {
        assertStorageAccess();
        File source = resolveSharedPath(sourcePath, true);
        if (!source.isFile()) throw new IllegalArgumentException("Shared source is not a file");
        if (source.length() > MAX_FILE_BYTES) throw new IllegalArgumentException("Shared file exceeds 2 GiB");
        return new JSONObject().put("path", source.getCanonicalPath()).put("sizeBytes", source.length())
                .put("sha256", digest(source)).put("chunkBytes", MAX_CHUNK_BYTES);
    }

    static JSONObject readDownloadChunk(Context context, String sourcePath, long offset) throws Exception {
        assertStorageAccess();
        File source = resolveSharedPath(sourcePath, true);
        if (!source.isFile() || offset < 0L || offset > source.length()) {
            throw new IllegalArgumentException("Invalid shared download offset");
        }
        int count = (int) Math.min(MAX_CHUNK_BYTES, source.length() - offset);
        byte[] bytes = new byte[count];
        if (count > 0) {
            try (RandomAccessFile input = new RandomAccessFile(source, "r")) {
                input.seek(offset);
                input.readFully(bytes);
            }
        }
        return new JSONObject().put("offset", offset).put("sizeBytes", source.length())
                .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                .put("chunkSha256", hex(MessageDigest.getInstance("SHA-256").digest(bytes)))
                .put("nextOffset", offset + count).put("completed", offset + count == source.length());
    }

    private static void assertStorageAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
            throw new SecurityException("MANAGE_EXTERNAL_STORAGE is required for non-disruptive shared file transfer");
        }
    }

    private static File resolveSharedPath(String value, boolean mustExist) throws Exception {
        if (value == null || value.indexOf('\0') >= 0 || !value.startsWith("/")) {
            throw new IllegalArgumentException("An absolute shared-storage path is required");
        }
        File root = Environment.getExternalStorageDirectory().getCanonicalFile();
        String normalized = value.equals("/sdcard") ? root.getPath()
                : value.startsWith("/sdcard/") ? root.getPath() + value.substring(7) : value;
        File candidate = new File(normalized).getCanonicalFile();
        if (candidate.equals(root) || !candidate.getPath().startsWith(root.getPath() + File.separator)) {
            throw new SecurityException("Path is outside primary shared storage");
        }
        if (mustExist && !candidate.exists()) throw new IllegalArgumentException("Shared file does not exist");
        return candidate;
    }

    private static JSONObject requireMetadata(Context context, String uploadId) throws Exception {
        JSONObject metadata = readMetadata(metadataFile(context, uploadId));
        if (metadata == null || !partFile(context, uploadId).isFile()) {
            throw new IllegalStateException("Unknown shared file upload");
        }
        return metadata;
    }

    private static JSONObject uploadStatus(JSONObject metadata) throws Exception {
        return new JSONObject().put("uploadId", metadata.getString("uploadId"))
                .put("sizeBytes", metadata.getLong("sizeBytes"))
                .put("receivedBytes", metadata.getLong("receivedBytes"));
    }

    private static File directory(Context context) {
        File value = new File(context.createDeviceProtectedStorageContext().getFilesDir(), "shared-transfer");
        if (!value.isDirectory() && !value.mkdirs()) throw new IllegalStateException("Unable to create transfer storage");
        return value;
    }

    private static File partFile(Context context, String uploadId) {
        return new File(directory(context), uploadId + ".part");
    }

    private static File metadataFile(Context context, String uploadId) {
        return new File(directory(context), uploadId + ".json");
    }

    private static JSONObject readMetadata(File file) {
        if (!file.isFile()) return null;
        try (FileReader reader = new FileReader(file)) {
            StringBuilder value = new StringBuilder();
            char[] buffer = new char[4096];
            int count;
            while ((count = reader.read(buffer)) >= 0) value.append(buffer, 0, count);
            return new JSONObject(value.toString());
        } catch (Throwable ignored) { return null; }
    }

    private static void writeMetadata(File destination, JSONObject value) throws Exception {
        File temporary = new File(destination.getParentFile(), destination.getName() + ".tmp");
        try (FileWriter writer = new FileWriter(temporary, false)) {
            writer.write(value.toString());
            writer.flush();
        }
        Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }

    private static String digest(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[1024 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) if (count > 0) digest.update(buffer, 0, count);
        }
        return hex(digest.digest());
    }

    private static String normalizeDigest(String value) {
        String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        if (!normalized.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("A SHA-256 transfer ID is required");
        return normalized;
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) value.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return value.toString();
    }
}
