package com.codex.remotecompanion;

import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;

final class Protocol {
    static final int MAX_FRAME_BYTES = 16 * 1024 * 1024;

    private Protocol() {}

    static JSONObject read(DataInputStream input) throws Exception {
        final int size;
        try {
            size = input.readInt();
        } catch (EOFException error) {
            throw error;
        }
        if (size <= 0 || size > MAX_FRAME_BYTES) {
            throw new IOException("Invalid frame size: " + size);
        }
        byte[] payload = new byte[size];
        input.readFully(payload);
        return new JSONObject(new String(payload, StandardCharsets.UTF_8));
    }

    static synchronized void write(DataOutputStream output, JSONObject value) throws Exception {
        byte[] payload = value.toString().getBytes(StandardCharsets.UTF_8);
        if (payload.length > MAX_FRAME_BYTES) {
            throw new IOException("Frame exceeds limit: " + payload.length);
        }
        // Keep the length prefix and body in one TLS write. Separate small
        // records can wait for TCP acknowledgement on every request/response.
        byte[] frame = ByteBuffer.allocate(payload.length + 4).putInt(payload.length).put(payload).array();
        output.write(frame);
        output.flush();
    }
}
