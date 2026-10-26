package com.codex.remotecompanion;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/** The small subset of protobuf framing used by Android TV Remote Service v2. */
final class TvRemoteWire {
    private static final int MAX_FRAME_BYTES = 65_536;

    private TvRemoteWire() { }

    static byte[] number(int field, long value) {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        writeVarintToBuffer(output, (long) field << 3);
        writeVarintToBuffer(output, value);
        return output.toByteArray();
    }

    static byte[] bytes(int field, byte[] value) {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        writeVarintToBuffer(output, ((long) field << 3) | 2);
        writeVarintToBuffer(output, value.length);
        output.write(value, 0, value.length);
        return output.toByteArray();
    }

    static byte[] string(int field, String value) {
        return bytes(field, value.getBytes(StandardCharsets.UTF_8));
    }

    static byte[] join(byte[]... parts) {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        for (byte[] part : parts) output.write(part, 0, part.length);
        return output.toByteArray();
    }

    static void send(OutputStream output, byte[] message) throws IOException {
        if (message.length > MAX_FRAME_BYTES) throw new IOException("TV remote frame is too large");
        writeVarint(output, message.length);
        output.write(message);
        output.flush();
    }

    static Fields receive(InputStream input) throws IOException {
        long size = readVarint(input);
        if (size < 0 || size > MAX_FRAME_BYTES) throw new IOException("Invalid TV remote frame length");
        byte[] frame = new byte[(int) size];
        new DataInputStream(input).readFully(frame);
        return parse(frame);
    }

    static Fields parse(byte[] frame) throws IOException {
        Fields fields = new Fields();
        int[] offset = {0};
        while (offset[0] < frame.length) {
            long tag = readVarint(frame, offset);
            int field = (int) (tag >>> 3);
            if (field <= 0) throw new IOException("Invalid TV remote field");
            switch ((int) (tag & 7)) {
                case 0:
                    fields.numbers.put(field, readVarint(frame, offset));
                    break;
                case 2:
                    long length = readVarint(frame, offset);
                    if (length < 0 || length > frame.length - offset[0]) {
                        throw new IOException("Invalid TV remote field length");
                    }
                    fields.messages.put(field, Arrays.copyOfRange(
                            frame, offset[0], offset[0] + (int) length));
                    offset[0] += (int) length;
                    break;
                default:
                    throw new IOException("Unsupported TV remote wire type");
            }
        }
        return fields;
    }

    private static void writeVarint(OutputStream output, long value) throws IOException {
        while ((value & ~0x7fL) != 0) {
            output.write((int) (value & 0x7f) | 0x80);
            value >>>= 7;
        }
        output.write((int) value);
    }

    private static void writeVarintToBuffer(ByteArrayOutputStream output, long value) {
        while ((value & ~0x7fL) != 0) {
            output.write((int) (value & 0x7f) | 0x80);
            value >>>= 7;
        }
        output.write((int) value);
    }

    private static long readVarint(InputStream input) throws IOException {
        long result = 0;
        for (int shift = 0; shift < 63; shift += 7) {
            int value = input.read();
            if (value < 0) throw new EOFException("TV remote stream closed");
            result |= (long) (value & 0x7f) << shift;
            if ((value & 0x80) == 0) return result;
        }
        throw new IOException("TV remote varint is too long");
    }

    private static long readVarint(byte[] frame, int[] offset) throws IOException {
        long result = 0;
        for (int shift = 0; shift < 63; shift += 7) {
            if (offset[0] >= frame.length) throw new EOFException("Incomplete TV remote field");
            int value = frame[offset[0]++] & 0xff;
            result |= (long) (value & 0x7f) << shift;
            if ((value & 0x80) == 0) return result;
        }
        throw new IOException("TV remote varint is too long");
    }

    static final class Fields {
        private final Map<Integer, Long> numbers = new HashMap<>();
        private final Map<Integer, byte[]> messages = new HashMap<>();

        boolean has(int field) { return numbers.containsKey(field) || messages.containsKey(field); }
        long number(int field) { return numbers.getOrDefault(field, 0L); }
        byte[] message(int field) { return messages.get(field); }
    }
}
