package com.codex.remotecompanion;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONObject;

import java.io.IOException;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.security.interfaces.RSAPublicKey;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.Map;

import javax.net.ssl.KeyManager;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509KeyManager;
import javax.net.ssl.X509TrustManager;
import javax.security.auth.x500.X500Principal;

/** Pairs with the TV's own remote service and sends D-pad keys without Accessibility. */
final class TvRemoteControl implements AutoCloseable {
    private static final String CERTIFICATE_ALIAS = "remote-companion-tv-control-v1";
    private static final String PREFERENCES = "tv-remote-control";
    private static final String PINNED_CERTIFICATE = "server-certificate-sha256";
    private static final int PAIRING_PORT = 6467;
    private static final int CONTROL_PORT = 6466;
    private static final long FEATURES = 3L; // Ping and key input.
    private static final Map<String, Integer> KEYS = new HashMap<>();

    static {
        KEYS.put("home", 3);
        KEYS.put("back", 4);
        KEYS.put("dpad_up", 19);
        KEYS.put("dpad_down", 20);
        KEYS.put("dpad_left", 21);
        KEYS.put("dpad_right", 22);
        KEYS.put("dpad_center", 23);
        KEYS.put("enter", 66);
        KEYS.put("menu", 82);
    }

    private final Context context;
    private SSLSocket pairingSocket;

    TvRemoteControl(Context context) {
        this.context = context;
    }

    synchronized JSONObject status() throws Exception {
        return new JSONObject()
                .put("paired", preferences().contains(PINNED_CERTIFICATE))
                .put("pairingCodeExpected", pairingSocket != null && !pairingSocket.isClosed());
    }

    synchronized JSONObject beginPairing() throws Exception {
        close();
        SSLSocket socket = openSocket(PAIRING_PORT, null);
        try {
            TvRemoteWire.send(socket.getOutputStream(), outer(10, TvRemoteWire.join(
                    TvRemoteWire.string(1, "atvremote"),
                    TvRemoteWire.string(2, "Android Remote Lab"))));
            boolean configured = false;
            for (int index = 0; index < 8; index++) {
                TvRemoteWire.Fields message = TvRemoteWire.receive(socket.getInputStream());
                requirePairingSuccess(message);
                if (message.has(11)) {
                    byte[] encoding = TvRemoteWire.join(
                            TvRemoteWire.number(1, 3), TvRemoteWire.number(2, 6));
                    TvRemoteWire.send(socket.getOutputStream(), outer(20, TvRemoteWire.join(
                            TvRemoteWire.bytes(1, encoding), TvRemoteWire.number(3, 1))));
                } else if (message.has(20)) {
                    byte[] encoding = TvRemoteWire.join(
                            TvRemoteWire.number(1, 3), TvRemoteWire.number(2, 6));
                    TvRemoteWire.send(socket.getOutputStream(), outer(30, TvRemoteWire.join(
                            TvRemoteWire.bytes(1, encoding), TvRemoteWire.number(2, 1))));
                } else if (message.has(31)) {
                    configured = true;
                    break;
                } else {
                    throw new IOException("Unexpected TV pairing response");
                }
            }
            if (!configured) throw new IOException("TV pairing did not show a code");
            pairingSocket = socket;
            return new JSONObject().put("pairingCodeExpected", true);
        } catch (Exception error) {
            socket.close();
            throw error;
        }
    }

