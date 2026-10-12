import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('launch can resolve launcher activities without fixed target packages', () => {
  const manifest = readFileSync(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  const queries = manifest.match(/<queries\b[^>]*>([\s\S]*?)<\/queries>/)?.[1] ?? '';
  const intents = [...queries.matchAll(/<intent\b[^>]*>([\s\S]*?)<\/intent>/g)];
  assert.ok(intents.some(([, intent]) =>
    /<action\b[^>]*android:name="android\.intent\.action\.MAIN"/.test(intent)
    && /<category\b[^>]*android:name="android\.intent\.category\.LAUNCHER"/.test(intent)),
  'PackageManager launcher lookup requires a MAIN/LAUNCHER visibility query');
});
