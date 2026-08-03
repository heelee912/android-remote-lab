package com.codex.remotecompanion;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;

public final class InstallResultReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String uploadId = intent.getStringExtra("uploadId");
        int statusCode = intent.getIntExtra(
                PackageInstaller.EXTRA_STATUS,
                PackageInstaller.STATUS_FAILURE);
        String packageName = intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME);
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);

        if (statusCode == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmation;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
            } else {
                @SuppressWarnings("deprecation")
                Intent legacy = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                confirmation = legacy;
            }
            ApkInstaller.recordResult(
                    context, uploadId, statusCode, "pending-user-action", packageName, message);
            if (confirmation != null) {
                confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(confirmation);
            }
            return;
        }

        String status = statusCode == PackageInstaller.STATUS_SUCCESS ? "success" : "failed";
        ApkInstaller.recordResult(context, uploadId, statusCode, status, packageName, message);
    }
}
