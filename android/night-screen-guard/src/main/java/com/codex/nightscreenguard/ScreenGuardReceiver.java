package com.codex.nightscreenguard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public final class ScreenGuardReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            NightScreenPolicy.synchronize(context);
            ScreenGuardScheduler.schedule(context);
        } catch (RuntimeException error) {
            Log.e("NightScreenGuard", "Could not apply night screen policy", error);
        }
    }
}
