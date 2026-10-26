package com.codex.remotecompanion;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.AppOpsManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Process;
import android.view.accessibility.AccessibilityManager;

import org.json.JSONObject;

import java.util.List;

/** Reports only this app's accessibility state, without exposing other services. */
final class AccessibilityReadiness {
    private static final String RESTRICTED_SETTINGS_OP = "android:access_restricted_settings";

    private AccessibilityReadiness() { }

    static JSONObject diagnostics(Context context) throws Exception {
        AccessibilityManager manager = (AccessibilityManager) context.getSystemService(
                Context.ACCESSIBILITY_SERVICE);
        ComponentName service = new ComponentName(context, ControlAccessibilityService.class);
        JSONObject result = new JSONObject()
                .put("bound", ControlAccessibilityService.getInstance() != null);
        try {
            result.put("installed", contains(manager == null ? null
                    : manager.getInstalledAccessibilityServiceList(), service));
            result.put("enabledInSettings", contains(manager == null ? null
                    : manager.getEnabledAccessibilityServiceList(
                            AccessibilityServiceInfo.FEEDBACK_ALL_MASK), service));
        } catch (RuntimeException error) {
            result.put("inspectionError", error.getClass().getSimpleName());
        }
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                result.put("packageSource", context.getPackageManager()
                        .getInstallSourceInfo(context.getPackageName()).getPackageSource());
            } catch (PackageManager.NameNotFoundException | RuntimeException error) {
                result.put("packageSourceError", error.getClass().getSimpleName());
            }
            try {
                AppOpsManager appOps = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
                int mode = appOps.unsafeCheckOpNoThrow(RESTRICTED_SETTINGS_OP,
                        Process.myUid(), context.getPackageName());
                result.put("restrictedSettingsMode", mode);
            } catch (RuntimeException error) {
                result.put("restrictedSettingsError", error.getClass().getSimpleName());
            }
        }
        return result;
    }

    private static boolean contains(List<AccessibilityServiceInfo> services, ComponentName target) {
        if (services == null) return false;
        for (AccessibilityServiceInfo info : services) {
            if (target.equals(ComponentName.unflattenFromString(info.getId()))) return true;
        }
        return false;
    }
}
