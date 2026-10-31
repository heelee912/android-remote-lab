package lab.arcguard;

import android.content.Context;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Locale;
import org.json.JSONObject;

final class ArcGuardConfig {
    final String host;
    final String fingerprint;
    final String clientKey;
    final String inputAppId;

    private ArcGuardConfig(String host, String fingerprint, String clientKey, String inputAppId) {
        this.host = host;
        this.fingerprint = fingerprint;
        this.clientKey = clientKey;
        this.inputAppId = inputAppId;
    }

    static ArcGuardConfig load(Context context) throws Exception {
        File file = new File(context.getFilesDir(), "webos-client-key.json");
        JSONObject value = new JSONObject(new String(Files.readAllBytes(file.toPath()),
                StandardCharsets.UTF_8));
        String host = value.getString("host");
        String fingerprint = value.getString("fingerprint").toLowerCase(Locale.ROOT);
        String clientKey = value.getString("clientKey");
        String inputAppId = value.optString("inputAppId", "com.webos.app.hdmi3");
        if (!host.matches("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}")
                || !fingerprint.matches("[0-9a-f]{64}") || clientKey.isEmpty()) {
            throw new IllegalArgumentException("Invalid paired TV configuration");
        }
        return new ArcGuardConfig(host, fingerprint, clientKey, inputAppId);
    }
}
