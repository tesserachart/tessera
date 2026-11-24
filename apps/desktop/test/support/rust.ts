import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function crateSource(path: string): string {
  return readFileSync(join(import.meta.dirname, '../../../../crates', path), 'utf8');
}

function rustConst(path: string, name: string): string {
  const found = new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))? )?const ${name}: [^=]+= ([^;]+);`, 'm').exec(crateSource(path));
  if (!found) throw new Error(`no const ${name} in crates/${path}`);
  return found[1]!.trim();
}

export function rustNumber(path: string, name: string): number {
  return rustConst(path, name)
    .split('*')
    .reduce((n, factor) => n * Number(factor.replace(/_/g, '').trim()), 1);
}

export function rustLiteral(path: string, name: string): unknown {
  return JSON.parse(
    rustConst(path, name)
      .replace(/(\d)_(\d)/g, '$1$2')
      .replace(/^\((.*)\)$/s, '[$1]'),
  );
}

export function rustStrings(path: string, name: string): string[] {
  return [...rustConst(path, name).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}
