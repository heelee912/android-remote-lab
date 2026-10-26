'use strict';

// Only pre-dispatch transport failures may choose another route. A returned
// command failure can already have changed the phone and must never be replayed.
function createAdbRouteSelection(now = Date.now) {
  const retryAfter = new Map();
  return async function execute(deviceId, request, direct, companion) {
    const route = request.route || 'auto';
    if (!['auto', 'direct', 'companion'].includes(route)) throw new Error('adb-invalid-route');
    if (route === 'companion' || (route === 'auto' && (retryAfter.get(deviceId) || 0) > now())) {
      return companion();
    }
    try {
      const result = await direct();
      retryAfter.delete(deviceId);
      return result;
    } catch (error) {
      if (route !== 'auto' || !['adb-transport-unavailable', 'adb-timeout',
        'adb-device-mismatch', 'adb-multiple-matching-transports'].includes(error.message)) throw error;
      retryAfter.set(deviceId, now() + 30_000);
      return companion();
    }
  };
}

module.exports = { createAdbRouteSelection };
