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

/** The normalized `info.version` of an OpenAPI document. */
export function specVersion(body) {
  return normalizeVersion(JSON.parse(normalizeSpec(body)).info.version);
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

function stableTags(base, tags) {
  const re = new RegExp(`^(nodejs|swift|dotnet|kotlin)/v${escapeRegExp(base)}$`);
  return tags.filter((t) => re.test(t));
}

/**
 * Next `<base>-beta.N`, where N is shared across all languages. Throws when any
 * language already has a stable tag for `base`: a beta of a released version
 * would sort below it, so the API must bump `info.version` first.
 */
export function nextBeta(base, tags) {
  const existing = stableTags(base, tags);
  if (existing.length > 0) {
    throw new Error(`stable ${base} already released (${existing.join(', ')}); the API must bump info.version`);
  }
  const max = betaNumbers(base, tags).reduce((acc, { n }) => Math.max(acc, n), 0);
  return `${base}-beta.${max + 1}`;
}

/** Throws when any language already has a stable tag for `base`. */
export function assertStableAvailable(base, tags) {
  const existing = stableTags(base, tags);
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
    case 'beta':
      return nextBeta(specVersion(readFileSync(option(args, '--spec'), 'utf8')), gitTags());
    case 'spec-version':
      return specVersion(readFileSync(option(args, '--spec'), 'utf8'));
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
      throw new Error('usage: node scripts/next-version.mjs <beta --spec <path> | spec-version --spec <path> | stable --version <v> | latest-beta --version <v>>');
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
