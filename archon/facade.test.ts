import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFacadeTree, type FacadeOperation, renderFacade, segmentName } from './facade.ts';

const op = (method: string, path: string, extra: Partial<FacadeOperation> = {}): FacadeOperation => ({
  method,
  path,
  functionName: `${method}${path.replace(/[^A-Za-z0-9]/g, '')}`,
  dataType: `${method}${path.replace(/[^A-Za-z0-9]/g, '')}Data`,
  file: 'sdk.gen.ts',
  optionsRequired: false,
  deprecated: false,
  ...extra,
});

test('segmentName follows the old camelcase rule', () => {
  assert.equal(segmentName('v1.1'), 'v11');
  assert.equal(segmentName('v1'), 'v1');
  assert.equal(segmentName('by-id'), 'byId');
  assert.equal(segmentName('on-this-day'), 'onThisDay');
  assert.equal(segmentName('feature-flags'), 'featureFlags');
  assert.equal(segmentName('{id}'), 'id');
  assert.equal(segmentName('{bookId}'), 'bookId');
  assert.equal(segmentName('{customReactionId}'), 'customReactionId');
  assert.equal(segmentName('snake_case'), 'snakeCase');
});

test('segmentName rejects segments that are not identifiers', () => {
  assert.throws(() => segmentName('2fa'), /"2fa"/);
  assert.throws(() => segmentName('{}'), /"{}"/);
});

test('leaves are named after the HTTP method', () => {
  const tree = buildFacadeTree(
    ['get', 'post', 'put', 'patch', 'delete'].map((m) => op(m, '/svc/item')),
    { exclude: [] },
  );
  const item = tree.children.get('svc')!.children.get('item')!;
  assert.deepEqual([...item.methods.keys()], ['get', 'create', 'update', 'patch', 'delete']);
});

test('a node holds both methods and children', () => {
  const tree = buildFacadeTree(
    [op('post', '/catalyst/v1/album/by/id/{id}/book/{bookId}/regenerate'), op('get', '/catalyst/v1/album/by/id/{id}/book/{bookId}')],
    { exclude: [] },
  );
  const bookId = ['catalyst', 'v1', 'album', 'by', 'id', 'id', 'book', 'bookId'].reduce((n, k) => n.children.get(k)!, tree);
  assert.deepEqual([...bookId.methods.keys()], ['get']);
  assert.deepEqual([...bookId.children.keys()], ['regenerate']);
  assert.deepEqual([...bookId.children.get('regenerate')!.methods.keys()], ['create']);
});

test('excluded service roots are left out', () => {
  const tree = buildFacadeTree([op('post', '/token'), op('get', '/media/x')], { exclude: ['token'] });
  assert.deepEqual([...tree.children.keys()], ['media']);
});

test('two segments with the same name fail generation', () => {
  assert.throws(
    () => buildFacadeTree([op('get', '/svc/by-id'), op('post', '/svc/byId')], { exclude: [] }),
    /"by-id" .*"byId".*svc\.byId/s,
  );
});

test('a method that collides with a child fails generation', () => {
  assert.throws(
    () => buildFacadeTree([op('get', '/svc/a'), op('get', '/svc/a/get')], { exclude: [] }),
    /svc\.a\.get/,
  );
  assert.throws(
    () => buildFacadeTree([op('get', '/svc/a/get'), op('get', '/svc/a')], { exclude: [] }),
    /svc\.a\.get/,
  );
});

test('unsupported methods and empty paths fail generation', () => {
  assert.throws(() => buildFacadeTree([op('head', '/svc/a')], { exclude: [] }), /HEAD \/svc\/a/);
  assert.throws(() => buildFacadeTree([op('get', '/')], { exclude: [] }), /"\/"/);
});

test('renderFacade emits a typed factory that forwards the client', () => {
  const tree = buildFacadeTree(
    [
      op('get', '/svc/home', { functionName: 'getSvcHome', dataType: 'GetSvcHomeData', summary: 'Home */ timeline', description: 'Details' }),
      op('get', '/svc/status/{id}', { functionName: 'getSvcStatusById', dataType: 'GetSvcStatusByIdData', optionsRequired: true, deprecated: true }),
      op('get', '/feature-flags', { functionName: 'getFeatureFlags', dataType: 'GetFeatureFlagsData' }),
    ],
    { exclude: [] },
  );
  const out = renderFacade(tree, ['Generated.', '', 'Do not edit.']);

  assert.ok(out.startsWith('// Generated.\n//\n// Do not edit.\n\n'));
  assert.match(out, /^import type \{ ApiAuth, Client, Options \} from '\.\/index\.js';$/m);
  assert.match(out, /^import \{\n {2}getFeatureFlags,\n {2}getSvcHome,\n {2}getSvcStatusById,\n\} from '\.\/sdk\.gen\.js';$/m);
  assert.match(out, /^export function createFacade\(client: Client<ApiAuth>\) \{$/m);
  assert.match(
    out,
    /get: <ThrowOnError extends boolean = false>\(options\?: Omit<Options<GetSvcHomeData, ThrowOnError>, 'client'>\) =>\n\s+getSvcHome<ThrowOnError>\(\{ \.\.\.options, client \}\),/,
  );
  assert.match(out, /\(options: Omit<Options<GetSvcStatusByIdData, ThrowOnError>, 'client'>\) =>/);
  assert.match(out, /\/\*\*\n\s+\* Home \*\\\/ timeline\n\s+\*\n\s+\* Details\n\s+\*\/\n\s+get: /);
  assert.match(out, /\/\*\*\n\s+\* GET \/svc\/status\/\{id\}\n\s+\* @deprecated\n\s+\*\/\n/);
  assert.match(out, /^export type Facade = ReturnType<typeof createFacade>;$/m);
  assert.match(out, /^export type FeatureFlagsFacade = Facade\['featureFlags'\];$/m);
  assert.match(out, /^export type SvcFacade = Facade\['svc'\];$/m);
  assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'));
});

test('renderFacade honours the import extension', () => {
  const out = renderFacade(buildFacadeTree([op('get', '/svc/a')], { exclude: [] }), [], '.ts');
  assert.match(out, /from '\.\/index\.ts';/);
  assert.match(out, /from '\.\/sdk\.gen\.ts';/);
});

test('renderFacade is independent of operation order', () => {
  const ops = [op('get', '/b/x'), op('post', '/a/y'), op('get', '/a/y'), op('delete', '/a/y/z')];
  const forward = renderFacade(buildFacadeTree(ops, { exclude: [] }), []);
  const reversed = renderFacade(buildFacadeTree([...ops].reverse(), { exclude: [] }), []);
  assert.equal(forward, reversed);
});
