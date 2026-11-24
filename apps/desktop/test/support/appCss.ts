import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compile, optimize } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

const entry = join(import.meta.dirname, '../../../../packages/ui/src/styles/index.css');
const LAYERS = ['properties', 'theme', 'base', 'components', 'utilities'];
let built: Promise<string> | null = null;

function blockEnd(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return i;
  }
  return css.length;
}

// happy-dom ignores @layer blocks, so the layers are unwrapped in their cascade order ahead of the unlayered rules.
function unlayered(css: string): string {
  const layered = new Map<string, string[]>(LAYERS.map((name) => [name, []]));
  let rest = '';
  let at = 0;
  for (const match of css.matchAll(/@layer\s+([\w-]+)\s*(\{|;)|@layer\s+[\w\s,-]+;/g)) {
    if (match.index < at) continue;
    rest += css.slice(at, match.index);
    if (match[2] !== '{') {
      at = match.index + match[0].length;
      continue;
    }
    const open = match.index + match[0].length - 1;
    const close = blockEnd(css, open);
    layered.get(match[1] ?? '')?.push(css.slice(open + 1, close));
    at = close + 1;
  }
  rest += css.slice(at);
  return [...LAYERS.flatMap((name) => layered.get(name) ?? []), rest].join('\n');
}

async function build(): Promise<string> {
  const compiler = await compile(readFileSync(entry, 'utf8'), { base: dirname(entry), onDependency: () => {} });
  const scanner = new Scanner({ sources: compiler.sources });
  return unlayered(optimize(compiler.build(scanner.scan()), { minify: false }).code);
}

export function appCss(): Promise<string> {
  built ??= build();
  return built;
}
