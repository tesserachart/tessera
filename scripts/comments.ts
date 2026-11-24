import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

interface Comment {
  start: number;
  end: number;
  outerDoc: boolean;
  removal?: [number, number];
}

type Language =
  'ts' | 'rust' | 'css' | 'jsonc' | 'astro' | 'html' | 'toml' | 'yaml' | 'shell' | 'python' | 'ignorefile';

const repo = resolve(import.meta.dirname, '..');
const KEPT_PATH = 'scripts/kept-comments.json';

const PROSE = /^docs\/|\.md$/;
const GENERATED = /^packages\/protocol\/src\/gen\/|\.gen\.ts$|^design\/kit\/tessera-mock\.js$/;
const VENDORED = /^\.agents\/skills\/e2e\/|^\.e2e\/|^fixtures\/|^patches\/|^packages\/ui\/icons\//;
const CHECKSUMMED_MIGRATION = /\/migrations\/.*\.sql$/;
const USER_GUIDE_EXAMPLE = /^crates\/tessera-indicators\/js\/(?!builtins\.js$)/;

function languageOf(path: string): Language | null {
  if ([PROSE, GENERATED, VENDORED, CHECKSUMMED_MIGRATION, USER_GUIDE_EXAMPLE].some((skip) => skip.test(path)))
    return null;
  const name = path.split('/').pop()!;
  if (/\.[cm]?[jt]sx?$/.test(name)) return 'ts';
  if (name.endsWith('.rs')) return 'rust';
  if (name.endsWith('.css')) return 'css';
  if (name.endsWith('.jsonc') || /^tsconfig.*\.json$/.test(name)) return 'jsonc';
  if (name.endsWith('.astro')) return 'astro';
  if (name.endsWith('.html')) return 'html';
  if (name.endsWith('.toml')) return 'toml';
  if (/\.ya?ml$/.test(name)) return 'yaml';
  if (name.endsWith('.sh')) return 'shell';
  if (name.endsWith('.py')) return 'python';
  if (/^\.(?:git|prettier|eslint)ignore$|\.service$/.test(name)) return 'ignorefile';
  return null;
}

function lineEnd(text: string, from: number): number {
  const at = text.indexOf('\n', from);
  return at === -1 ? text.length : at;
}

function scanTs(text: string, path: string, offset = 0): Comment[] {
  const kind = /\.[jt]sx$|\.astro$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const found = new Map<number, Comment>();
  const jsxText: [number, number][] = [];
  const emptyJsx: [number, number][] = [];
  const add = (ranges: ts.CommentRange[] | undefined) => {
    for (const r of ranges ?? []) {
      const outerDoc = text.startsWith('/**', r.pos) && !text.startsWith('/**/', r.pos);
      found.set(r.pos, { start: r.pos, end: r.end, outerDoc });
    }
  };
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxText.push([node.pos, node.end]);
      return;
    }
    if (ts.isJsxExpression(node) && !node.expression) emptyJsx.push([node.getStart(source), node.end]);
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  const comments = [...found.values()].filter((c) => !jsxText.some(([s, e]) => c.start >= s && c.start < e));
  for (const [s, e] of emptyJsx) {
    const inside = comments.filter((c) => c.start > s && c.end < e);
    if (inside.length === 1) inside[0]!.removal = [s, e];
  }
  return comments.map((c) => ({
    ...c,
    start: c.start + offset,
    end: c.end + offset,
    removal: c.removal && [c.removal[0] + offset, c.removal[1] + offset],
  }));
}

