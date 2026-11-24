#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const genDir = join(pkg, 'src/gen');
const outFile = join(pkg, 'src/schemas.gen.ts');
const check = process.argv.includes('--check');

interface Alias {
  name: string;
  node: ts.TypeNode;
  src: ts.SourceFile;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const aliases = new Map<string, Alias>();
const maps = new Map<string, ts.InterfaceDeclaration>();
for (const file of files(genDir).sort()) {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const st of src.statements) {
    if (ts.isTypeAliasDeclaration(st)) {
      if (st.typeParameters) fail(src, st, 'generic type aliases are not supported');
      aliases.set(st.name.text, { name: st.name.text, node: st.type, src });
    } else if (ts.isInterfaceDeclaration(st)) {
      maps.set(st.name.text, st);
    }
  }
}

function fail(src: ts.SourceFile, node: ts.Node, why: string): never {
  const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
  throw new Error(`${relative(pkg, src.fileName)}:${String(line + 1)}: ${why}: ${node.getText(src).slice(0, 120)}`);
}

function refs(node: ts.Node, out: Set<string>): Set<string> {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && aliases.has(node.typeName.text)) {
    out.add(node.typeName.text);
  }
  ts.forEachChild(node, (c) => {
    refs(c, out);
  });
  return out;
}

const order: string[] = [];
const state = new Map<string, 'visiting' | 'done'>();
const lazy = new Set<string>();
function visit(name: string): void {
  state.set(name, 'visiting');
  for (const dep of [...refs(aliases.get(name)!.node, new Set())].sort()) {
    const s = state.get(dep);
    if (s === 'visiting') lazy.add(`${name}→${dep}`);
    else if (s === undefined) visit(dep);
  }
  state.set(name, 'done');
  order.push(name);
}
for (const name of [...aliases.keys()].sort()) if (!state.has(name)) visit(name);

// The wire may differ from the ts-rs type (a `bigint` is a JSON number, an Option field may be absent or `null`).
const codecOf = (name: string) => `z.ZodType<T.${name}>`;

function propName(src: ts.SourceFile, name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return fail(src, name, 'unsupported property name');
}

function key(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function members(a: Alias, node: ts.TypeNode): ts.NodeArray<ts.TypeElement> {
  if (ts.isTypeLiteralNode(node)) return node.members;
  if (ts.isParenthesizedTypeNode(node)) return members(a, node.type);
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const target = aliases.get(node.typeName.text);
    if (target) return members(target, target.node);
  }
  return fail(a.src, node, 'intersection member is not an object type');
}

function nullable(node: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(node)) return nullable(node.type);
  return (
    ts.isUnionTypeNode(node) &&
    node.types.some((t) => ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword)
  );
}

/**
 * serde reads an absent Option field and `null` alike. ts-rs's `optional_fields` types `x?: T` though serde still
 * writes `null`, and `skip_serializing_if` leaves the key out of a `T | null` field.
 */
function fields(a: Alias, elements: readonly ts.TypeElement[], from: string): string {
  const absent: string[] = [];
  const out = elements.map((m) => {
    if (!ts.isPropertySignature(m) || !m.type) return fail(a.src, m, 'unsupported object member');
    const name = propName(a.src, m.name);
    const value = expr(a, m.type, from);
    let field = value;
    if (m.questionToken && nullable(m.type)) field = `${value}.optional()`;
    else if (m.questionToken) {
      field = `optionalField(${value})`;
      absent.push(name);
    } else if (nullable(m.type)) field = `${value}.default(null)`;
    return `${key(name)}: ${field}`;
  });
  const shape = `{ ${out.join(', ')} }`;
  return absent.length === 0 ? `z.object(${shape})` : `struct(${shape}, ${JSON.stringify(absent)})`;
}

