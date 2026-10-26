import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The only paths a regeneration patch may touch: the spec snapshot and the
// archon output directories (see archon.config.ts).
export const ALLOWED_FILES = ['openapi/openapi.json'];
export const ALLOWED_DIRS = [
  'packages/nodejs/src/generated/',
  'packages/swift/Generated/',
  'packages/dotnet/CatalystSharp/Generated/',
  'packages/kotlin/src/generated/kotlin/',
];

// Symlinks and submodules could point outside the allowed directories.
const FORBIDDEN_MODES = new Set(['120000', '160000']);

/** True when `path` is the spec snapshot or a file inside a generated directory. */
export function isAllowedPath(path) {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) return false;
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  return ALLOWED_FILES.includes(path) || ALLOWED_DIRS.some((d) => path.startsWith(d) && path.length > d.length);
}

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Undo git's C-style path quoting (`"a/caf\303\251 x"` -> `a/café x`). Unquoted input is returned as is. */
export function unquoteC(s) {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const bytes = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[++i];
    if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]);
    } else if (/^[0-7]{3}$/.test(body.slice(i, i + 3))) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      throw new Error(`invalid escape in quoted path: ${s}`);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Paths named by `rename from/to` and `copy from/to` header lines. A copy's
 * source does not change, so it never shows up in the index diff below.
 * Hunk lines start with ' ', '+', '-' or '\' and binary data has no spaces,
 * so these lines can only be headers.
 */
export function renameCopyPaths(patch) {
  const paths = [];
  for (const line of patch.split('\n')) {
    const m = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line);
    if (m) paths.push(unquoteC(m[1]));
  }
  return paths;
}

/** Parse `git diff-index --raw -z --no-renames` output. */
export function parseRawZ(out) {
  const fields = out.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(fields[i]);
    if (!m) throw new Error(`unexpected diff-index output: ${JSON.stringify(fields[i])}`);
    entries.push({ srcMode: m[1], dstMode: m[2], status: m[3], path: fields[i + 1] });
  }
  return entries;
}

/**
 * Apply `patchFile` to a throwaway index built from HEAD (the working tree and
 * the real index are untouched) and list what actually changed. Git does the
 * parsing, so quoting, renames, deletions and mode changes are all covered.
 * Returns the problems found; an empty array means the patch is allowed.
 */
export function checkPatch(patchFile, { cwd = process.cwd() } = {}) {
  // `git apply` ignores paths outside the current directory, so always work
  // from the top level, as the workflows do.
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  const patch = resolve(cwd, patchFile);
  const dir = mkdtempSync(join(tmpdir(), 'check-patch-paths-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  const git = (...args) => execFileSync('git', args, { cwd: top, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('read-tree', 'HEAD');
    try {
      git('apply', '--cached', patch);
    } catch (e) {
      return [`git apply failed: ${String(e.stderr || e.message).trim()}`];
    }
    const entries = parseRawZ(git('diff-index', '--cached', '--raw', '-z', '--no-renames', 'HEAD'));
    const problems = [];
    for (const { dstMode, path } of entries) {
      if (!isAllowedPath(path)) problems.push(`disallowed path: ${path}`);
      else if (FORBIDDEN_MODES.has(dstMode)) problems.push(`disallowed file mode ${dstMode}: ${path}`);
    }
    for (const path of renameCopyPaths(readFileSync(patch, 'utf8'))) {
      if (!isAllowedPath(path)) problems.push(`disallowed rename/copy path: ${path}`);
    }
    if (entries.length === 0) problems.push('patch changes nothing');
    return [...new Set(problems)];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Workflow command data must not contain raw %, CR or LF.
function escapeData(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [patchFile] = process.argv.slice(2);
  if (!patchFile) {
    console.error('usage: node scripts/check-patch-paths.mjs <patch>');
    process.exit(2);
  }
  let problems;
  try {
    problems = checkPatch(patchFile);
  } catch (e) {
    problems = [`cannot check patch: ${(e.stderr || e.message).toString().trim()}`];
  }
  for (const p of problems) console.log(`::error::regeneration patch rejected: ${escapeData(JSON.stringify(p))}`);
  if (problems.length > 0) process.exit(1);
  console.log('regeneration patch only touches allowed paths');
}
