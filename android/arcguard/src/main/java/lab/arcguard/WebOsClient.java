package lab.arcguard;

import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.UUID;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.json.JSONArray;
import org.json.JSONObject;

final class WebOsClient implements AutoCloseable {
    private static final int MAX_MESSAGE_BYTES = 1024 * 1024;
    private static final int TIMEOUT_MS = 8000;
    private final SSLSocket socket;
    private final InputStream input;
    private final OutputStream output;
    private final SecureRandom random = new SecureRandom();

    private WebOsClient(SSLSocket socket) throws IOException {
        this.socket = socket;
        this.input = socket.getInputStream();
        this.output = socket.getOutputStream();
    }

    static WebOsClient connect(ArcGuardConfig config) throws Exception {
        X509TrustManager pinnedTv = new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType)
                    throws CertificateException {
                throw new CertificateException("Client certificates are not accepted");
            }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType)
                    throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("No TV certificate");
                try {
                    String actual = hex(MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded()));
                    if (!MessageDigest.isEqual(actual.getBytes(StandardCharsets.US_ASCII),
                            config.fingerprint.getBytes(StandardCharsets.US_ASCII))) {
                        throw new CertificateException("Paired TV certificate changed");
                    }
                } catch (java.security.NoSuchAlgorithmException failure) {
                    throw new CertificateException("SHA-256 unavailable", failure);
                }
            }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] { pinnedTv }, new SecureRandom());
        SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket();
        try {
            socket.connect(new InetSocketAddress(config.host, 3001), TIMEOUT_MS);
            socket.setSoTimeout(TIMEOUT_MS);
            socket.startHandshake();
            byte[] certificate = socket.getSession().getPeerCertificates()[0].getEncoded();
            String actualFingerprint = hex(MessageDigest.getInstance("SHA-256").digest(certificate));
            if (!MessageDigest.isEqual(actualFingerprint.getBytes(StandardCharsets.US_ASCII),
                    config.fingerprint.getBytes(StandardCharsets.US_ASCII))) {
                throw new IOException("Paired TV certificate changed");
            }
            WebOsClient client = new WebOsClient(socket);
            client.upgrade(config.host);
            client.register(config.clientKey);
            return client;
        } catch (Exception failure) {
            socket.close();
            throw failure;
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }

    private void upgrade(String host) throws Exception {
        byte[] nonce = new byte[16];
        random.nextBytes(nonce);
        String key = Base64.encodeToString(nonce, Base64.NO_WRAP);
        String request = "GET / HTTP/1.1\r\nHost: " + host + ":3001\r\n"
                + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n";
        output.write(request.getBytes(StandardCharsets.US_ASCII));
        output.flush();
        ByteArrayOutputStream header = new ByteArrayOutputStream();
        while (header.size() < 16384) {
            int value = input.read();
            if (value < 0) throw new IOException("TV closed WebSocket handshake");
            header.write(value);
            byte[] bytes = header.toByteArray();
            int size = bytes.length;
            if (size >= 4 && bytes[size - 4] == '\r' && bytes[size - 3] == '\n'
                    && bytes[size - 2] == '\r' && bytes[size - 1] == '\n') break;
        }
        String response = new String(header.toByteArray(), StandardCharsets.US_ASCII);
        String expected = Base64.encodeToString(MessageDigest.getInstance("SHA-1")
                .digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
                        .getBytes(StandardCharsets.US_ASCII)), Base64.NO_WRAP);
        boolean accepted = false;
        for (String line : response.split("\\r\\n")) {
            int colon = line.indexOf(':');
            if (colon > 0 && "sec-websocket-accept".equalsIgnoreCase(line.substring(0, colon))) {
                accepted = expected.equals(line.substring(colon + 1).trim());
            }
        }
        if (!response.startsWith("HTTP/1.1 101 ") || !accepted) {
            throw new IOException("TV rejected WebSocket handshake");
        }
    }

    private void register(String clientKey) throws Exception {
        JSONArray permissions = new JSONArray();
        for (String permission : new String[] { "CONTROL_AUDIO", "CONTROL_DISPLAY",
                "CONTROL_INPUT_TV", "CONTROL_MOUSE_AND_KEYBOARD", "CONTROL_POWER",
                "CONTROL_TV_SCREEN", "LAUNCH", "READ_APP_STATUS", "READ_CURRENT_CHANNEL",
                "READ_INPUT_DEVICE_LIST", "READ_INSTALLED_APPS", "READ_NETWORK_STATE",
                "READ_POWER_STATE", "READ_RUNNING_APPS", "READ_SETTINGS", "WRITE_SETTINGS" }) {
            permissions.put(permission);
        }
        JSONObject manifest = new JSONObject().put("appVersion", "1.0")
                .put("manifestVersion", 1).put("deviceName", "Android Remote Lab")
                .put("permissions", permissions);
        JSONObject payload = new JSONObject().put("client-key", clientKey)
                .put("forcePairing", false).put("manifest", manifest).put("pairingType", "PROMPT");
        send(new JSONObject().put("type", "register").put("id", "register_0")
                .put("payload", payload));
        for (int attempt = 0; attempt < 3; attempt++) {
            JSONObject reply = receive();
            if ("registered".equals(reply.optString("type"))) return;
            if ("error".equals(reply.optString("type"))) {
                throw new IOException("TV rejected paired key");
            }
        }
        throw new IOException("TV did not complete registration");
    }

    JSONObject request(String operation) throws Exception {
        return request(operation, new JSONObject());
    }

    JSONObject request(String operation, JSONObject payload) throws Exception {
        String id = UUID.randomUUID().toString();
        send(new JSONObject().put("type", "request").put("id", id)
                .put("uri", "ssap://" + operation).put("payload", payload));
        for (int attempt = 0; attempt < 8; attempt++) {
            JSONObject reply = receive();
            if (!id.equals(reply.optString("id"))) continue;
            JSONObject result = reply.optJSONObject("payload");
            if ("error".equals(reply.optString("type")) || result == null
                    || !result.optBoolean("returnValue", true)) {
                throw new IOException("TV rejected " + operation + ": " + reply.optString("error"));
            }
            return result;
        }
        throw new IOException("TV omitted response to " + operation);
    }

    private void send(JSONObject message) throws IOException {
        sendFrame(1, message.toString().getBytes(StandardCharsets.UTF_8));
    }

    private void sendFrame(int opcode, byte[] data) throws IOException {
        if (data.length > MAX_MESSAGE_BYTES) throw new IOException("WebSocket message too large");
        ByteArrayOutputStream frame = new ByteArrayOutputStream();
        frame.write(0x80 | opcode);
        if (data.length < 126) frame.write(0x80 | data.length);
        else if (data.length <= 65535) {
            frame.write(0xfe);
            frame.write((data.length >>> 8) & 0xff);
            frame.write(data.length & 0xff);
        } else {
            frame.write(0xff);
            for (int shift = 56; shift >= 0; shift -= 8) {
                frame.write((int) (((long) data.length >>> shift) & 0xff));
            }
        }
        byte[] mask = new byte[4];
        random.nextBytes(mask);
        frame.write(mask);
        for (int i = 0; i < data.length; i++) frame.write(data[i] ^ mask[i & 3]);
        output.write(frame.toByteArray());
        output.flush();
    }

    private JSONObject receive() throws Exception {
        ByteArrayOutputStream message = new ByteArrayOutputStream();
        for (;;) {
            int first = input.read();
            int second = input.read();
            if (first < 0 || second < 0) throw new IOException("TV closed WebSocket");
            int length = second & 0x7f;
            if (length == 126) length = (input.read() << 8) | input.read();
            else if (length == 127) {
                long longLength = 0;
                for (int i = 0; i < 8; i++) longLength = (longLength << 8) | input.read();
                if (longLength > MAX_MESSAGE_BYTES) throw new IOException("WebSocket frame too large");
                length = (int) longLength;
            }
            if (length < 0 || length > MAX_MESSAGE_BYTES - message.size()) {
                throw new IOException("WebSocket frame too large");
            }
            byte[] mask = (second & 0x80) == 0 ? null : readFully(4);
            byte[] data = readFully(length);
            if (mask != null) {
                for (int i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
            }
            int opcode = first & 0x0f;
            if (opcode == 8) throw new IOException("TV closed WebSocket");
            if (opcode == 9) { sendFrame(10, data); continue; }
            if (opcode != 0 && opcode != 1) continue;
            message.write(data);
            if ((first & 0x80) != 0) {
                return new JSONObject(new String(message.toByteArray(), StandardCharsets.UTF_8));
            }
        }
    }

    private byte[] readFully(int length) throws IOException {
        byte[] data = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = input.read(data, offset, length - offset);
            if (read < 0) throw new IOException("TV closed WebSocket frame");
            offset += read;
        }
        return data;
    }

    @Override public void close() throws IOException { socket.close(); }
}
