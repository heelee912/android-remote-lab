package com.codex.remotecompanion;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

final class DeviceIdentity {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "remote-companion-device-v1";

    private DeviceIdentity() {}

    static KeyPair getOrCreate() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        if (!keyStore.containsAlias(ALIAS)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(
                    KeyProperties.KEY_ALGORITHM_EC,
                    KEYSTORE);
            generator.initialize(new KeyGenParameterSpec.Builder(
                    ALIAS,
                    KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setUnlockedDeviceRequired(false)
                    .build());
            generator.generateKeyPair();
        }
        PrivateKey privateKey = (PrivateKey) keyStore.getKey(ALIAS, null);
        PublicKey publicKey = keyStore.getCertificate(ALIAS).getPublicKey();
        return new KeyPair(publicKey, privateKey);
    }

    static String deviceId(PublicKey publicKey) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(publicKey.getEncoded());
        StringBuilder value = new StringBuilder();
        for (int index = 0; index < 16; index++) {
            value.append(String.format("%02x", digest[index] & 0xff));
        }
        return value.toString();
    }

    static String publicKey(PublicKey publicKey) {
        return Base64.encodeToString(publicKey.getEncoded(), Base64.NO_WRAP);
    }

    static String sign(PrivateKey privateKey, String value) throws Exception {
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initSign(privateKey);
        signature.update(value.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(signature.sign(), Base64.NO_WRAP);
    }
}
