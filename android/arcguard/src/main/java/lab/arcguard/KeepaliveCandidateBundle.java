package lab.arcguard;

import android.util.Log;
import java.util.EnumSet;
import org.json.JSONObject;

final class KeepaliveCandidateBundle {
    private static final String TAG = "ArcStandbyGuard";

    private KeepaliveCandidateBundle() {}

    static EnumSet<KeepaliveCandidate> reassertWebOsState(WebOsClient tv, String soundOutput)
            throws Exception {
        EnumSet<KeepaliveCandidate> succeeded = EnumSet.of(
                KeepaliveCandidate.WEBOS_SESSION,
                KeepaliveCandidate.TV_POWER_STATUS,
                KeepaliveCandidate.FOREGROUND_INPUT,
                KeepaliveCandidate.SOUND_OUTPUT_STATUS,
                KeepaliveCandidate.ARC_DEVICE_STATUS);

        JSONObject audio = request(tv, KeepaliveCandidate.AUDIO_STATUS, "audio/getStatus",
                new JSONObject(), succeeded);
        request(tv, KeepaliveCandidate.AUDIO_VOLUME_STATUS, "audio/getVolume",
                new JSONObject(), succeeded);
        request(tv, KeepaliveCandidate.EXTERNAL_INPUT_STATUS, "tv/getExternalInputList",
                new JSONObject(), succeeded);
        request(tv, KeepaliveCandidate.WEBOS_SERVICE_LIST, "api/getServiceList",
                new JSONObject(), succeeded);
        request(tv, KeepaliveCandidate.SYSTEM_INFO, "system/getSystemInfo",
                new JSONObject(), succeeded);

        if ("external_arc".equals(soundOutput)) {
            request(tv, KeepaliveCandidate.REASSERT_ARC_OUTPUT,
                    "com.webos.service.apiadapter/audio/changeSoundOutput",
                    new JSONObject().put("output", soundOutput), succeeded);
        }
        if (audio != null && audio.has("mute")) {
            request(tv, KeepaliveCandidate.REASSERT_MUTE, "audio/setMute",
                    new JSONObject().put("mute", audio.optBoolean("mute")), succeeded);
        }
        if (audio != null && audio.has("volume")) {
            request(tv, KeepaliveCandidate.REASSERT_VOLUME, "audio/setVolume",
                    new JSONObject().put("volume", audio.optInt("volume")), succeeded);
        }
        return succeeded;
    }

    static String ids(EnumSet<KeepaliveCandidate> candidates) {
        StringBuilder result = new StringBuilder();
        for (KeepaliveCandidate candidate : candidates) {
            if (result.length() > 0) result.append(',');
            result.append(candidate.id);
        }
        return result.toString();
    }

    private static JSONObject request(WebOsClient tv, KeepaliveCandidate candidate,
            String operation, JSONObject payload, EnumSet<KeepaliveCandidate> succeeded) {
        try {
            JSONObject response = tv.request(operation, payload);
            succeeded.add(candidate);
            return response;
        } catch (Exception failure) {
            Log.w(TAG, "Candidate unavailable: " + candidate.id, failure);
            return null;
        }
    }
}
