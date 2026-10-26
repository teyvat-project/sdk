import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertStableAvailable, latestBetaTag, nextBeta, normalizeVersion, specVersion } from './next-version.mjs';

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

test('specVersion normalizes info.version', () => {
  assert.equal(specVersion(JSON.stringify({ info: { version: '2026.01.05' } })), '2026.1.5');
  assert.throws(() => specVersion(JSON.stringify({ info: {} })), /missing info\.version/);
  assert.throws(() => specVersion(JSON.stringify({ info: { version: '2026.10' } })), /invalid version/);
});

test('spec-version CLI prints the normalized info.version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-version-test-'));
  try {
    writeFileSync(join(dir, 'openapi.json'), JSON.stringify({ openapi: '3.1.0', info: { version: '2026.01.05' } }));
    const cli = fileURLToPath(new URL('./next-version.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [cli, 'spec-version', '--spec', 'openapi.json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '2026.1.5\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nextBeta starts at 1', () => {
  assert.equal(nextBeta('2026.10.25', []), '2026.10.25-beta.1');
});

test('nextBeta shares N across languages and ignores other bases', () => {
  const tags = ['nodejs/v2026.10.25-beta.1', 'swift/v2026.10.25-beta.2', 'nodejs/v2026.10.24-beta.9', 'nodejs/v2026.10.24'];
  assert.equal(nextBeta('2026.10.25', tags), '2026.10.25-beta.3');
});

test('nextBeta throws when any language has a stable tag for the base', () => {
  for (const stable of ['nodejs/v2026.10.25', 'swift/v2026.10.25', 'dotnet/v2026.10.25', 'kotlin/v2026.10.25']) {
    assert.throws(
      () => nextBeta('2026.10.25', ['nodejs/v2026.10.25-beta.1', stable]),
      /stable 2026\.10\.25 already released .*the API must bump info\.version/,
      stable,
    );
  }
});

test('nextBeta ignores stable tags of other bases and non-language prefixes', () => {
  assert.equal(nextBeta('2026.10.25', ['nodejs/v2026.10.2', 'nodejs/v2026.10.250', 'other/v2026.10.25']), '2026.10.25-beta.1');
});

test('beta CLI fails when a stable tag exists for the spec version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'next-version-test-'));
  try {
    // The fixture repo ignores the user's git config.
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    };
    const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    git('init', '-q');
    const commit = git('commit-tree', '--no-gpg-sign', '-m', 'init', git('write-tree').trim()).trim();
    git('tag', 'dotnet/v2026.1.5', commit);
    writeFileSync(join(dir, 'openapi.json'), JSON.stringify({ openapi: '3.1.0', info: { version: '2026.01.05' } }));
    const cli = fileURLToPath(new URL('./next-version.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [cli, 'beta', '--spec', 'openapi.json'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /stable 2026\.1\.5 already released \(dotnet\/v2026\.1\.5\); the API must bump info\.version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
