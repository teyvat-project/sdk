import { definePlugin } from '@natsuneko-laboratory/archon';
import type { IROperation } from '@natsuneko-laboratory/archon';
import type { TypeScriptPluginAPI } from '@natsuneko-laboratory/archon/plugins';

// Emits `facade.gen.ts` next to the TypeScript plugin's output: a `createFacade(client)` factory that nests the
// generated operation functions by path, the way the old @hey-api/openapi-ts SDK did
// (`GET /catalyst/v1.1/timeline/home` -> `catalyst.v11.timeline.home.get()`).

export interface FacadeOptions {
  /** Must be the TypeScript plugin's `output`, so the relative imports resolve. */
  output: string;
  /** First path segments (service roots) to leave out, e.g. `'token'`. */
  exclude: string[];
}

/** What the renderer needs to know about one generated operation. */
export interface FacadeOperation {
  method: string;
  path: string;
  functionName: string;
  dataType: string;
  /** The file that exports `functionName` and `dataType`, relative to the output directory. */
  file: string;
  /** True when the generated function has no `= {}` default for its options. */
  optionsRequired: boolean;
  summary?: string;
  description?: string;
  deprecated: boolean;
}

export interface FacadeNode {
  /** The raw path segment, used in collision messages. */
  segment: string;
  methods: Map<string, FacadeOperation>;
  children: Map<string, FacadeNode>;
}

