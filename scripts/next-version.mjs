import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizeSpec } from './spec.mjs';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Validate `YYYY.M.D`-style versions and strip leading zeros from each part. */
export function normalizeVersion(v) {
  const m = VERSION_RE.exec(v);
  if (!m) {
    throw new Error(`invalid version: ${JSON.stringify(v)} (expected <major>.<minor>.<patch>)`);
  }
  return m.slice(1).map((p) => String(Number(p))).join('.');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function betaNumbers(base, tags) {
  const re = new RegExp(`^(nodejs|swift|dotnet|kotlin)/v${escapeRegExp(base)}-beta\\.(\\d+)$`);
  return tags.flatMap((t) => {
    const m = re.exec(t);
    return m ? [{ tag: t, lang: m[1], n: Number(m[2]) }] : [];
  });
}

/** Next `<base>-beta.N`, where N is shared across all languages. */
export function nextBeta(base, tags) {
  const max = betaNumbers(base, tags).reduce((acc, { n }) => Math.max(acc, n), 0);
  return `${base}-beta.${max + 1}`;
}

/** Throws when any language already has a stable tag for `base`. */
export function assertStableAvailable(base, tags) {
  const re = new RegExp(`^(nodejs|swift|dotnet|kotlin)/v${escapeRegExp(base)}$`);
  const existing = tags.filter((t) => re.test(t));
  if (existing.length > 0) {
    throw new Error(`stable version ${base} already released: ${existing.join(', ')}`);
  }
}

/** The `nodejs/v<base>-beta.N` tag with the largest N, or undefined. */
export function latestBetaTag(base, tags) {
  return betaNumbers(base, tags)
    .filter(({ lang }) => lang === 'nodejs')
    .sort((a, b) => b.n - a.n)[0]?.tag;
}

function gitTags() {
  return execFileSync('git', ['tag', '-l'], { encoding: 'utf8' })
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);
}

function option(args, name) {
  const i = args.indexOf(name);
  const value = i === -1 ? undefined : args[i + 1];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function main(argv) {
  const [command, ...args] = argv;

  switch (command) {
    case 'beta': {
      const spec = JSON.parse(normalizeSpec(readFileSync(option(args, '--spec'), 'utf8')));
      return nextBeta(normalizeVersion(spec.info.version), gitTags());
    }
    case 'stable': {
      const base = normalizeVersion(option(args, '--version'));
      assertStableAvailable(base, gitTags());
      return base;
    }
    case 'latest-beta': {
      const base = normalizeVersion(option(args, '--version'));
      const tag = latestBetaTag(base, gitTags());
      if (!tag) throw new Error(`no beta tag found for ${base}`);
      return tag;
    }
    default:
      throw new Error('usage: node scripts/next-version.mjs <beta --spec <path> | stable --version <v> | latest-beta --version <v>>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