    synchronized JSONObject finishPairing(String code) throws Exception {
        if (pairingSocket == null || pairingSocket.isClosed()) {
            throw new IllegalStateException("Start TV remote pairing first");
        }
        if (code == null || !code.matches("[0-9A-Fa-f]{6}")) {
            throw new IllegalArgumentException("TV pairing code must be six hexadecimal characters");
        }
        try {
            byte[] codeBytes = new byte[3];
            for (int index = 0; index < 3; index++) {
                codeBytes[index] = (byte) Integer.parseInt(code.substring(index * 2, index * 2 + 2), 16);
            }
            X509Certificate server = serverCertificate(pairingSocket);
            X509Certificate client = clientCertificate();
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(unsigned(((RSAPublicKey) client.getPublicKey()).getModulus()));
            digest.update(unsigned(((RSAPublicKey) client.getPublicKey()).getPublicExponent()));
            digest.update(unsigned(((RSAPublicKey) server.getPublicKey()).getModulus()));
            digest.update(unsigned(((RSAPublicKey) server.getPublicKey()).getPublicExponent()));
            digest.update(codeBytes, 1, 2);
            byte[] secret = digest.digest();
            if (secret[0] != codeBytes[0]) {
                throw new SecurityException("TV pairing code did not match this connection");
            }
            TvRemoteWire.send(pairingSocket.getOutputStream(), outer(40,
                    TvRemoteWire.bytes(1, secret)));
            TvRemoteWire.Fields response = TvRemoteWire.receive(pairingSocket.getInputStream());
            requirePairingSuccess(response);
            if (!response.has(41)) throw new IOException("TV pairing was not acknowledged");
            String pin = hex(MessageDigest.getInstance("SHA-256").digest(server.getEncoded()));
            if (!preferences().edit().putString(PINNED_CERTIFICATE, pin).commit()) {
                throw new IOException("TV pairing certificate was not saved");
            }
            return new JSONObject().put("paired", true);
        } finally {
            close();
        }
    }

    synchronized JSONObject press(String key) throws Exception {
        Integer keyCode = KEYS.get(key);
        if (keyCode == null) throw new IllegalArgumentException("Unsupported TV remote key");
        String pin = preferences().getString(PINNED_CERTIFICATE, null);
        if (pin == null) throw new IllegalStateException("TV remote is not paired");
        try (SSLSocket socket = openSocket(CONTROL_PORT, pin)) {
            boolean started = false;
            for (int index = 0; index < 16; index++) {
                TvRemoteWire.Fields message = TvRemoteWire.receive(socket.getInputStream());
                if (message.has(1)) {
                    byte[] deviceInfo = TvRemoteWire.join(
                            TvRemoteWire.number(3, 1), TvRemoteWire.string(4, "1"),
                            TvRemoteWire.string(5, "com.codex.remotecompanion"),
                            TvRemoteWire.string(6, BuildConfig.VERSION_NAME));
                    TvRemoteWire.send(socket.getOutputStream(), TvRemoteWire.bytes(1,
                            TvRemoteWire.join(TvRemoteWire.number(1, FEATURES),
                                    TvRemoteWire.bytes(2, deviceInfo))));
                } else if (message.has(2)) {
                    TvRemoteWire.send(socket.getOutputStream(), TvRemoteWire.bytes(2,
                            TvRemoteWire.number(1, FEATURES)));
                } else if (message.has(8)) {
                    long value = TvRemoteWire.parse(message.message(8)).number(1);
                    TvRemoteWire.send(socket.getOutputStream(), TvRemoteWire.bytes(9,
                            TvRemoteWire.number(1, value)));
                } else if (message.has(40)) {
                    started = true;
                    break;
                } else if (message.has(3)) {
                    throw new IOException("TV remote service rejected the session");
                }
            }
            if (!started) throw new IOException("TV remote session did not start");
            TvRemoteWire.send(socket.getOutputStream(), TvRemoteWire.bytes(10,
                    TvRemoteWire.join(TvRemoteWire.number(1, keyCode),
                            TvRemoteWire.number(2, 3))));
            return new JSONObject().put("dispatched", true).put("key", key);
        }
    }

