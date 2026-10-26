import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { checkPatch, isAllowedPath, parseRawZ, renameCopyPaths, unquoteC } from './check-patch-paths.mjs';

const root = mkdtempSync(join(tmpdir(), 'check-patch-paths-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

// Fixture repos ignore the user's git config.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

let counter = 0;

/** A repo with a spec, a generated file, a handwritten file and a script. */
function fixture() {
  const dir = join(root, `repo-${counter++}`);
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' });
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  git('init', '-q');
  write('openapi/openapi.json', '{}\n');
  write('packages/nodejs/src/generated/client.ts', 'export {};\n');
  write('packages/nodejs/src/catalyst.ts', 'export {};\n');
  write('packages/swift/Generated/Sources/A.swift', '// a\n');
  write('scripts/next-version.mjs', '// v\n');
  git('add', '.');
  const tree = git('write-tree').trim();
  const commit = git('commit-tree', '--no-gpg-sign', '-m', 'init', tree).trim();
  git('update-ref', 'HEAD', commit);
  git('reset', '-q', '--hard');

  return {
    dir,
    git,
    write,
    /** Stage everything, write the staged diff as a patch, then restore HEAD. */
    patch() {
      git('add', '-A');
      const file = join(root, `p-${counter++}.patch`);
      writeFileSync(file, git('diff', '--cached', '--binary', '-M'));
      git('reset', '-q', '--hard');
      git('clean', '-q', '-fd');
      return file;
    },
    raw(text) {
      const file = join(root, `p-${counter++}.patch`);
      writeFileSync(file, text);
      return file;
    },
  };
}

function assertRejected(problems, pattern) {
  assert.ok(problems.length > 0, 'expected the patch to be rejected');
  if (pattern) assert.ok(problems.some((p) => pattern.test(p)), problems.join('\n'));
}

test('isAllowedPath', () => {
  for (const p of [
    'openapi/openapi.json',
    'packages/nodejs/src/generated/client.ts',
    'packages/swift/Generated/Sources/CatalystAPI/Api.swift',
    'packages/dotnet/CatalystSharp/Generated/Api.cs',
    'packages/kotlin/src/generated/kotlin/src/main/kotlin/Api.kt',
  ]) {
    assert.equal(isAllowedPath(p), true, p);
  }
  for (const p of [
    'openapi/other.json',
    'openapi/openapi.json/x',
    'packages/nodejs/src/catalyst.ts',
    'packages/nodejs/src/generated',
    'packages/nodejs/src/generated/',
    'packages/nodejs/src/generatedx/a.ts',
    'packages/nodejs/src/generated/../../x',
    'packages/nodejs/src/generated/./a.ts',
    'packages/nodejs/src/generated//a.ts',
    '/packages/nodejs/src/generated/a.ts',
    '.github/actions/setup-pnpm/action.yml',
    'scripts/next-version.mjs',
    '',
  ]) {
    assert.equal(isAllowedPath(p), false, p);
  }
});

test('unquoteC decodes git C-style quoting', () => {
  assert.equal(unquoteC('plain/path with space'), 'plain/path with space');
  assert.equal(unquoteC('"a/caf\\303\\251 x"'), 'a/café x');
  assert.equal(unquoteC('"a\\tb\\"c\\\\d"'), 'a\tb"c\\d');
});

test('parseRawZ reads modes and paths', () => {
  const out = ':100644 100644 aaaa bbbb M\0a b\0:000000 120000 0000 cccc A\0x\0';
  assert.deepEqual(parseRawZ(out), [
    { srcMode: '100644', dstMode: '100644', status: 'M', path: 'a b' },
    { srcMode: '000000', dstMode: '120000', status: 'A', path: 'x' },
  ]);
});

test('renameCopyPaths unquotes header paths', () => {
  const patch = 'diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to "y\\303\\251 z"\n';
  assert.deepEqual(renameCopyPaths(patch), ['x', 'yé z']);
});

test('allows changes to the spec and generated files', () => {
  const f = fixture();
  f.write('openapi/openapi.json', '{"a":1}\n');
  f.write('packages/nodejs/src/generated/client.ts', 'export const a = 1;\n');
  f.write('packages/nodejs/src/generated/new.ts', 'export {};\n');
  unlinkSync(join(f.dir, 'packages/swift/Generated/Sources/A.swift'));
  assert.deepEqual(checkPatch(f.patch(), { cwd: f.dir }), []);
});

test('allows renames inside generated directories', () => {
  const f = fixture();
  mkdirSync(join(f.dir, 'packages/nodejs/src/generated/sub'));
  renameSync(join(f.dir, 'packages/nodejs/src/generated/client.ts'), join(f.dir, 'packages/nodejs/src/generated/sub/client.ts'));
  assert.deepEqual(checkPatch(f.patch(), { cwd: f.dir }), []);
});

test('rejects a handwritten file', () => {
  const f = fixture();
  f.write('packages/nodejs/src/generated/client.ts', 'export const a = 1;\n');
  f.write('packages/nodejs/src/catalyst.ts', 'export const evil = 1;\n');
  assertRejected(checkPatch(f.patch(), { cwd: f.dir }), /disallowed path: packages\/nodejs\/src\/catalyst\.ts/);
});

test('rejects a new file outside the allowed paths', () => {
  const f = fixture();
  f.write('.github/actions/evil/action.yml', 'x\n');
  assertRejected(checkPatch(f.patch(), { cwd: f.dir }), /\.github\/actions\/evil/);
});

test('rejects a rename from a generated directory to outside', () => {
  const f = fixture();
  renameSync(join(f.dir, 'packages/nodejs/src/generated/client.ts'), join(f.dir, 'packages/nodejs/src/client.ts'));
  assertRejected(checkPatch(f.patch(), { cwd: f.dir }), /packages\/nodejs\/src\/client\.ts/);
});

test('rejects a rename from outside into a generated directory', () => {
  const f = fixture();
  renameSync(join(f.dir, 'scripts/next-version.mjs'), join(f.dir, 'packages/nodejs/src/generated/next-version.mjs'));
  assertRejected(checkPatch(f.patch(), { cwd: f.dir }), /scripts\/next-version\.mjs/);
});

test('rejects a copy from outside into a generated directory', () => {
  const f = fixture();
  const patch = f.raw(
    [
      'diff --git a/packages/nodejs/src/catalyst.ts b/packages/nodejs/src/generated/copy.ts',
      'similarity index 100%',
      'copy from packages/nodejs/src/catalyst.ts',
      'copy to packages/nodejs/src/generated/copy.ts',
      '',
    ].join('\n'),
  );
  assertRejected(checkPatch(patch, { cwd: f.dir }), /rename\/copy path: packages\/nodejs\/src\/catalyst\.ts/);
});

test('rejects a deletion outside the allowed paths', () => {
  const f = fixture();
  unlinkSync(join(f.dir, 'scripts/next-version.mjs'));
  assertRejected(checkPatch(f.patch(), { cwd: f.dir }), /disallowed path: scripts\/next-version\.mjs/);
});

test('rejects a mode change outside the allowed paths', () => {
  const f = fixture();
  chmodSync(join(f.dir, 'scripts/next-version.mjs'), 0o755);
  assertRejected(checkPatch(f.patch(), { cwd: f.dir }), /scripts\/next-version\.mjs/);
});

test('rejects a symlink inside a generated directory', () => {
  const f = fixture();
  symlinkSync('../../../../scripts/next-version.mjs', join(f.dir, 'packages/nodejs/src/generated/link.mjs'));
  assertRejected(checkPatch(f.patch(), { cwd: f.dir }), /mode 120000/);
});

test('handles quoted paths with spaces and non-ASCII characters', () => {
  const allowed = fixture();
  allowed.write('packages/nodejs/src/generated/café x "q".ts', 'export {};\n');
  const allowedPatch = allowed.patch();
  assert.match(readFileSync(allowedPatch, 'utf8'), /"b\/packages\/nodejs\/src\/generated\/caf\\303\\251 x \\"q\\".ts"/);
  assert.deepEqual(checkPatch(allowedPatch, { cwd: allowed.dir }), []);

  const rejected = fixture();
  rejected.write('packages/nodejs/src/café x.ts', 'export {};\n');
  assertRejected(checkPatch(rejected.patch(), { cwd: rejected.dir }), /disallowed path: packages\/nodejs\/src\/café x\.ts/);
});

test('rejects an unquoted path whose spaces mimic an allowed header', () => {
  const f = fixture();
  f.write('packages/nodejs/src/generated/x b/scripts/y.ts', 'export {};\n');
  f.write('scripts/z b/packages/nodejs/src/generated/x.ts', 'export {};\n');
  assertRejected(checkPatch(f.patch(), { cwd: f.dir }), /disallowed path: scripts\/z b\/packages/);
});

test('rejects .. traversal out of a generated directory', () => {
  const f = fixture();
  const patch = f.raw(
    [
      'diff --git a/packages/nodejs/src/generated/../../x b/packages/nodejs/src/generated/../../x',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/packages/nodejs/src/generated/../../x',
      '@@ -0,0 +1 @@',
      '+evil',
      '',
    ].join('\n'),
  );
  assertRejected(checkPatch(patch, { cwd: f.dir }));
});

test('rejects an empty or malformed patch', () => {
  const f = fixture();
  assertRejected(checkPatch(f.raw(''), { cwd: f.dir }));
  assertRejected(checkPatch(f.raw('not a patch\n'), { cwd: f.dir }));
});
