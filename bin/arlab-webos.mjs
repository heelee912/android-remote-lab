import {
  captureWebOsScreenshot, inspectWebOsHost, pairWebOs, pressWebOsButton,
  turnOffWebOsScreen, withRegisteredWebOs,
} from '../src/webos-direct.mjs';
import { inspectAndRestoreArc } from '../src/webos-arc-guard.mjs';
import { configureWebOsLuna, requestWebOsLuna } from '../src/webos-luna.mjs';

function emit(result) {
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
}

function responsePayload(response) {
  if (response.type === 'error' || response.payload?.returnValue === false) {
    throw new Error([response.error, response.payload?.errorText].filter(Boolean).join(': ')
      || 'webOS request failed');
  }
  return response.payload;
}

export async function runWebOs(args) {
  const [action, ...rest] = args;
  if (action === 'luna-config' && rest.length === 4) {
    emit(configureWebOsLuna(...rest));
    return;
  }
  if (action === 'luna' && (rest.length === 1 || rest.length === 2)) {
    emit(await requestWebOsLuna(rest[0], rest[1] ? JSON.parse(rest[1]) : {}));
    return;
  }
  if (action === 'guard' && rest.length === 1 && rest[0] === 'once') {
    emit(await inspectAndRestoreArc());
    return;
  }
  if (action === 'guard' && rest.length === 1 && rest[0] === 'repair') {
    emit(await inspectAndRestoreArc({ repair: true }));
    return;
  }
  if (action === 'inspect-host' && rest.length === 1) {
    emit(await inspectWebOsHost(rest[0]));
    return;
  }
  if (action === 'pair' && rest.length === 2) {
    emit(await pairWebOs(rest[0], rest[1]));
    return;
  }
  if (action === 'status' && rest.length === 0) {
    emit(await withRegisteredWebOs(async (connection, host) => {
      const queries = [
        ['system', 'system/getSystemInfo'],
        ['power', 'com.webos.service.tvpower/power/getPowerState'],
        ['foregroundApp', 'com.webos.applicationManager/getForegroundAppInfo'],
        ['audio', 'audio/getStatus'],
        ['soundOutput', 'com.webos.service.apiadapter/audio/getSoundOutput'],
        ['inputs', 'tv/getExternalInputList'],
        ['apps', 'com.webos.applicationManager/listApps'],
      ];
      const result = { host };
      for (const [name, uri] of queries) {
        result[name] = responsePayload(await connection.request(uri));
      }
      result.inputs = result.inputs?.devices?.map((input) => ({
        id: input.id,
        label: input.label,
        connected: input.connected,
        devices: input.subList?.map((device) => ({
          id: device.id,
          name: device.osdName || device.brandName || device.labelName,
          cecType: device.cecpDevType,
          input: device.connectedInput,
        })) || [],
      })) || result.inputs;
      result.developerModeInstalled = result.apps?.apps?.some((app) =>
        /developermode|developer mode|devmode/i.test(`${app.id} ${app.title}`)) || false;
      result.installedAppCount = result.apps?.apps?.length;
      delete result.apps;
      return result;
    }));
    return;
  }
  if (action === 'press' && rest.length === 1) {
    emit(await pressWebOsButton(rest[0].toUpperCase()));
    return;
  }
  if (action === 'screenshot' && rest.length === 1) {
    emit(await captureWebOsScreenshot(rest[0]));
    return;
  }
  if (action === 'screen-off' && rest.length === 0) {
    emit(await turnOffWebOsScreen());
    return;
  }
  if (action === 'request' && (rest.length === 1 || rest.length === 2)) {
    const payload = rest[1] ? JSON.parse(rest[1]) : {};
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
      throw new Error('webos request payload must be a JSON object');
    }
    const response = await withRegisteredWebOs((connection) => connection.request(rest[0], payload));
    responsePayload(response);
    emit(response);
    return;
  }
  throw new Error('webos requires inspect-host IP, pair IP FINGERPRINT, status, press KEY, screenshot OUTPUT.jpg, screen-off, guard once|repair, request URI [JSON_PAYLOAD], luna-config USER PORT IDENTITY KNOWN_HOSTS, or luna URI [JSON_PAYLOAD]');
}
