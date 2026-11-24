import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { realDir, rustcWrapper } from './runtime-bin.ts';

export function devDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local/share'), 'tessera-dev');
}

export function devDataDir(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = realDir(repoRoot);
  const name = basename(path).replace(/[^A-Za-z0-9._-]+/g, '-') || 'checkout';
  const hash = createHash('sha256').update(path).digest('hex').slice(0, 8);
  return join(devDataRoot(env), `${name}-${hash}`);
}

function devConfigDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(env.HOME ?? homedir(), '.config'), 'tessera');
}

function devClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(devConfigDir(env), 'claude-home');
}

export function devCredentialsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(devConfigDir(env), 'credentials.env');
}

export function devRithmicDirectoryFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(devConfigDir(env), 'rithmic-directory');
}

export function withRithmicDirectory(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.TESSERA_RITHMIC_DIRECTORY?.trim()) return env;
  let text: string;
  try {
    text = readFileSync(devRithmicDirectoryFile(env), 'utf8');
  } catch {
    return env;
  }
  const addresses = text
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .flatMap((line) => line.split(/[\s,]+/))
    .filter(Boolean);
  return addresses.length > 0 ? { ...env, TESSERA_RITHMIC_DIRECTORY: addresses.join(',') } : env;
}

export interface DevRuntimeEnv {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  rithmicCredentials: string | null;
}

export function devRuntimeEnv(repoRoot: string, env: NodeJS.ProcessEnv = process.env): DevRuntimeEnv {
  const out: NodeJS.ProcessEnv = withRithmicDirectory({ ...env, RUSTC_WRAPPER: rustcWrapper(env) });
  const given = env.TESSERA_RITHMIC_CREDENTIALS;
  const own = devCredentialsFile(env);
  const rithmicCredentials = given !== undefined ? given || null : existsSync(own) ? own : null;
  if (rithmicCredentials) out.TESSERA_RITHMIC_CREDENTIALS = rithmicCredentials;
  else delete out.TESSERA_RITHMIC_CREDENTIALS;
  const claudeHome = env.TESSERA_CLAUDE_CONFIG_DIR;
  out.TESSERA_CLAUDE_CONFIG_DIR = claudeHome !== undefined && claudeHome !== '' ? claudeHome : devClaudeHome(env);
  const explicit = env.TESSERA_DATA_DIR;
  const dataDir = explicit !== undefined && explicit !== '' ? explicit : devDataDir(repoRoot, env);
  out.TESSERA_DATA_DIR = dataDir;
  return { env: out, dataDir, rithmicCredentials };
}

export function loginWords(rithmicCredentials: string | null): string {
  return rithmicCredentials
    ? `Rithmic login from ${rithmicCredentials}`
    : 'no Rithmic login (nothing to chart until one is connected)';
}

const LEGACY_ENTRIES = ['tessera.db', 'tessera.db-wal', 'tessera.db-shm', 'tessera.lock', 'blobs', 'logs', 'ticks'];

export function legacyDevData(root: string): string[] {
  return LEGACY_ENTRIES.filter((name) => existsSync(join(root, name)));
}

export function legacyDevDataNote(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = devDataRoot(env);
  const found = legacyDevData(root);
  if (found.length === 0) return null;
  return (
    `${root} still holds data from the earlier shared layout (${found.join(', ')}); nothing uses it now, ` +
    `each checkout has its own directory below it. To reclaim the space: cd ${root} && rm -r ${found.join(' ')}`
  );
}
