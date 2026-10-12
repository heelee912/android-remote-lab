package com.codex.remotecompanion;

import android.app.KeyguardManager;
import android.content.Context;
import android.os.PowerManager;
import android.os.UserManager;
import org.json.JSONObject;

final class DeviceReadiness {
    static boolean secureLocked(Context context) {
        KeyguardManager k = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        return k != null && k.isDeviceLocked();
    }
    static boolean keyguardShowing(Context context) {
        KeyguardManager k = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        return k != null && k.isKeyguardLocked();
    }
    static boolean interactive(Context context) {
        PowerManager p = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return p != null && p.isInteractive();
    }
    static JSONObject add(Context context, JSONObject result) throws Exception {
        UserManager u = (UserManager) context.getSystemService(Context.USER_SERVICE);
        return result.put("supportsAtomicGuards", true).put("keyguardLocked", keyguardShowing(context))
                .put("secureKeyguardLocked", secureLocked(context))
                .put("screenInteractive", interactive(context))
                .put("userUnlocked", u != null && u.isUserUnlocked());
    }
}
