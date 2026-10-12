package com.codex.remotecompanion;

import android.app.Instrumentation;
import android.os.Bundle;
import android.content.Context;
import java.lang.reflect.Method;

/** Real Android display regression, isolated from the relay and app account. */
public final class WakeProbeInstrumentation extends Instrumentation {
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        DisplayLease lease = null;
        try {
            Context context = getTargetContext();
            boolean before = DeviceReadiness.interactive(context);
            lease = new DisplayLease(context);
            CommandDispatcher d = new CommandDispatcher(context, lease);
            Method ready = CommandDispatcher.class.getDeclaredMethod("awaitDisplayReady");
            ready.setAccessible(true);
            lease.renew(10000L);
            ready.invoke(d);
            if (!DeviceReadiness.interactive(context)) throw new AssertionError("Display did not wake");
            if (DeviceReadiness.keyguardShowing(context)) throw new AssertionError("Unsecured keyguard still showing");
            lease.renew(10000L);
            ready.invoke(d);
            if (!DeviceReadiness.interactive(context)) throw new AssertionError("Repeated wake switched off the display");
            result.putString("wake_result", "PASS");
            result.putBoolean("interactive_before", before);
            result.putBoolean("interactive_after", DeviceReadiness.interactive(context));
            finish(-1, result);
        } catch (Throwable error) {
            result.putString("wake_result", "FAIL: " + error.toString());
            finish(0, result);
        } finally { if (lease != null) lease.release(); }
    }
}