function expr(a: Alias, node: ts.TypeNode, from: string): string {
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return 'z.string()';
    case ts.SyntaxKind.NumberKeyword:
      return 'z.number()';
    case ts.SyntaxKind.BooleanKeyword:
      return 'z.boolean()';
    case ts.SyntaxKind.UnknownKeyword:
      return 'z.unknown()';
    case ts.SyntaxKind.NeverKeyword:
      return 'z.never()';
    case ts.SyntaxKind.SymbolKeyword:
      return 'z.symbol()';
    case ts.SyntaxKind.BigIntKeyword:
      return 'bigIntFromNumber';
  }
  if (ts.isParenthesizedTypeNode(node)) return expr(a, node.type, from);
  if (ts.isTemplateLiteralTypeNode(node)) {
    const text = (s: string) => (s === '' ? [] : [JSON.stringify(s)]);
    const parts = [
      ...text(node.head.text),
      ...node.templateSpans.flatMap((s) => [expr(a, s.type, from), ...text(s.literal.text)]),
    ];
    return `z.templateLiteral([${parts.join(', ')}])`;
  }
  if (ts.isLiteralTypeNode(node)) {
    const lit = node.literal;
    if (lit.kind === ts.SyntaxKind.NullKeyword) return 'z.null()';
    if (lit.kind === ts.SyntaxKind.TrueKeyword) return 'z.literal(true)';
    if (lit.kind === ts.SyntaxKind.FalseKeyword) return 'z.literal(false)';
    if (ts.isStringLiteral(lit)) return `z.literal(${JSON.stringify(lit.text)})`;
    if (ts.isNumericLiteral(lit)) return `z.literal(${lit.text})`;
    return fail(a.src, node, 'unsupported literal');
  }
  if (ts.isUnionTypeNode(node)) {
    const types = node.types;
    const strings = types.every((t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal));
    if (strings) {
      const values = types.map((t) => JSON.stringify(((t as ts.LiteralTypeNode).literal as ts.StringLiteral).text));
      return `z.enum([${values.join(', ')}])`;
    }
    const isNull = (t: ts.TypeNode) => ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword;
    const rest = types.filter((t) => !isNull(t));
    if (rest.length === types.length - 1 && rest.length === 1) return `${expr(a, rest[0]!, from)}.nullable()`;
    return `z.union([${types.map((t) => expr(a, t, from)).join(', ')}])`;
  }
  if (ts.isTypeLiteralNode(node)) return fields(a, node.members, from);
  if (ts.isIntersectionTypeNode(node))
    return fields(
      a,
      node.types.flatMap((t) => [...members(a, t)]),
      from,
    );
  if (ts.isMappedTypeNode(node)) {
    const constraint = node.typeParameter.constraint;
    if (constraint?.kind !== ts.SyntaxKind.StringKeyword || !node.type || node.questionToken) {
      return fail(a.src, node, 'unsupported mapped type');
    }
    return `z.record(z.string(), ${expr(a, node.type, from)})`;
  }
  if (ts.isTupleTypeNode(node)) {
    const elements = node.elements.map((e) => (ts.isNamedTupleMember(e) ? e.type : e));
    if (elements.some((e) => ts.isOptionalTypeNode(e) || ts.isRestTypeNode(e))) {
      return fail(a.src, node, 'unsupported tuple element');
    }
    return `z.tuple([${elements.map((e) => expr(a, e, from)).join(', ')}])`;
  }
  if (ts.isArrayTypeNode(node)) return `z.array(${expr(a, node.elementType, from)})`;
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;
    const args = node.typeArguments ?? [];
    if (name === 'Array' && args.length === 1) return `z.array(${expr(a, args[0]!, from)})`;
    if (name === 'Record' && args.length === 2) {
      // ts-rs types an empty struct `Record<symbol, never>`.
      if (args[0]!.kind === ts.SyntaxKind.SymbolKeyword && args[1]!.kind === ts.SyntaxKind.NeverKeyword) {
        return 'z.object({})';
      }
      return `z.record(${expr(a, args[0]!, from)}, ${expr(a, args[1]!, from)})`;
    }
    if (args.length === 0 && aliases.has(name)) {
      return lazy.has(`${from}→${name}`) ? `z.lazy((): ${codecOf(name)} => ${name})` : name;
    }
  }
  return fail(a.src, node, 'unsupported type');
}

function mapSchemas(iface: string, side: string): string {
  const decl = maps.get(iface);
  if (!decl) throw new Error(`src/gen: no interface ${iface}`);
  const src = decl.getSourceFile();
  const entries = decl.members.map((m) => {
    if (!ts.isPropertySignature(m) || !m.type || !ts.isTypeLiteralNode(m.type)) {
      return fail(src, m, `unsupported ${iface} entry`);
    }
    const parts = new Map(
      m.type.members.map((p) => {
        if (!ts.isPropertySignature(p) || !p.type) return fail(src, p, `unsupported ${iface} entry`);
        return [propName(src, p.name), p.type] as const;
      }),
    );
    const pseudo: Alias = { name: iface, node: m.type, src };
    const t = parts.get(side);
    const schema = t ? expr(pseudo, t, iface) : fail(src, m, `${iface} entry without ${side}`);
    return `  ${JSON.stringify(propName(src, m.name))}: ${schema},`;
  });
  const shape = `{ readonly [K in keyof T.${iface}]: z.ZodType<T.${iface}[K]['${side}']> }`;
  return `{\n${entries.join('\n')}\n} as const satisfies ${shape}`;
}

const body = order.map((name) => {
  const a = aliases.get(name)!;
  return `export const ${name}: ${codecOf(name)} = ${expr(a, a.node, name)};`;
});

const out = `// Generated by packages/protocol/scripts/schemas.ts from the ts-rs bindings in src/gen. Do not edit.
// Regenerate with: bun run gen (or bun run gen:schemas when only src/gen changed)
import { z } from 'zod';
import type * as T from './gen/index.ts';

/** A 64-bit integer: serde sends a JSON number, ts-rs types it \`bigint\`. */
const bigIntFromNumber = z.number().transform((n) => BigInt(n));

/** \`x?: T\`: absent, or \`null\` (serde writes \`None\` so), which reads as absent ({@link struct} drops the key). */
const optionalField = <S extends z.ZodType>(schema: S) => schema.nullish().transform((v) => v ?? undefined);

/** An object whose \`absent\` keys are \`x?: T\` fields: one that read as nothing is left out, as it was sent. */
const struct = <Shape extends z.ZodRawShape>(shape: Shape, absent: readonly string[]) =>
  z.object(shape).transform((o) => {
    const out = o as Record<string, unknown>;
    for (const k of absent) if (out[k] === undefined) delete out[k];
    return o;
  });

${body.join('\n')}

/** Every tool's output schema (\`ToolMap\`). */
export const ToolOutputs = ${mapSchemas('ToolMap', 'output')};

/** Every topic's event schema (\`TopicMap\`). */
export const TopicEvents = ${mapSchemas('TopicMap', 'data')};
`;

if (check) {
  let current = '';
  try {
    current = readFileSync(outFile, 'utf8');
  } catch {}
  if (current !== out) {
    console.error('packages/protocol/src/schemas.gen.ts is stale: run `bun run gen:schemas`.');
    process.exit(1);
  }
} else {
  writeFileSync(outFile, out);
  console.info(`wrote ${relative(process.cwd(), outFile)} (${String(order.length)} schemas)`);
}
