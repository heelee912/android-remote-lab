package com.codex.remotecompanion;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.ColorSpace;
import android.hardware.HardwareBuffer;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class ControlAccessibilityService extends AccessibilityService {
    private static final int MAX_TREE_NODES = 800;
    private static volatile ControlAccessibilityService instance;

    static ControlAccessibilityService getInstance() {
        return instance;
    }

    @Override
    protected void onServiceConnected() {
        instance = this;
        RendezvousService.appendAccessibilityEvent(this, "connected");
    }

    @Override
    public void onDestroy() {
        RendezvousService.appendAccessibilityEvent(this, "destroyed");
        if (instance == this) {
            instance = null;
        }
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
    }

    @Override
    public void onInterrupt() {
    }

    JSONObject status() throws Exception {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        JSONObject value = new JSONObject();
        value.put("connected", true);
        value.put("hasRoot", root != null);
        if (root != null) {
            value.put("packageName", text(root.getPackageName()));
            value.put("className", text(root.getClassName()));
        }
        return value;
    }

    JSONObject snapshot() throws Exception {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) {
            throw new IllegalStateException("No accessibility root is available");
        }
        JSONArray nodes = new JSONArray();
        ArrayDeque<NodeEntry> queue = new ArrayDeque<>();
        queue.add(new NodeEntry(root, -1, 0));
        int nextId = 0;
        while (!queue.isEmpty() && nodes.length() < MAX_TREE_NODES) {
            NodeEntry entry = queue.removeFirst();
            AccessibilityNodeInfo node = entry.node;
            int id = nextId++;
            JSONObject item = describeNode(node, id, entry.parentId, entry.depth);
            nodes.put(item);
            int childCount = node.getChildCount();
            for (int index = 0; index < childCount; index++) {
                AccessibilityNodeInfo child = node.getChild(index);
                if (child != null) {
                    queue.addLast(new NodeEntry(child, id, entry.depth + 1));
                }
            }
        }
        JSONObject result = new JSONObject();
        result.put("nodes", nodes);
        result.put("truncated", !queue.isEmpty());
        return result;
    }

    boolean performGlobal(String action, String expectedPackage) {
        String normalizedAction = action.toLowerCase(Locale.ROOT);
        if (normalizedAction.startsWith("dpad_")) {
            if (android.os.Build.VERSION.SDK_INT < 33) return false;
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (expectedPackage == null || expectedPackage.isBlank() || root == null
                    || !expectedPackage.equals(text(root.getPackageName()))) {
                throw new IllegalStateException("Keyboard input foreground package changed");
            }
        }
        int globalAction;
        switch (normalizedAction) {
            case "back": globalAction = GLOBAL_ACTION_BACK; break;
            case "home": globalAction = GLOBAL_ACTION_HOME; break;
            case "recents": globalAction = GLOBAL_ACTION_RECENTS; break;
            case "notifications": globalAction = GLOBAL_ACTION_NOTIFICATIONS; break;
            case "quick_settings": globalAction = GLOBAL_ACTION_QUICK_SETTINGS; break;
            case "lock_screen": globalAction = GLOBAL_ACTION_LOCK_SCREEN; break;
            case "dpad_up": globalAction = GLOBAL_ACTION_DPAD_UP; break;
            case "dpad_down": globalAction = GLOBAL_ACTION_DPAD_DOWN; break;
            case "dpad_left": globalAction = GLOBAL_ACTION_DPAD_LEFT; break;
            case "dpad_right": globalAction = GLOBAL_ACTION_DPAD_RIGHT; break;
            case "dpad_center": globalAction = GLOBAL_ACTION_DPAD_CENTER; break;
            default: return false;
        }
        return performGlobalAction(globalAction);
    }

    boolean tap(float x, float y, long timeoutMillis) throws InterruptedException {
        Path path = new Path();
        path.moveTo(x, y);
        return dispatch(path, 1L, Math.min(timeoutMillis, 1000L));
    }

    boolean swipe(float startX, float startY, float endX, float endY, long durationMillis)
            throws InterruptedException {
        Path path = new Path();
        path.moveTo(startX, startY);
        path.lineTo(endX, endY);
        return dispatch(path, Math.max(50L, Math.min(durationMillis, 2000L)), 4000L);
    }

    boolean click(JSONObject selector) throws InterruptedException {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (selector.has("guard") && !guardMatches(root, selector.optJSONObject("guard"))) throw new IllegalStateException("Atomic UI guard changed");
        AccessibilityNodeInfo node = findNode(root, selector);
        if (node == null || node.isPassword()) {
            return false;
        }
        AccessibilityNodeInfo current = node;
        for (int depth = 0; depth < 5 && current != null; depth++) {
            if (current.isClickable()) {
                if (current.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
                // A clickable target rejecting its action is not permission to
                // activate a broader ancestor with a different UI purpose.
                break;
            }
            current = current.getParent();
        }
        // Some official app buttons reject ACTION_CLICK but accept Android
        // gestures. Recheck the same live window and guard before one gesture;
        // never ask the client to resend a financial action after uncertainty.
        AccessibilityNodeInfo freshRoot = getRootInActiveWindow();
        if (selector.has("guard") && !guardMatches(freshRoot, selector.optJSONObject("guard"))) {
            throw new IllegalStateException("Atomic UI guard changed");
        }
        AccessibilityNodeInfo fresh = findNode(freshRoot, selector);
        if (fresh == null || fresh.isPassword() || !fresh.isEnabled() || !fresh.isVisibleToUser()) return false;
        Rect before = new Rect();
        Rect after = new Rect();
        node.getBoundsInScreen(before);
        fresh.getBoundsInScreen(after);
        if (!before.equals(after) || after.isEmpty()
                || !text(node.getText()).equals(text(fresh.getText()))
                || !text(node.getContentDescription()).equals(text(fresh.getContentDescription()))
                || !text(node.getClassName()).equals(text(fresh.getClassName()))
                || !text(node.getPackageName()).equals(text(fresh.getPackageName()))) return false;
        return tap(after.centerX(), after.centerY(), 1000L);
    }

    boolean setText(JSONObject selector, String value) {
        AccessibilityNodeInfo node = findNode(selector);
        if (node == null || node.isPassword() || !node.isEditable()) {
            return false;
        }
        Bundle arguments = new Bundle();
        arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
    }

    String screenshotPngBase64() throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> image = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
            @Override
            public void onSuccess(ScreenshotResult screenshot) {
                HardwareBuffer buffer = screenshot.getHardwareBuffer();
                try {
                    ColorSpace colorSpace = screenshot.getColorSpace();
                    Bitmap hardware = Bitmap.wrapHardwareBuffer(buffer, colorSpace);
                    if (hardware == null) {
                        throw new IllegalStateException("Unable to map screenshot buffer");
                    }
                    Bitmap software = hardware.copy(Bitmap.Config.ARGB_8888, false);
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    software.compress(Bitmap.CompressFormat.PNG, 100, output);
                    software.recycle();
                    image.set(Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
                } catch (Throwable error) {
                    failure.set(error);
                } finally {
                    buffer.close();
                    done.countDown();
                }
            }

            @Override
            public void onFailure(int errorCode) {
                failure.set(new IllegalStateException("Screenshot failed: " + errorCode));
                done.countDown();
            }
        });
        if (!done.await(15, TimeUnit.SECONDS)) {
            throw new IllegalStateException("Screenshot timed out");
        }
        if (failure.get() != null) {
            throw new IllegalStateException(failure.get());
        }
        return image.get();
    }

    private boolean dispatch(Path path, long durationMillis, long timeoutMillis)
            throws InterruptedException {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Boolean> completed = new AtomicReference<>(false);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0L, durationMillis))
                .build();
        boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription gestureDescription) {
                completed.set(true);
                done.countDown();
            }

            @Override
            public void onCancelled(GestureDescription gestureDescription) {
                done.countDown();
            }
        }, null);
        return accepted && done.await(timeoutMillis, TimeUnit.MILLISECONDS) && completed.get();
    }

    private boolean guardMatches(AccessibilityNodeInfo root, JSONObject guard) {
        try {
            if (root == null || guard == null || !guard.getString("expectedPackage").equals(text(root.getPackageName()))) return false;
            AccessibilityNodeInfo scope = findNode(root, guard.getJSONObject("root"));
            if (scope == null) return false;
            org.json.JSONArray checks = guard.getJSONArray("nodes");
            if (checks.length() == 0) return false;
            for (int i = 0; i < checks.length(); i++) if (findNode(scope, checks.getJSONObject(i)) == null) return false;
            return true;
        } catch (Exception error) { return false; }
    }

    private AccessibilityNodeInfo findNode(JSONObject selector) { return findNode(getRootInActiveWindow(), selector); }

    private AccessibilityNodeInfo findNode(AccessibilityNodeInfo root, JSONObject selector) {
        if (root == null) return null;
        String expected = selector.optString("expectedPackage", "");
        if (!expected.isEmpty() && !expected.equals(text(root.getPackageName()))) return null;
        String viewId = selector.optString("viewId", "");
        String wantedText = selector.optString("text", "");
        String description = selector.optString("contentDescription", "");
        String wantedClass = selector.optString("className", "");
        String wantedPackage = selector.optString("packageName", "");
        if (viewId.isEmpty() && wantedText.isEmpty() && description.isEmpty() && !(selector.optBoolean("editable", false) && !wantedClass.isEmpty())) return null;
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        int visited = 0;
        AccessibilityNodeInfo match = null;
        while (!queue.isEmpty() && visited++ < MAX_TREE_NODES) {
            AccessibilityNodeInfo node = queue.removeFirst();
            boolean matches = node.isEnabled() && node.isVisibleToUser() && !node.isPassword()
                    && (!selector.has("editable") || selector.optBoolean("editable") == node.isEditable())
                    && (viewId.isEmpty() || viewId.equals(node.getViewIdResourceName()))
                    && (wantedText.isEmpty() || wantedText.equals(text(node.getText())))
                    && (description.isEmpty() || description.equals(text(node.getContentDescription())))
                    && (wantedClass.isEmpty() || wantedClass.equals(text(node.getClassName())))
                    && (wantedPackage.isEmpty() || wantedPackage.equals(text(node.getPackageName())));
            if (matches) {
                if (match != null) return null;
                match = node;
            }
            int childCount = node.getChildCount();
            for (int index = 0; index < childCount; index++) {
                AccessibilityNodeInfo child = node.getChild(index);
                if (child != null) queue.addLast(child);
            }
        }
        return queue.isEmpty() ? match : null;
    }

    private static JSONObject describeNode(AccessibilityNodeInfo node, int id, int parentId, int depth)
            throws Exception {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        JSONObject item = new JSONObject();
        item.put("id", id);
        item.put("parentId", parentId);
        item.put("depth", depth);
        item.put("packageName", text(node.getPackageName()));
        item.put("className", text(node.getClassName()));
        item.put("viewId", node.getViewIdResourceName());
        // Some payment WebViews mark PIN/expiry/birthday fields as ordinary
        // EditTexts. Do not send their entered values to relay caches or tools.
        String inputId = text(node.getViewIdResourceName()).toLowerCase(Locale.ROOT);
        boolean paymentPrivate = node.isEditable() && (inputId.contains("cardpassword")
                || inputId.contains("cvv") || inputId.contains("cvc")
                || (inputId.startsWith("pay_test_") && (inputId.contains("birthday") || inputId.contains("validity"))));
        boolean redacted = node.isPassword() || paymentPrivate;
        item.put("text", redacted ? JSONObject.NULL : text(node.getText()));
        item.put("contentDescription", redacted ? JSONObject.NULL : text(node.getContentDescription()));
        item.put("redacted", redacted);
        if (paymentPrivate) item.put("hasValue", !text(node.getText()).trim().isEmpty());
        item.put("left", bounds.left);
        item.put("top", bounds.top);
        item.put("right", bounds.right);
        item.put("bottom", bounds.bottom);
        item.put("clickable", node.isClickable());
        item.put("editable", node.isEditable() && !node.isPassword());
        item.put("enabled", node.isEnabled());
        item.put("checked", node.isChecked());
        item.put("password", node.isPassword());
        return item;
    }

    private static String text(CharSequence value) {
        return value == null ? "" : value.toString();
    }

    private static final class NodeEntry {
        final AccessibilityNodeInfo node;
        final int parentId;
        final int depth;

        NodeEntry(AccessibilityNodeInfo node, int parentId, int depth) {
            this.node = node;
            this.parentId = parentId;
            this.depth = depth;
        }
    }
}
