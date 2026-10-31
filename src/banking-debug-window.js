'use strict';

const safeForegroundPackages = new Set([
  'com.android.launcher3',
  'com.android.settings',
  'com.android.systemui',
  'com.codex.remotecompanion',
  'com.google.android.apps.nexuslauncher',
  'com.samsung.android.app.launcher',
  'com.sec.android.app.launcher',
]);

function isSafeBankingDebugForeground(status = {}) {
  return typeof status.foregroundPackage === 'string'
    && safeForegroundPackages.has(status.foregroundPackage);
}

async function executeInBankingDebugWindow(status, openWindow, execute, closeWindow) {
  if (!isSafeBankingDebugForeground(status)) {
    const error = new Error('banking-app-or-user-app-active');
    error.code = 'banking-app-or-user-app-active';
    throw error;
  }
  const opened = await openWindow();
  if (!opened?.ok || !opened.result?.bootstrapOpened) {
    throw new Error(opened?.error?.message || opened?.error || 'banking-debug-window-open-failed');
  }
  let execution;
  let executionError;
  try {
    execution = await execute();
  } catch (error) {
    executionError = error;
  }
  const closed = await closeWindow();
  if (!closed?.ok || !closed.result?.bootstrapClosed) {
    const error = new Error(closed?.error?.message || closed?.error || 'banking-debug-window-close-failed');
    error.cause = executionError;
    throw error;
  }
  if (executionError) throw executionError;
  if (execution?.result) execution.result.bankingDebugWindow = true;
  return execution;
}

module.exports = { executeInBankingDebugWindow, isSafeBankingDebugForeground };
