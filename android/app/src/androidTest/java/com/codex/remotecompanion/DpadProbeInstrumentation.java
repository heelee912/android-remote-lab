package com.codex.remotecompanion;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import java.util.concurrent.atomic.AtomicInteger;

/** Verifies Android's official keyboard global actions with sensitive controls. */
final class DpadProbeInstrumentation {
    static void run(Instrumentation self) {
        Bundle result = new Bundle();
        AtomicInteger effects = new AtomicInteger();
        try {
            self.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            Activity activity = self.startActivitySync(new Intent(self.getTargetContext(), MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
            self.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            UiAutomation automation = self.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            automation.executeShellCommand("settings put secure enabled_accessibility_services ''").close();
            SystemClock.sleep(500);
            automation.executeShellCommand("settings put secure enabled_accessibility_services com.codex.remotecompanion/com.codex.remotecompanion.ControlAccessibilityService").close();
            automation.executeShellCommand("settings put secure accessibility_enabled 1").close();
            Button[] buttons = new Button[2];
            self.runOnMainSync(() -> {
                LinearLayout box = new LinearLayout(activity);
                box.setOrientation(LinearLayout.HORIZONTAL);
                buttons[0] = new Button(activity);
                buttons[0].setText("Cancel probe");
                buttons[1] = new Button(activity);
                buttons[1].setText("Update probe");
                buttons[1].setAccessibilityDataSensitive(View.ACCESSIBILITY_DATA_SENSITIVE_YES);
                buttons[1].setOnClickListener(v -> effects.incrementAndGet());
                for (Button b : buttons) { b.setAllCaps(false); b.setFocusableInTouchMode(true); box.addView(b, new LinearLayout.LayoutParams(450, 200)); }
                activity.setContentView(box);
                buttons[0].requestFocus();
            });
            ControlAccessibilityService service = null;
            boolean rootReady = false;
            String lastSnapshot = "none";
            long deadline = SystemClock.elapsedRealtime() + 10000;
            while (SystemClock.elapsedRealtime() < deadline) {
                service = ControlAccessibilityService.getInstance();
                try {
                    if (service != null) lastSnapshot = service.snapshot().toString();
                    if (lastSnapshot.contains("Cancel probe")) {
                        rootReady = true;
                        break;
                    }
                } catch (IllegalStateException transientRoot) { lastSnapshot = transientRoot.toString(); }
                SystemClock.sleep(100);
            }
            if (service == null || !rootReady) {
                result.putString("window_snapshot", lastSnapshot);
                throw new AssertionError("Accessibility window unavailable");
            }
            boolean rejected = false;
            try { service.performGlobal("dpad_center", "com.example.wrong"); }
            catch (IllegalStateException expected) { rejected = true; }
            if (!rejected || effects.get() != 0) throw new AssertionError("Foreground guard failed");
            if (!service.performGlobal("dpad_right", "com.codex.remotecompanion")) throw new AssertionError("Dpad right rejected");
            SystemClock.sleep(250);
            if (!buttons[1].isFocused()) throw new AssertionError("Update button not focused");
            if (!service.performGlobal("dpad_center", "com.codex.remotecompanion")) throw new AssertionError("Dpad center rejected");
            SystemClock.sleep(300);
            if (effects.get() != 1) throw new AssertionError("Expected one actual button effect: " + effects.get());
            result.putString("dpad_result", "PASS");
            result.putInt("effects", effects.get());
            result.putBoolean("foreground_guard", rejected);
            self.finish(-1, result);
        } catch (Throwable error) {
            result.putString("dpad_result", "FAIL: " + error);
            self.finish(0, result);
        }
    }
}
