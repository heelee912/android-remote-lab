package com.codex.nightscreenguard;

import android.app.Activity;
import android.app.TimePickerDialog;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.util.TypedValue;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;

import java.util.Locale;

public final class MainActivity extends Activity {
    private TextView status;
    private Button startButton;
    private Button endButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        SharedPreferences preferences = NightScreenPolicy.preferences(this);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 24,
                getResources().getDisplayMetrics());
        layout.setPadding(padding, padding, padding, padding);

        TextView description = new TextView(this);
        description.setText(R.string.ready);
        layout.addView(description);

        Switch enabled = new Switch(this);
        enabled.setText(R.string.enabled);
        enabled.setChecked(preferences.getBoolean("enabled", false));
        enabled.setEnabled(NightScreenPolicy.hasPermission(this));
        layout.addView(enabled);

        startButton = new Button(this);
        startButton.setText(R.string.start_time);
        layout.addView(startButton);
        endButton = new Button(this);
        endButton.setText(R.string.end_time);
        layout.addView(endButton);

        status = new TextView(this);
        layout.addView(status);
        setContentView(layout);

        startButton.setOnClickListener(v -> chooseTime("startMinute",
                NightScreenPolicy.DEFAULT_START_MINUTE));
        endButton.setOnClickListener(v -> chooseTime("endMinute",
                NightScreenPolicy.DEFAULT_END_MINUTE));
        enabled.setOnCheckedChangeListener((button, checked) -> {
            preferences.edit().putBoolean("enabled", checked).commit();
            applyPolicy();
        });
        refreshLabels();
        applyPolicy();
    }

    private void chooseTime(String preference, int fallback) {
        SharedPreferences preferences = NightScreenPolicy.preferences(this);
        int current = preferences.getInt(preference, fallback);
        new TimePickerDialog(this, (picker, hour, minute) -> {
            preferences.edit().putInt(preference, hour * 60 + minute).commit();
            refreshLabels();
            applyPolicy();
        }, current / 60, current % 60, true).show();
    }

    private void refreshLabels() {
        SharedPreferences preferences = NightScreenPolicy.preferences(this);
        startButton.setText(getString(R.string.start_time) + "  " + formatMinute(
                preferences.getInt("startMinute", NightScreenPolicy.DEFAULT_START_MINUTE)));
        endButton.setText(getString(R.string.end_time) + "  " + formatMinute(
                preferences.getInt("endMinute", NightScreenPolicy.DEFAULT_END_MINUTE)));
    }

    private void applyPolicy() {
        try {
            NightScreenPolicy.synchronize(this);
            ScreenGuardScheduler.schedule(this);
            status.setText(NightScreenPolicy.hasPermission(this)
                    ? getString(R.string.ready) : getString(R.string.permission_missing));
        } catch (RuntimeException error) {
            status.setText(error.getMessage());
        }
    }

    private static String formatMinute(int minuteOfDay) {
        return String.format(Locale.getDefault(), "%02d:%02d", minuteOfDay / 60,
                minuteOfDay % 60);
    }
}