const METHOD_NAMES: Record<string, string> = {
  get: 'get',
  post: 'create',
  put: 'update',
  patch: 'patch',
  delete: 'delete',
};
const METHOD_ORDER = Object.values(METHOD_NAMES);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** camelCases one path segment like the npm `camelcase` package: `v1.1` -> `v11`, `by-id` -> `byId`, `{id}` -> `id`. */
export function segmentName(segment: string): string {
  const words = segment.replace(/^\{(.*)\}$/, '$1').split(/[-_. ]+/).filter(Boolean);
  const name = words
    .map((word, i) => {
      const w = word === word.toUpperCase() ? word.toLowerCase() : word;
      return i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('');
  if (!IDENTIFIER.test(name)) throw new Error(`Path segment "${segment}" does not map to a JavaScript identifier.`);
  return name;
}

/** Mirrors the TypeScript plugin, which omits the `= {}` default for a required body, any path param or a required param. */
export function optionsRequired(op: IROperation): boolean {
  const body = op.requestBody !== undefined && op.requestBody.contents.length > 0 && op.requestBody.required;
  return body || op.parameters.some((p) => p.in === 'path' || p.required);
}

const newNode = (segment: string): FacadeNode => ({ segment, methods: new Map(), children: new Map() });

export function buildFacadeTree(operations: FacadeOperation[], opts: { exclude: string[] }): FacadeNode {
  const root = newNode('');
  for (const op of operations) {
    const segments = op.path.split('/').filter(Boolean);
    if (segments.length === 0) throw new Error(`Operation ${op.method.toUpperCase()} "${op.path}" has no service root.`);
    if (opts.exclude.includes(segments[0]!)) continue;

    const leaf = METHOD_NAMES[op.method];
    if (leaf === undefined) throw new Error(`No facade name for ${op.method.toUpperCase()} ${op.path}.`);

    let node = root;
    const keys: string[] = [];
    for (const segment of segments) {
      const key = segmentName(segment);
      keys.push(key);
      const accessor = keys.join('.');
      if (node.methods.has(key)) throw new Error(`"${accessor}" is both a method and a path segment (${op.path}).`);
      const child = node.children.get(key);
      if (child === undefined) {
        node.children.set(key, (node = newNode(segment)));
      } else if (child.segment !== segment) {
        throw new Error(`Path segments "${child.segment}" and "${segment}" both map to "${accessor}" (${op.path}).`);
      } else {
        node = child;
      }
    }

    const accessor = [...keys, leaf].join('.');
    if (node.children.has(leaf)) throw new Error(`"${accessor}" is both a method and a path segment (${op.path}).`);
    const existing = node.methods.get(leaf);
    if (existing !== undefined) throw new Error(`${existing.path} and ${op.path} both map to "${accessor}".`);
    node.methods.set(leaf, op);
  }
  return root;
}

const byKey = <T>(a: [string, T], b: [string, T]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

function collect(node: FacadeNode, out: FacadeOperation[] = []): FacadeOperation[] {
  out.push(...node.methods.values());
  for (const child of node.children.values()) collect(child, out);
  return out;
}

function importBlock(names: Set<string>, from: string, typeOnly: boolean): string[] {
  return [`import ${typeOnly ? 'type ' : ''}{`, ...[...names].sort().map((n) => `  ${n},`), `} from '${from}';`];
}

function renderNode(node: FacadeNode, indent: string, lines: string[]): void {
  const methods = [...node.methods].sort((a, b) => METHOD_ORDER.indexOf(a[0]) - METHOD_ORDER.indexOf(b[0]));
  for (const [name, op] of methods) {
    // Same doc as the generated function, so both show the same hover text.
    const doc = [op.summary, op.description].filter((s) => s !== undefined && s !== '');
    if (doc.length === 0) doc.push(`${op.method.toUpperCase()} ${op.path}`);
    const rows = [...doc.join('\n\n').split('\n'), ...(op.deprecated ? ['@deprecated'] : [])];
    lines.push(`${indent}/**`, ...rows.map((l) => `${indent} *${l ? ` ${l.replaceAll('*/', '*\\/')}` : ''}`), `${indent} */`);
    const optional = op.optionsRequired ? '' : '?';
    lines.push(
      `${indent}${name}: <ThrowOnError extends boolean = false>(options${optional}: Omit<Options<${op.dataType}, ThrowOnError>, 'client'>) =>`,
      `${indent}  ${op.functionName}<ThrowOnError>({ ...options, client }),`,
    );
  }
  for (const [key, child] of [...node.children].sort(byKey)) {
    lines.push(`${indent}${key}: {`);
    renderNode(child, `${indent}  `, lines);
    lines.push(`${indent}},`);
  }
}

export function renderFacade(root: FacadeNode, header: string[], importExtension = '.js'): string {
  const functions = new Map<string, Set<string>>();
  const types = new Map<string, Set<string>>();
  for (const op of collect(root)) {
    const from = `./${op.file.replace(/\.ts$/, importExtension)}`;
    if (!functions.has(from)) functions.set(from, new Set());
    if (!types.has(from)) types.set(from, new Set());
    functions.get(from)!.add(op.functionName);
    types.get(from)!.add(op.dataType);
  }

  const lines = header.flatMap((l) => l.split('\n')).map((l) => (l === '' ? '//' : `// ${l}`));
  if (lines.length > 0) lines.push('');
  lines.push(`import type { ApiAuth, Client, Options } from './index${importExtension}';`);
  for (const [from, names] of [...functions].sort(byKey)) lines.push(...importBlock(names, from, false));
  for (const [from, names] of [...types].sort(byKey)) lines.push(...importBlock(names, from, true));

  lines.push(
    '',
    '/** Nests every operation by its path: `GET /catalyst/v1.1/timeline/home` is `catalyst.v11.timeline.home.get()`. */',
    'export function createFacade(client: Client<ApiAuth>) {',
    '  return {',
  );
  renderNode(root, '    ', lines);
  lines.push('  };', '}', '', 'export type Facade = ReturnType<typeof createFacade>;');
  for (const [key] of [...root.children].sort(byKey)) lines.push(`export type ${pascal(key)}Facade = Facade['${key}'];`);
  return `${lines.join('\n')}\n`;
}

export const facade = definePlugin<FacadeOptions>({
  name: 'typescript-facade',
  dependencies: ['typescript'],
  defaults: { output: 'typescript', exclude: [] },
  generate(ctx) {
    const tsPlugin = ctx.config.plugins.find((p) => p.name === 'typescript');
    const tsOptions = (tsPlugin?.options ?? {}) as { output?: string; importExtension?: string };
    const tsOutput = tsOptions.output ?? 'typescript';
    if (tsOutput.replace(/\/+$/, '') !== ctx.outputDir) {
      ctx.diagnostics.error(
        'facade-output',
        `The facade's output "${ctx.outputDir}" must match the typescript plugin's output "${tsOutput}".`,
      );
    }

    const ts = ctx.plugin<TypeScriptPluginAPI>('typescript');
    const operations = ctx.ir.operations.map((op): FacadeOperation => {
      const symbols = ts.symbols.operation(op.id);
      if (symbols.functionName.includes('.')) {
        ctx.diagnostics.error('facade-sdk-style', 'The facade needs the typescript plugin\'s `sdk: { style: "functions" }`.');
      }
      return {
        method: op.method,
        path: op.path,
        functionName: symbols.functionName,
        dataType: symbols.dataType,
        file: symbols.file,
        optionsRequired: optionsRequired(op),
        ...(op.summary !== undefined && { summary: op.summary }),
        ...(op.description !== undefined && { description: op.description }),
        deprecated: op.deprecated,
      };
    });

    let tree: FacadeNode;
    try {
      tree = buildFacadeTree(operations, { exclude: ctx.options.exclude });
    } catch (e) {
      return ctx.diagnostics.error('facade-collision', (e as Error).message);
    }
    ctx.emit('facade.gen.ts', renderFacade(tree, ctx.headerLines('typescript'), tsOptions.importExtension ?? '.js'));
  },
});