function scanRust(text: string): { comments: Comment[]; literals: [number, number][] } {
  const comments: Comment[] = [];
  const literals: [number, number][] = [];
  const ident = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    const start = i;
    const raw = ident(text[i - 1]) ? null : /^[bc]?r(#*)"/.exec(text.slice(i, i + 260));
    if (ch === '/' && next === '/') {
      i = lineEnd(text, i);
      comments.push({ start, end: i, outerDoc: text[start + 2] === '/' && text[start + 3] !== '/' });
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      const outerDoc = text[start + 2] === '*' && text[start + 3] !== '*' && text[start + 3] !== '/';
      comments.push({ start, end: i, outerDoc });
    } else if (raw) {
      const close = `"${raw[1]!}`;
      const end = text.indexOf(close, i + raw[0].length);
      i = end === -1 ? text.length : end + close.length;
      literals.push([start, i]);
    } else if (ch === '"' || (!ident(text[i - 1]) && (ch === 'b' || ch === 'c') && next === '"')) {
      i = ch === '"' ? i + 1 : i + 2;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      literals.push([start, i]);
    } else if (ch === "'" || (!ident(text[i - 1]) && ch === 'b' && next === "'")) {
      const q = ch === "'" ? i : i + 1;
      if (text[q + 1] === '\\') {
        i = q + 2;
        while (i < text.length && text[i] !== "'") i++;
        i++;
        literals.push([start, i]);
      } else {
        const width = (text.codePointAt(q + 1) ?? 0) > 0xffff ? 2 : 1;
        if (text[q + 1 + width] === "'") {
          i = q + 2 + width;
          literals.push([start, i]);
        } else i = q + 1;
      }
    } else i++;
  }
  return { comments, literals };
}

