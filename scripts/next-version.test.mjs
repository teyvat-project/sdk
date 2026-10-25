import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertStableAvailable, latestBetaTag, nextBeta, normalizeVersion } from './next-version.mjs';

test('normalizeVersion strips leading zeros', () => {
  assert.equal(normalizeVersion('2026.10.25'), '2026.10.25');
  assert.equal(normalizeVersion('2026.01.05'), '2026.1.5');
  assert.equal(normalizeVersion('2026.0.0'), '2026.0.0');
});

test('normalizeVersion rejects malformed versions', () => {
  for (const v of ['2026.10', '2026.10.25.1', 'v2026.10.25', '2026.10.x']) {
    assert.throws(() => normalizeVersion(v), undefined, v);
  }
});

test('nextBeta starts at 1', () => {
  assert.equal(nextBeta('2026.10.25', []), '2026.10.25-beta.1');
});

test('nextBeta shares N across languages and ignores other bases / stable tags', () => {
  const tags = ['nodejs/v2026.10.25-beta.1', 'swift/v2026.10.25-beta.2', 'nodejs/v2026.10.24-beta.9', 'nodejs/v2026.10.25'];
  assert.equal(nextBeta('2026.10.25', tags), '2026.10.25-beta.3');
});

test('nextBeta compares N numerically', () => {
  assert.equal(nextBeta('2026.10.25', ['nodejs/v2026.10.25-beta.10', 'nodejs/v2026.10.25-beta.9']), '2026.10.25-beta.11');
});

test('assertStableAvailable throws when a stable tag exists', () => {
  assert.throws(() => assertStableAvailable('2026.10.25', ['dotnet/v2026.10.25']));
});

test('assertStableAvailable allows beta-only tags', () => {
  assert.doesNotThrow(() => assertStableAvailable('2026.10.25', ['dotnet/v2026.10.25-beta.1']));
});

test('latestBetaTag picks the nodejs tag with the largest N', () => {
  const tags = ['nodejs/v2026.10.25-beta.2', 'nodejs/v2026.10.25-beta.10', 'swift/v2026.10.25-beta.11'];
  assert.equal(latestBetaTag('2026.10.25', tags), 'nodejs/v2026.10.25-beta.10');
});

test('latestBetaTag returns undefined when none', () => {
  assert.equal(latestBetaTag('2026.10.25', []), undefined);
});
