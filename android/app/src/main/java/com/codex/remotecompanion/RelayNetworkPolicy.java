package com.codex.remotecompanion;

final class RelayNetworkPolicy {
    private RelayNetworkPolicy() {
    }

    static boolean canConnect(boolean hasInternetCapability, boolean isValidated) {
        return hasInternetCapability && isValidated;
    }
}