function scanSlashStar(text: string, lineComments: boolean, offset = 0): Comment[] {
  const out: Comment[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const start = i;
    if (ch === '"' || ch === "'") {
      i++;
      while (i < text.length && text[i] !== ch && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out.push({ start: start + offset, end: i + offset, outerDoc: false });
    } else if (lineComments && ch === '/' && text[i + 1] === '/') {
      i = lineEnd(text, i);
      out.push({ start: start + offset, end: i + offset, outerDoc: false });
    } else i++;
  }
  return out;
}

function scanHash(text: string, language: 'toml' | 'yaml' | 'shell' | 'python' | 'ignorefile'): Comment[] {
  const out: Comment[] = [];
  const triple = language === 'toml' || language === 'python';
  const anywhere = triple;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const start = i;
    if (language === 'ignorefile') {
      i = lineEnd(text, i) + 1;
      if (ch === '#') out.push({ start, end: i - 1, outerDoc: false });
    } else if (triple && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const end = text.indexOf(text.slice(i, i + 3), i + 3);
      i = end === -1 ? text.length : end + 3;
    } else if (ch === '"' || ch === "'") {
      i++;
      while (i < text.length && text[i] !== ch && text[i] !== '\n') i += text[i] === '\\' && ch === '"' ? 2 : 1;
      i++;
    } else if (ch === '#' && (anywhere || i === 0 || /\s/.test(text[i - 1]!))) {
      i = lineEnd(text, i);
      out.push({ start, end: i, outerDoc: false });
    } else if (!anywhere && /[A-Za-z0-9_$({]/.test(ch)) {
      while (i < text.length && /[^\s'"]/.test(text[i]!)) i++;
    } else i++;
  }
  return out;
}

function scanMarkup(text: string, astro: boolean): Comment[] {
  const out: Comment[] = [];
  let body = 0;
  if (astro && text.startsWith('---')) {
    const close = text.indexOf('\n---', 3);
    if (close !== -1) {
      out.push(...scanTs(text.slice(3, close), 'frontmatter.ts', 3));
      body = close + 4;
    }
  }
  const markup = text.slice(body);
  for (const m of markup.matchAll(/<!--[\s\S]*?-->/g)) {
    out.push({ start: body + m.index, end: body + m.index + m[0].length, outerDoc: false });
  }
  for (const m of markup.matchAll(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const at = body + m.index + m[0].indexOf('>') + 1;
    out.push(...(m[1] === 'script' ? scanTs(m[2]!, 'inline.ts', at) : scanSlashStar(m[2]!, false, at)));
  }
  if (astro) {
    for (const m of markup.matchAll(/\{\s*(\/\*[\s\S]*?\*\/)\s*\}/g)) {
      const start = body + m.index + m[0].indexOf('/*');
      const at = body + m.index;
      out.push({ start, end: start + m[1]!.length, outerDoc: false, removal: [at, at + m[0].length] });
    }
  }
  return out;
}

function blankRanges(text: string, ranges: [number, number][]): string {
  const chars = text.split('');
  for (const [s, e] of ranges) for (let k = s; k < e; k++) if (chars[k] !== '\n') chars[k] = ' ';
  return chars.join('');
}

function skipAttributes(code: string, from: number): { attrs: string; item: number } {
  let i = from;
  let attrs = '';
  for (;;) {
    while (i < code.length && /\s/.test(code[i]!)) i++;
    if (!code.startsWith('#[', i)) return { attrs, item: i };
    const start = i;
    let depth = 0;
    i++;
    do {
      if (code[i] === '[') depth++;
      else if (code[i] === ']') depth--;
      i++;
    } while (i < code.length && depth > 0);
    attrs += code.slice(start, i);
  }
}

const DOC_CONSUMING_DERIVE = /\b(?:JsonSchema|Parser|Args|Subcommand|ValueEnum)\b/;

function matchingClose(code: string, open: number): number {
  const opener = code[open]!;
  const closer = { '{': '}', '(': ')', '[': ']' }[opener]!;
  let depth = 0;
  let i = open;
  do {
    if (code[i] === opener) depth++;
    else if (code[i] === closer) depth--;
    i++;
  } while (i < code.length && depth > 0);
  return i;
}

function rustContractDocs(
  text: string,
  comments: Comment[],
  literals: [number, number][],
  docForwardingMacros: Set<string>,
): Set<Comment> {
  const code = blankRanges(text, [...comments.map((c): [number, number] => [c.start, c.end]), ...literals]);
  const items = new Set<number>();
  const bodies: [number, number][] = [];
  for (const m of code.matchAll(/#\[/g)) {
    const { attrs, item } = skipAttributes(code, m.index);
    const derives = [...attrs.matchAll(/derive\(([^)]*)\)/g)].map((d) => d[1]).join(',');
    if (!DOC_CONSUMING_DERIVE.test(derives) || items.has(item)) continue;
    const head = /^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|union)\s+\w+[^{;(]*/.exec(code.slice(item));
    if (!head) continue;
    items.add(item);
    const open = item + head[0].length;
    if (code[open] === '{' || code[open] === '(') bodies.push([open, matchingClose(code, open)]);
  }
  for (const m of code.matchAll(/\b(\w+)!\s*[({[]/g)) {
    const open = m.index + m[0].length - 1;
    if (docForwardingMacros.has(m[1]!)) bodies.push([open, matchingClose(code, open)]);
  }
  return new Set(
    comments.filter(
      (c) =>
        c.outerDoc &&
        (bodies.some(([s, e]) => c.start > s && c.start < e) || items.has(skipAttributes(code, c.end).item)) &&
        !restatesItsItem(textOf(text.slice(c.start, c.end)), code.slice(skipAttributes(code, c.end).item)),
    ),
  );
}

const FILLER_WORDS = new Set(['a', 'an', 'the', 'its', 'of', 'for', 'to', 'in', 'on', 'if', 'any', 'one']);

function wordsOf(identifiers: string): Set<string> {
  const stem = (word: string) => word.replace(/(?:al|s)$/, '');
  return new Set(
    identifiers
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== '' && !FILLER_WORDS.has(word))
      .map(stem),
  );
}

const NAME_AND_TYPE =
  /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:struct|enum|union|type|fn|trait)\s+)?((?:r#)?\w+\s*(?::[^,\n}]*|\([^)]*\))?)/;

const isSchemaProperty = (nameAndType: string) => /^(?:r#)?\w+\s*:(?!:)/.test(nameAndType);

function restatesItsItem(doc: string, item: string): boolean {
  const signature = NAME_AND_TYPE.exec(item);
  if (!signature || isSchemaProperty(signature[1]!)) return false;
  const named = wordsOf(signature[1]!);
  const said = wordsOf(doc);
  return said.size > 0 && [...said].every((word) => named.has(word));
}

function docForwardingMacros(paths: string[]): Set<string> {
  const names = new Set<string>();
  for (const path of paths.filter((p) => languageOf(p) === 'rust' && existsSync(resolve(repo, p)))) {
    for (const m of readFileSync(resolve(repo, path), 'utf8').matchAll(/macro_rules!\s*(\w+)\s*\{([\s\S]*?)\n\}/g)) {
      const body = m[2]!;
      const derives = [...body.matchAll(/derive\(([^)]*)\)/g)].map((d) => d[1]).join(',');
      if (body.includes('$(#[$') && DOC_CONSUMING_DERIVE.test(derives)) names.add(m[1]!);
    }
  }
  return names;
}

const DIRECTIVE =
  /^(?:@ts-(?:expect-error|ignore|nocheck|check)\b|eslint-(?:disable|enable|env)\b|global\s|prettier-ignore|stylelint-|[@#]__PURE__|@vite-ignore|@vitest-environment|@jsx(?:ImportSource|Runtime)?\b|(?:c8|istanbul|v8) ignore|webpack[A-Z]|@license|@preserve|SPDX-License-Identifier|# sourceMappingURL|:schema |yaml-language-server:|noqa\b|type:\s*ignore|biome-ignore)/;
const JS_TYPE_ANNOTATION = /^@(?:type|typedef|satisfies|import|template|callback|param \{|returns \{)/;

function textOf(raw: string): string {
  return raw
    .replace(/^(?:\/\*+!?|<!--)/, '')
    .replace(/(?:\*+\/|-->)$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\/\/[/!]?|#+|\*(?!\/))?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDirective(raw: string, path: string, language: Language, at: number): boolean {
  if (at === 0 && raw.startsWith('#!')) return true;
  if (language === 'ts' && (/^\/\/\/\s*<reference\b/.test(raw) || raw.startsWith('//#'))) return true;
  if ((language === 'ts' || language === 'css') && raw.startsWith('/*!')) return true;
  const text = textOf(raw);
  if (language === 'yaml' && /^v\d+(?:\.\d+)*$/.test(text)) return true;
  if (language === 'rust' && text.startsWith('SAFETY:')) return true;
  return DIRECTIVE.test(text) || (/\.[cm]?jsx?$/.test(path) && JS_TYPE_ANNOTATION.test(text));
}

const LINE_MARKER = /^(?:\/\/[/!]?|#)/;

function ownLine(text: string, c: Comment): boolean {
  const lineStart = text.lastIndexOf('\n', c.start - 1) + 1;
  return text.slice(lineStart, c.start).trim() === '' && text.slice(c.end, lineEnd(text, c.end)).trim() === '';
}

function joinLineRuns(text: string, comments: Comment[], directive: (c: Comment) => boolean): Comment[] {
  const marker = (c: Comment) => LINE_MARKER.exec(text.slice(c.start, c.start + 3))?.[0];
  const out: Comment[] = [];
  for (const c of [...comments].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    const first = last && { ...last, end: lineEnd(text, last.start) };
    if (
      last &&
      first &&
      !last.removal &&
      marker(c) !== undefined &&
      marker(c) === marker(last) &&
      /^\n[ \t]*$/.test(text.slice(last.end, c.start)) &&
      ownLine(text, last) &&
      ownLine(text, c) &&
      !directive(c) &&
      (!directive(first) || textOf(text.slice(first.start, first.end)).startsWith('SAFETY:'))
    ) {
      last.end = c.end;
    } else out.push({ ...c });
  }
  return out;
}

function scan(
  text: string,
  path: string,
  language: Language,
  forwarding: Set<string>,
): { comments: Comment[]; contract: Set<Comment> } {
  const directive = (c: Comment) => isDirective(text.slice(c.start, c.end), path, language, c.start);
  if (language === 'rust') {
    const scanned = scanRust(text);
    const comments = joinLineRuns(text, scanned.comments, directive);
    return { comments, contract: rustContractDocs(text, comments, scanned.literals, forwarding) };
  }
  const comments = joinLineRuns(
    text,
    language === 'ts'
      ? scanTs(text, path)
      : language === 'css'
        ? scanSlashStar(text, false)
        : language === 'jsonc'
          ? scanSlashStar(text, true)
          : language === 'astro' || language === 'html'
            ? scanMarkup(text, language === 'astro')
            : scanHash(text, language),
    directive,
  );
  return { comments, contract: new Set() };
}

type Kept = Record<string, string[]>;

interface Found {
  path: string;
  line: number;
  raw: string;
  text: string;
  status: 'directive' | 'contract' | 'kept' | 'new';
  comment: Comment;
}

function inspect(
  path: string,
  kept: Kept,
  forwarding: Set<string>,
): { text: string; found: Found[]; gone: string[] } | null {
  const language = languageOf(path);
  if (!language || !existsSync(resolve(repo, path))) return null;
  const text = readFileSync(resolve(repo, path), 'utf8');
  const { comments, contract } = scan(text, path, language, forwarding);
  const allowed = [...(kept[path] ?? [])];
  const found = comments
    .sort((a, b) => a.start - b.start)
    .map((comment): Found => {
      const raw = text.slice(comment.start, comment.end);
      const body = textOf(raw);
      const line = text.slice(0, comment.start).split('\n').length;
      let status: Found['status'] = 'new';
      if (isDirective(raw, path, language, comment.start)) status = 'directive';
      else if (contract.has(comment)) status = 'contract';
      else if (allowed.includes(body)) {
        allowed.splice(allowed.indexOf(body), 1);
        status = 'kept';
      }
      return { path, line, raw, text: body, status, comment };
    });
  return { text, found, gone: allowed };
}

function files(paths: string[]): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...paths], {
    cwd: repo,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

const isBlank = (line: string | undefined) => line?.trim() === '';

function strip(text: string, doomed: Comment[]): string {
  let out = text;
  for (const c of [...doomed].sort((a, b) => b.start - a.start)) {
    const [start, end] = c.removal ?? [c.start, c.end];
    const lineStart = out.lastIndexOf('\n', start - 1) + 1;
    const stop = lineEnd(out, end);
    const left = out.slice(lineStart, start);
    const right = out.slice(end, stop);
    if (left.trim() === '' && right.trim() === '') {
      const head = out.slice(0, lineStart);
      let tail = out.slice(Math.min(stop + 1, out.length));
      const prev = head.endsWith('\n') ? head.slice(head.lastIndexOf('\n', head.length - 2) + 1, -1) : undefined;
      const next = tail.slice(0, lineEnd(tail, 0));
      const prevBlank = head === '' || isBlank(prev);
      if (prevBlank && isBlank(next) && tail.includes('\n')) tail = tail.slice(tail.indexOf('\n') + 1);
      else if (prev !== undefined && /[{([]\s*$/.test(prev) && isBlank(next) && tail.includes('\n')) {
        tail = tail.slice(tail.indexOf('\n') + 1);
      } else if (isBlank(prev) && /^\s*[})\]]/.test(next)) {
        out = head.slice(0, head.length - prev!.length - 1) + tail;
        continue;
      }
      out = head + tail;
    } else if (right.trim() === '') {
      out = out.slice(0, lineStart) + left.trimEnd() + out.slice(stop);
    } else if (left.trim() === '') {
      out = out.slice(0, start) + right.trimStart() + out.slice(stop);
    } else {
      const l = out.slice(0, start).trimEnd();
      const r = out.slice(end).trimStart();
      out = l + (/[([{]$/.test(l) || /^[,;)\]}]/.test(r) ? '' : ' ') + r;
    }
  }
  return out;
}

const [command = 'check', ...rest] = process.argv.slice(2);
const keptPath = resolve(repo, KEPT_PATH);
const kept = existsSync(keptPath) ? (JSON.parse(readFileSync(keptPath, 'utf8')) as Kept) : {};
const forwarding = docForwardingMacros(files([]));
const scanned = files(rest).flatMap((path) => {
  const result = inspect(path, kept, forwarding);
  return result ? [{ path, ...result }] : [];
});

if (command === 'list') {
  for (const f of scanned.flatMap((r) => r.found)) {
    console.info(`${f.status.padEnd(9)} ${f.path}:${String(f.line)}  ${f.raw.split('\n').join('\n          ')}`);
  }
} else if (command === 'strip') {
  for (const { path, text, found } of scanned) {
    const doomed = found.filter((f) => f.status === 'new').map((f) => f.comment);
    if (doomed.length > 0) writeFileSync(resolve(repo, path), strip(text, doomed));
  }
} else if (command === 'check') {
  const fresh = scanned.flatMap((r) => r.found.filter((f) => f.status === 'new'));
  const scannedPaths = new Set(scanned.map((r) => r.path));
  const gone = [
    ...scanned.flatMap((r) => r.gone.map((text) => `${r.path}  ${text}`)),
    ...(rest.length > 0 ? [] : Object.keys(kept).filter((path) => !scannedPaths.has(path))),
  ];
  for (const f of fresh) console.error(`${f.path}:${String(f.line)}  ${f.text.slice(0, 120)}`);
  for (const g of gone) console.error(`${KEPT_PATH} lists a comment that is gone: ${g.slice(0, 160)}`);
  if (fresh.length > 0 || gone.length > 0) {
    console.error(
      `\n${String(fresh.length)} comment(s) not in ${KEPT_PATH}, ${String(gone.length)} stale entr(ies). See "Comments" in AGENTS.md.`,
    );
    process.exit(1);
  }
} else {
  console.error('usage: bun scripts/comments.ts [check|list|strip] [paths…]');
  process.exit(2);
}
