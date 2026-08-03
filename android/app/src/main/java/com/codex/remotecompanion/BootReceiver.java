package com.codex.remotecompanion;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String trigger = intent == null ? "unknown" : intent.getAction();
        RendezvousService.appendBootEvent(context, "received " + trigger);
        Intent service = new Intent(context, RendezvousService.class);
        service.putExtra("trigger", trigger);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
            RendezvousService.appendBootEvent(context, "service start accepted for " + trigger);
        } catch (RuntimeException error) {
            RendezvousService.appendBootFailure(context, error);
        }
    }
}
