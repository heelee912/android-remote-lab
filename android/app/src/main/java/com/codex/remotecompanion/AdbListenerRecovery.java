package com.codex.remotecompanion;

/** Coordinates listener recovery independently of Android settings and socket APIs. */
final class AdbListenerRecovery {
    static boolean settingEnabled(int value) {
        return value > 0;
    }

    interface Device {
        int listeningPort() throws Exception;
        boolean adbEnabled();
        boolean wirelessEnabled();
        void setAdbEnabled(boolean enabled);
        void setWirelessEnabled(boolean enabled);
        long monotonicMillis();
        void await(long milliseconds) throws InterruptedException;
    }

    static int recover(Device device, boolean canRepair) throws Exception {
        int port = device.listeningPort();
        if (!canRepair) return port;
        // With both Android ADB transports disabled the framework stops adbd,
        // including its provisioned TCP listener when Wi-Fi disconnects.
        if (!device.adbEnabled()) device.setAdbEnabled(true);
        if (port > 0) return port;
        // A repeated write of 1 does not restart an already-enabled but stalled
        // wireless service. Produce a real off/on transition in that state.
        if (device.wirelessEnabled()) {
            device.setWirelessEnabled(false);
            device.await(250L);
        }
        device.setWirelessEnabled(true);
        long deadline = device.monotonicMillis() + 4500L;
        while (device.monotonicMillis() < deadline) {
            device.await(100L);
            port = device.listeningPort();
            if (port > 0) return port;
        }
        return 0;
    }

    private AdbListenerRecovery() { }
}