    private SharedPreferences preferences() {
        return context.createDeviceProtectedStorageContext()
                .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static byte[] outer(int field, byte[] payload) {
        return TvRemoteWire.join(TvRemoteWire.number(1, 2), TvRemoteWire.number(2, 200),
                TvRemoteWire.bytes(field, payload));
    }

    private static void requirePairingSuccess(TvRemoteWire.Fields response) throws IOException {
        if (response.number(1) != 2 || response.number(2) != 200) {
            throw new IOException("TV remote pairing was rejected");
        }
    }

    private SSLSocket openSocket(int port, String expectedCertificateHash) throws Exception {
        KeyStore keys = clientKeys();
        X509Certificate certificate = (X509Certificate) keys.getCertificate(CERTIFICATE_ALIAS);
        PrivateKey privateKey = (PrivateKey) keys.getKey(CERTIFICATE_ALIAS, null);
        X509KeyManager keyManager = new ClientKeyManager(certificate, privateKey);
        X509TrustManager trustManager = new PinnedServer(expectedCertificateHash);
        SSLContext tls = SSLContext.getInstance("TLS");
        tls.init(new KeyManager[]{keyManager}, new TrustManager[]{trustManager}, new SecureRandom());
        Socket plain = new Socket();
        try {
            plain.connect(new InetSocketAddress("127.0.0.1", port), 2_000);
            SSLSocket socket = (SSLSocket) tls.getSocketFactory().createSocket(
                    plain, "127.0.0.1", port, true);
            socket.setSoTimeout(5_000);
            socket.startHandshake();
            return socket;
        } catch (Exception error) {
            plain.close();
            throw error;
        }
    }

    private static KeyStore clientKeys() throws Exception {
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
        keys.load(null);
        if (!keys.containsAlias(CERTIFICATE_ALIAS)) {
            long now = System.currentTimeMillis();
            KeyPairGenerator generator = KeyPairGenerator.getInstance(
                    KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(CERTIFICATE_ALIAS,
                    KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                    .setKeySize(2048)
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                    .setCertificateSubject(new X500Principal("CN=Android Remote Lab TV Control"))
                    .setCertificateSerialNumber(BigInteger.valueOf(now))
                    .setCertificateNotBefore(new Date(now - 60_000))
                    .setCertificateNotAfter(new Date(now + 10L * 365 * 24 * 60 * 60 * 1000))
                    .build());
            generator.generateKeyPair();
        }
        return keys;
    }

    private static X509Certificate clientCertificate() throws Exception {
        return (X509Certificate) clientKeys().getCertificate(CERTIFICATE_ALIAS);
    }

    private static X509Certificate serverCertificate(SSLSocket socket) throws Exception {
        return (X509Certificate) socket.getSession().getPeerCertificates()[0];
    }

    private static byte[] unsigned(BigInteger number) {
        byte[] signed = number.toByteArray();
        return signed[0] == 0 ? Arrays.copyOfRange(signed, 1, signed.length) : signed;
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) value.append(String.format("%02x", item & 0xff));
        return value.toString();
    }

    @Override
    public synchronized void close() throws IOException {
        if (pairingSocket != null) pairingSocket.close();
        pairingSocket = null;
    }

    private static final class PinnedServer implements X509TrustManager {
        private final String pin;

        PinnedServer(String pin) { this.pin = pin; }
        public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        public void checkClientTrusted(X509Certificate[] chain, String authType) { }
        public void checkServerTrusted(X509Certificate[] chain, String authType)
                throws CertificateException {
            if (chain == null || chain.length == 0) throw new CertificateException("TV certificate is missing");
            if (pin == null) return; // The displayed pairing code authenticates the first certificate.
            try {
                String actual = hex(MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded()));
                if (!pin.equals(actual)) throw new CertificateException("TV remote certificate changed");
            } catch (java.security.GeneralSecurityException error) {
                throw new CertificateException(error);
            }
        }
    }

    private static final class ClientKeyManager implements X509KeyManager {
        private final X509Certificate certificate;
        private final PrivateKey key;

        ClientKeyManager(X509Certificate certificate, PrivateKey key) {
            this.certificate = certificate;
            this.key = key;
        }
        public String[] getClientAliases(String keyType, java.security.Principal[] issuers) {
            return "RSA".equals(keyType) ? new String[]{CERTIFICATE_ALIAS} : null;
        }
        public String chooseClientAlias(String[] keyTypes, java.security.Principal[] issuers, Socket socket) {
            for (String type : keyTypes) if ("RSA".equals(type)) return CERTIFICATE_ALIAS;
            return null;
        }
        public String[] getServerAliases(String keyType, java.security.Principal[] issuers) { return null; }
        public String chooseServerAlias(String keyType, java.security.Principal[] issuers, Socket socket) { return null; }
        public X509Certificate[] getCertificateChain(String alias) {
            return CERTIFICATE_ALIAS.equals(alias) ? new X509Certificate[]{certificate} : null;
        }
        public PrivateKey getPrivateKey(String alias) {
            return CERTIFICATE_ALIAS.equals(alias) ? key : null;
        }
    }
}
