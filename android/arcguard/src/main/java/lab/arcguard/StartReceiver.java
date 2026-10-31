package lab.arcguard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class StartReceiver extends BroadcastReceiver {
    static final String ACTION_START = "lab.arcguard.START_SERVICE";

    @Override public void onReceive(Context context, Intent intent) {
        if (ACTION_START.equals(intent.getAction())) {
            context.startForegroundService(new Intent(context, ArcGuardService.class));
        }
    }
}
