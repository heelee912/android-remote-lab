package com.codex.remotecompanion;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.net.Uri;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.security.KeyPair;

public final class MainActivity extends Activity {
    private TextView status;
    private EditText host;
    private EditText port;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setTitle(getString(R.string.app_name));
        if (RelayPreferences.configured(this)) startConnectionService();

        boolean television = getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
        int padding = Math.round((television ? 28 : 20) * getResources().getDisplayMetrics().density);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(padding, padding, padding, padding);
        content.setGravity(Gravity.TOP);

        TextView title = new TextView(this);
        title.setText(R.string.app_name);
        title.setTextSize(television ? 36 : 24);
        title.setTextColor(Color.BLACK);
        content.addView(title, matchWrap());

        TextView description = new TextView(this);
        description.setText(R.string.description);
        description.setTextSize(television ? 24 : 16);
        description.setPadding(0, padding / 2, 0, padding);
        content.addView(description, matchWrap());

        host = new EditText(this);
        host.setHint(R.string.relay_host_hint);
        host.setSingleLine(true);
        if (television) host.setTextSize(23);
        host.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        String currentHost = RelayPreferences.host(this);
        if (!currentHost.isBlank()) host.setText(currentHost);
        content.addView(host, matchWrap());

        port = new EditText(this);
        port.setHint(R.string.relay_port_hint);
        port.setSingleLine(true);
        if (television) port.setTextSize(23);
        port.setInputType(InputType.TYPE_CLASS_NUMBER);
        port.setText(String.valueOf(RelayPreferences.port(this)));
        content.addView(port, matchWrap());

        Button save = new Button(this);
        save.setText(R.string.save_and_connect);
        if (television) save.setTextSize(22);
        save.setOnClickListener(view -> saveAndConnect());
        content.addView(save, matchWrap());

        status = new TextView(this);
        status.setTextSize(television ? 21 : 15);
        status.setTextColor(Color.DKGRAY);
        status.setPadding(0, padding, 0, padding / 2);
        content.addView(status, matchWrap());

        Button accessibility = new Button(this);
        accessibility.setText(R.string.open_accessibility);
        if (television) accessibility.setTextSize(22);
        accessibility.setContentDescription(getString(R.string.open_accessibility_description));
        accessibility.setOnClickListener(view -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        content.addView(accessibility, matchWrap());

        Button installs = new Button(this);
        installs.setText(R.string.open_install_permission);
        if (television) installs.setTextSize(22);
        installs.setContentDescription(getString(R.string.open_install_permission_description));
        installs.setOnClickListener(view -> startActivity(new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getPackageName()))));
        content.addView(installs, matchWrap());

        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        setContentView(scroll);

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 100);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    private void saveAndConnect() {
        try {
            int parsedPort = Integer.parseInt(port.getText().toString().trim());
            RelayPreferences.save(this, host.getText().toString(), parsedPort);
            stopService(new Intent(this, RendezvousService.class));
            new Handler(Looper.getMainLooper()).postDelayed(this::startConnectionService, 300L);
            refresh();
        } catch (RuntimeException error) {
            status.setText(getString(R.string.configuration_error, error.getMessage()));
        }
    }

    private void refresh() {
        if (status == null) return;
        try {
            KeyPair pair = DeviceIdentity.getOrCreate();
            String deviceId = DeviceIdentity.deviceId(pair.getPublic());
            status.setText(getString(
                    R.string.status_format,
                    RelayPreferences.endpoint(this),
                    deviceId,
                    ControlAccessibilityService.getInstance() != null
                            ? getString(R.string.enabled)
                            : getString(R.string.not_enabled),
                    RendezvousService.currentStatus()));
        } catch (Exception error) {
            status.setText(getString(R.string.setup_error, error.getClass().getSimpleName()));
        }
    }

    private void startConnectionService() {
        startForegroundService(new Intent(this, RendezvousService.class).putExtra("trigger", "activity"));
    }

    private static ViewGroup.LayoutParams matchWrap() {
        return new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
    }
}
