package com.codex.remotecompanion;

import android.app.Activity;
import android.app.KeyguardManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

/** Dismiss only a keyguard that Android reports needs no authentication. */
public final class WakeActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        KeyguardManager k = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        if (k == null || k.isDeviceLocked()) { finish(); return; }
        k.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
            @Override public void onDismissSucceeded() { finish(); }
            @Override public void onDismissCancelled() { finish(); }
            @Override public void onDismissError() { finish(); }
        });
        new Handler(Looper.getMainLooper()).postDelayed(this::finish, 2500L);
    }
}
