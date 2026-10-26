import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeSpec } from './spec.mjs';

test('normalizeSpec indents with 2 spaces, appends newline and keeps key order', () => {
  const out = normalizeSpec('{"openapi":"3.1.0","info":{"version":"1"}}');
  assert.equal(out, '{\n  "openapi": "3.1.0",\n  "info": {\n    "version": "1"\n  }\n}\n');
});

test('normalizeSpec throws on invalid JSON', () => {
  assert.throws(() => normalizeSpec('<html>'));
});

test('normalizeSpec throws when info.version is missing', () => {
  assert.throws(() => normalizeSpec('{"openapi":"3.1.0","info":{}}'), /info\.version/);
});
