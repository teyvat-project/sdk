import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Parse an OpenAPI document and re-serialize it in the repository's canonical form
 * (2-space indent, trailing newline, key order preserved).
 * Throws when the body is not JSON or lacks info.version.
 */
export function normalizeSpec(body) {
  const spec = JSON.parse(body);
  const version = spec?.info?.version;
  if (typeof version !== 'string' || version === '') {
    throw new Error('spec is missing info.version');
  }
  return JSON.stringify(spec, null, 2) + '\n';
}

async function main(url, path) {
  if (!url || !path) {
    throw new Error('usage: node scripts/spec.mjs <url> <path>');
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }

  const next = normalizeSpec(await res.text());

  let current;
  try {
    current = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  if (current === next) {
    console.log('changed=false');
    return;
  }

  writeFileSync(path, next);
  console.log('changed=true');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2], process.argv[3]).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
