package com.codex.remotecompanion;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import org.json.JSONObject;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;

/** Read-only checks for recovery paths available on this TV firmware. */
final class TvRecoveryDiagnostics {
    private static final int REMOTE_PORT = 6466;
    private static final int PAIRING_PORT = 6467;

    private TvRecoveryDiagnostics() { }

    static JSONObject inspect(Context context) throws Exception {
        PackageManager packages = context.getPackageManager();
        Intent restriction = new Intent("android.settings.SHOW_RESTRICTED_SETTING_DIALOG");
        ResolveInfo activity = packages.resolveActivity(restriction, PackageManager.MATCH_DEFAULT_ONLY);
        JSONObject result = new JSONObject()
                .put("restrictedDialogHandler", activity == null || activity.activityInfo == null
                        ? JSONObject.NULL : activity.activityInfo.packageName + "/" + activity.activityInfo.name)
                .put("restrictedDialogExported", activity != null && activity.activityInfo != null
                        && activity.activityInfo.exported)
                .put("restrictedDialogSystem", activity != null && activity.activityInfo != null
                        && (activity.activityInfo.applicationInfo.flags
                        & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0)
                .put("remoteControlLoopback", reachable(InetAddress.getByName("127.0.0.1"), REMOTE_PORT))
                .put("remotePairingLoopback", reachable(InetAddress.getByName("127.0.0.1"), PAIRING_PORT));

        ConnectivityManager connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        Network active = connectivity == null ? null : connectivity.getActiveNetwork();
        NetworkCapabilities capabilities = active == null ? null : connectivity.getNetworkCapabilities(active);
        result.put("wifiTransport", capabilities != null
                && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI));
        result.put("ethernetTransport", capabilities != null
                && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));

        LinkProperties links = active == null ? null : connectivity.getLinkProperties(active);
        if (links != null) {
            for (LinkAddress link : links.getLinkAddresses()) {
                InetAddress address = link.getAddress();
                if (!(address instanceof Inet4Address) || address.isLoopbackAddress()) continue;
                result.put("remoteControlInterface", reachable(address, REMOTE_PORT));
                result.put("remotePairingInterface", reachable(address, PAIRING_PORT));
                break;
            }
        }
        return result;
    }

    private static boolean reachable(InetAddress address, int port) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(address, port), 250);
            return true;
        } catch (Exception error) {
            return false;
        }
    }
}
