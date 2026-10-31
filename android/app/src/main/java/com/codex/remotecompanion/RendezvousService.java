package com.codex.remotecompanion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.IBinder;
import android.os.UserManager;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedWriter;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileWriter;
import java.io.FileReader;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.SSLParameters;

public final class RendezvousService extends Service {
    private static final String TAG = "RemoteCompanion";
    private static final String CHANNEL = "remote-companion-connection";
    private static final int NOTIFICATION_ID = 4101;
    private static final long MAX_CLOCK_SKEW_MILLIS = 300_000L;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static volatile String status = "Stopped";

    private final AtomicBoolean running = new AtomicBoolean();
    private Thread worker;
    private Thread accessibilityRecoveryWorker;
    private DisplayLease displayLease;
    private boolean sessionAuthenticated;

    static String currentStatus() {
        return status;
    }

    static void appendBootFailure(Context context, Throwable error) {
        appendLog(context, "boot start failure: " + error.getClass().getSimpleName());
    }

    static void appendBootEvent(Context context, String event) {
        appendLog(context, "boot event: " + event);
    }

    static void appendAccessibilityEvent(Context context, String event) {
        appendLog(context, "accessibility " + event);
    }

    static JSONObject diagnostics(Context context) throws Exception {
        ConnectivityManager connectivity = (ConnectivityManager) context.getSystemService(CONNECTIVITY_SERVICE);
        Network active = connectivity.getActiveNetwork();
        NetworkCapabilities capabilities = active == null ? null : connectivity.getNetworkCapabilities(active);
        UserManager users = (UserManager) context.getSystemService(USER_SERVICE);
        PackageInfo packageInfo = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        return new JSONObject()
                .put("versionName", packageInfo.versionName)
                .put("versionCode", packageInfo.getLongVersionCode())
                .put("androidSdk", Build.VERSION.SDK_INT)
                .put("androidRelease", Build.VERSION.RELEASE)
                .put("accessibility", AccessibilityReadiness.diagnostics(context))
                .put("accessibilityBootRecovery", AccessibilityBootRecovery.isEnabled(context))
                .put("bankingCompatibility", new BankingCompatibility(
                        context, new PrivilegedShellChannel(context)).status())
                .put("tvRecovery", TvRecoveryDiagnostics.inspect(context))
                .put("relayEndpoint", RelayPreferences.endpoint(context))
                .put("serviceStatus", status)
                .put("userUnlocked", users != null && users.isUserUnlocked())
                .put("activeNetworkPresent", active != null)
                .put("vpnTransport", capabilities != null
                        && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
                .put("internetCapability", capabilities != null
                        && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
                .put("validatedCapability", capabilities != null
                        && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
                .put("canRequestPackageInstalls", ApkInstaller.canRequestPackageInstalls(context))
                .put("lastInstall", ApkInstaller.status(context, ""))
                .put("auditTail", readAuditTail(context, 80));
    }

    static boolean hasValidatedInternet(Context context) {
        return validatedInternetNetwork(context) != null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        appendLog(this, "service onCreate");
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, notification(getString(R.string.notification_text)));
        displayLease = new DisplayLease(this);
        running.set(true);
        worker = new Thread(this::runLoop, "companion-rendezvous");
        worker.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String trigger = intent == null ? "sticky-restart" : intent.getStringExtra("trigger");
        appendLog(this, "service onStartCommand trigger=" + (trigger == null ? "unspecified" : trigger));
        startAccessibilityRecovery();
        return START_STICKY;
    }

    private synchronized void startAccessibilityRecovery() {
        if (!AccessibilityBootRecovery.isEnabled(this)
                || (accessibilityRecoveryWorker != null && accessibilityRecoveryWorker.isAlive())) return;
        accessibilityRecoveryWorker = new Thread(() -> {
            long delayMillis = 10_000L;
            while (running.get()) {
                try {
                    Thread.sleep(delayMillis);
                    delayMillis = 30_000L;
                    if (!running.get() || !AccessibilityBootRecovery.isEnabled(this)) return;
                    UserManager users = (UserManager) getSystemService(USER_SERVICE);
                    if (users == null || !users.isUserUnlocked()) continue;
                    if (AccessibilityBootRecovery.restoreIfMissing(this)) {
                        appendBootEvent(this, "accessibility restored");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                } catch (RuntimeException error) {
                    appendBootFailure(this, error);
                }
            }
        }, "companion-accessibility-recovery");
        accessibilityRecoveryWorker.start();
    }

    @Override
    public void onDestroy() {
        running.set(false);
        if (worker != null) {
            worker.interrupt();
        }
        if (accessibilityRecoveryWorker != null) {
            accessibilityRecoveryWorker.interrupt();
        }
        if (displayLease != null) {
            displayLease.release();
        }
        status = "Stopped";
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void runLoop() {
        long delayMillis = 5_000L;
        while (running.get()) {
            try {
                sessionAuthenticated = false;
                if (!RelayPreferences.configured(this)) {
                    setStatus("Configuration required");
                    sleep(5_000L);
                    continue;
                }
                // Endpoint preferences, audit state and the enrollment key are
                // available during direct boot. Background ADB can reconnect
                // independently of user-unlocked app storage and UI readiness.
                Network relayNetwork = validatedInternetNetwork(this);
                if (relayNetwork == null) {
                    setStatus("Waiting for internet connection");
                    sleep(5_000L);
                    continue;
                }
                runSession(relayNetwork);
                delayMillis = 5_000L;
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            } catch (Throwable error) {
                if (sessionAuthenticated) delayMillis = 5_000L;
                String failure = error.getClass().getSimpleName() + ": " + safeMessage(error);
                setStatus("Disconnected: " + failure);
                Log.e(TAG, "Rendezvous session failed", error);
                appendLog(this, "session error: " + error.getClass().getSimpleName() + ": " + safeMessage(error));
                displayLease.release();
                sleep(delayMillis);
                delayMillis = Math.min(60_000L, delayMillis * 2L);
            }
        }
    }

    private void runSession(Network relayNetwork) throws Exception {
        String relayHost = RelayPreferences.host(this);
        int relayPort = RelayPreferences.port(this);
        KeyPair keyPair = DeviceIdentity.getOrCreate();
        String deviceId = DeviceIdentity.deviceId(keyPair.getPublic());
        try (Socket routedSocket = connectRoutedSocket(relayNetwork, relayHost, relayPort)) {
            SSLSocketFactory tlsFactory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            try (SSLSocket socket = (SSLSocket) tlsFactory.createSocket(routedSocket, relayHost, relayPort, true)) {
            SSLParameters tlsParameters = socket.getSSLParameters();
            tlsParameters.setEndpointIdentificationAlgorithm("HTTPS");
            socket.setSSLParameters(tlsParameters);
            socket.setKeepAlive(true);
            socket.setTcpNoDelay(true);
            socket.setSoTimeout(45_000);
            socket.startHandshake();
            DataInputStream input = new DataInputStream(socket.getInputStream());
            DataOutputStream output = new DataOutputStream(socket.getOutputStream());

            JSONObject challenge = Protocol.read(input);
            if (!"challenge".equals(challenge.optString("type"))) {
                throw new IllegalStateException("Expected challenge");
            }
            String serverNonce = challenge.getString("nonce");
            long issuedAt = challenge.getLong("issuedAt");
            if (Math.abs(System.currentTimeMillis() - issuedAt) > MAX_CLOCK_SKEW_MILLIS) {
                throw new IllegalStateException("Challenge clock skew is too large");
            }
            String clientNonce = randomNonce();
            String canonical = "companion-v1\n" + deviceId + "\n" + serverNonce + "\n" + clientNonce + "\n" + issuedAt;
            JSONObject auth = new JSONObject()
                    .put("type", "auth")
                    .put("version", 1)
                    .put("deviceId", deviceId)
                    .put("clientNonce", clientNonce)
                    .put("publicKey", DeviceIdentity.publicKey(keyPair.getPublic()))
                    .put("signature", DeviceIdentity.sign(keyPair.getPrivate(), canonical));
            Protocol.write(output, auth);

            JSONObject authResult = Protocol.read(input);
            if ("enrollment_required".equals(authResult.optString("type"))) {
                setStatus("Enrollment required: " + deviceId);
                sleep(30_000L);
                return;
            }
            if (!"auth_ok".equals(authResult.optString("type"))) {
                throw new SecurityException("Device authentication was rejected");
            }

            // The relay session is the recovery path after ADB is hidden from banking apps.
            // Never close ADB during boot until this independent authenticated path exists.
            if (new BankingCompatibility(this, new PrivilegedShellChannel(this)).enforceAtStartup()) {
                appendBootEvent(this, "banking compatibility enforced after relay authentication");
            }

            setStatus("Connected: " + deviceId);
            sessionAuthenticated = true;
            appendLog(this, "authenticated session connected for " + deviceId);
            long lastSequence = 0L;
            try (AdbTunnel adbTunnel = new AdbTunnel(this, message -> appendLog(this, message));
                 TvRemoteControl tvRemoteControl = new TvRemoteControl(this)) {
            CommandDispatcher dispatcher = new CommandDispatcher(this, displayLease, tvRemoteControl);
            while (running.get()) {
                Network currentNetwork = validatedInternetNetwork(this);
                if (currentNetwork == null || !currentNetwork.equals(relayNetwork)) {
                    throw new IOException("Internet network changed or disconnected");
                }
                JSONObject frame = Protocol.read(input);
                String type = frame.optString("type");
                if ("ping".equals(type)) {
                    KeyguardManager keyguard = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
                    Protocol.write(output, new JSONObject()
                            .put("type", "pong")
                            .put("sentAt", frame.optLong("sentAt"))
                            .put("keyguardLocked", DeviceReadiness.keyguardShowing(this))
                            .put("secureKeyguardLocked", DeviceReadiness.secureLocked(this))
                            .put("supportsAtomicGuards", true)
                            .put("screenInteractive", DeviceReadiness.interactive(this))
                            .put("userUnlocked", ((UserManager) getSystemService(USER_SERVICE)).isUserUnlocked())
                            .put("accessibilityReady", ControlAccessibilityService.getInstance() != null)
                            .put("versionCode", BuildConfig.VERSION_CODE)
                            .put("versionName", BuildConfig.VERSION_NAME));
                    continue;
                }
                if (!"command".equals(type)) {
                    continue;
                }
                long sequence = frame.getLong("seq");
                String requestId = frame.getString("requestId");
                if (sequence <= lastSequence) {
                    Protocol.write(output, responseError(requestId, sequence, "REPLAY_REJECTED", "Sequence was not monotonic"));
                    continue;
                }
                lastSequence = sequence;
                String command = frame.getString("command");
                JSONObject args = frame.optJSONObject("args");
                if (args == null) args = new JSONObject();
                try {
                    JSONObject result = command.startsWith("adb_tunnel_")
                            ? adbTunnel.dispatch(command, args) : dispatcher.dispatch(command, args);
                    Protocol.write(output, new JSONObject()
                            .put("type", "response")
                            .put("requestId", requestId)
                            .put("seq", sequence)
                            .put("ok", true)
                            .put("result", result));
                    if (!command.startsWith("adb_tunnel_")) appendLog(this, "command ok: " + command + " request=" + requestId);
                } catch (Throwable error) {
                    Protocol.write(output, responseError(
                            requestId,
                            sequence,
                            error.getClass().getSimpleName(),
                            safeMessage(error)));
                    appendLog(this, "command failed: " + command + " request=" + requestId
                            + " error=" + error.getClass().getSimpleName());
                }
            }
            }
            }
        } finally {
            displayLease.release();
            setStatus("Disconnected");
        }
    }

    private Socket connectRoutedSocket(Network relayNetwork, String relayHost, int relayPort) throws Exception {
        InetAddress[] addresses;
        try {
            addresses = relayNetwork.getAllByName(relayHost);
        } catch (java.net.UnknownHostException dnsFailure) {
            // Some VPN DNS resolvers fail even while Android reports a validated network.
            // Resolve over HTTPS by numeric IP, then retain relayHost for TLS identity checks.
            addresses = resolveThroughEncryptedDns(relayNetwork, relayHost, dnsFailure);
        }
        Throwable lastFailure = null;
        for (int familyPass = 0; familyPass < 2; familyPass++) {
            for (InetAddress address : addresses) {
                boolean isIpv4 = address instanceof Inet4Address;
                if ((familyPass == 0) != isIpv4) continue;
                Socket socket = relayNetwork.getSocketFactory().createSocket();
                try {
                    socket.connect(new InetSocketAddress(address, relayPort), 15_000);
                    return socket;
                } catch (Throwable error) {
                    lastFailure = error;
                    try {
                        socket.close();
                    } catch (Throwable ignored) {
                    }
                }
            }
        }
        if (lastFailure instanceof Exception) throw (Exception) lastFailure;
        throw new IllegalStateException("No relay address was reachable", lastFailure);
    }

    private static InetAddress[] resolveThroughEncryptedDns(Network network, String host,
            Exception dnsFailure) throws IOException {
        String query = "?name=" + URLEncoder.encode(host, StandardCharsets.UTF_8.name()) + "&type=A";
        String[] endpoints = {
                "https://1.1.1.1/dns-query" + query,
                "https://8.8.8.8/resolve" + query
        };
        IOException lastFailure = new IOException("System DNS could not resolve relay host", dnsFailure);
        for (String endpoint : endpoints) {
            HttpsURLConnection connection = null;
            try {
                connection = (HttpsURLConnection) network.openConnection(new URL(endpoint));
                connection.setConnectTimeout(5_000);
                connection.setReadTimeout(5_000);
                connection.setRequestProperty("Accept", "application/dns-json");
                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                    throw new IOException("Encrypted DNS returned HTTP " + connection.getResponseCode());
                }
                StringBuilder response = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                    char[] buffer = new char[2048];
                    int length;
                    while ((length = reader.read(buffer)) != -1) {
                        response.append(buffer, 0, length);
                        if (response.length() > 16_384) throw new IOException("Encrypted DNS response too large");
                    }
                }
                JSONObject result = new JSONObject(response.toString());
                if (result.optInt("Status", -1) != 0) {
                    throw new IOException("Encrypted DNS did not resolve relay host");
                }
                JSONArray answers = result.optJSONArray("Answer");
                ArrayList<InetAddress> addresses = new ArrayList<>();
                if (answers != null) {
                    for (int index = 0; index < answers.length(); index++) {
                        JSONObject answer = answers.optJSONObject(index);
                        if (answer == null || answer.optInt("type") != 1) continue;
                        String address = answer.optString("data");
                        if (!address.matches("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}")) continue;
                        InetAddress parsed = InetAddress.getByName(address);
                        if (parsed instanceof Inet4Address) addresses.add(parsed);
                    }
                }
                if (!addresses.isEmpty()) return addresses.toArray(new InetAddress[0]);
                throw new IOException("Encrypted DNS returned no IPv4 address");
            } catch (Exception error) {
                lastFailure = new IOException("Encrypted DNS fallback failed", error);
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
        throw lastFailure;
    }

    private static Network validatedInternetNetwork(Context context) {
        ConnectivityManager connectivity = (ConnectivityManager) context.getSystemService(CONNECTIVITY_SERVICE);
        Network active = connectivity.getActiveNetwork();
        if (active == null) return null;
        NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(active);
        boolean ready = capabilities != null && RelayNetworkPolicy.canConnect(
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
        return ready ? active : null;
    }

    private JSONObject responseError(String requestId, long sequence, String code, String message)
            throws Exception {
        return new JSONObject()
                .put("type", "response")
                .put("requestId", requestId)
                .put("seq", sequence)
                .put("ok", false)
                .put("error", new JSONObject().put("code", code).put("message", message));
    }

    private void createNotificationChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(
                CHANNEL,
                getString(R.string.notification_channel),
                NotificationManager.IMPORTANCE_LOW);
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification notification(String text) {
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                .setContentTitle(getString(R.string.notification_title))
                .setContentText(text)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setDefaults(0)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pendingIntent)
                .build();
    }

    private void setStatus(String value) {
        status = value;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.notify(NOTIFICATION_ID, notification(value));
    }

    private static String randomNonce() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.encodeToString(bytes, Base64.NO_WRAP | Base64.URL_SAFE);
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.isBlank()) return error.getClass().getSimpleName();
        return message.length() > 240 ? message.substring(0, 240) : message;
    }

    private static synchronized void appendLog(Context context, String message) {
        try {
            Context storage = context.createDeviceProtectedStorageContext();
            File directory = new File(storage.getFilesDir(), "audit");
            if (!directory.exists() && !directory.mkdirs()) return;
            File file = new File(directory, "companion.log");
            if (file.length() > 512 * 1024L) {
                File previous = new File(directory, "companion.log.1");
                if (previous.exists()) previous.delete();
                file.renameTo(previous);
            }
            try (BufferedWriter writer = new BufferedWriter(new FileWriter(file, true))) {
                writer.write(Instant.now() + " " + message);
                writer.newLine();
            }
        } catch (Throwable ignored) {
        }
    }

    private static JSONArray readAuditTail(Context context, int maximumLines) {
        JSONArray result = new JSONArray();
        try {
            Context storage = context.createDeviceProtectedStorageContext();
            File file = new File(new File(storage.getFilesDir(), "audit"), "companion.log");
            if (!file.isFile()) return result;
            java.util.ArrayDeque<String> lines = new java.util.ArrayDeque<>();
            try (BufferedReader reader = new BufferedReader(new FileReader(file))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (lines.size() == maximumLines) lines.removeFirst();
                    lines.addLast(line);
                }
            }
            for (String line : lines) result.put(line);
        } catch (Throwable error) {
            result.put("audit read failed: " + error.getClass().getSimpleName());
        }
        return result;
    }
}
