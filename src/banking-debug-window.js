'use strict';

const bankingForegroundPackages = new Set([
  'com.nonghyup.nhallonebank',
]);

function isBankingAppForeground(status = {}) {
  return typeof status.foregroundPackage === 'string'
    && bankingForegroundPackages.has(status.foregroundPackage);
}

function bankingForegroundPackageToStop(status = {}) {
  if (status.foregroundPackage == null) return null;
  if (typeof status.foregroundPackage !== 'string'
      || !/^[A-Za-z0-9_.]{3,200}$/.test(status.foregroundPackage)) {
    throw new Error('banking-foreground-package-invalid');
  }
  return isBankingAppForeground(status) ? status.foregroundPackage : null;
}

async function executeInBankingDebugWindow(status, openWindow, execute, closeWindow) {
  if (isBankingAppForeground(status)) {
    const error = new Error('banking-app-active');
    error.code = 'banking-app-active';
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

module.exports = { bankingForegroundPackageToStop, executeInBankingDebugWindow, isBankingAppForeground };
