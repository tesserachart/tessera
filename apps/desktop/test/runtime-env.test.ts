// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  devCredentialsFile,
  devDataDir,
  devDataRoot,
  devRithmicDirectoryFile,
  devRuntimeEnv,
  legacyDevData,
  legacyDevDataNote,
  loginWords,
  withRithmicDirectory,
} from '../dev/runtime-env.ts';
import { rustcWrapper } from '../dev/runtime-bin.ts';

describe('development runtime defaults', () => {
  it('uses a separate dev data directory by default', () => {
    const r = devRuntimeEnv('/work/tessera', { HOME: '/home/u' });
    expect(r.dataDir).toMatch(/\/\.local\/share\/tessera-dev\/tessera-[0-9a-f]{8}$/);
    expect(r.env.TESSERA_DATA_DIR).toBe(r.dataDir);
    expect(r.env.TESSERA_CLAUDE_CONFIG_DIR).toBe('/home/u/.config/tessera/claude-home');
    expect(devRuntimeEnv('/w', { TESSERA_CLAUDE_CONFIG_DIR: '/c' }).env.TESSERA_CLAUDE_CONFIG_DIR).toBe('/c');
  });

  it('builds through sccache only when it is installed', () => {
    expect(rustcWrapper({}, () => true)).toBe('sccache');
    expect(rustcWrapper({}, () => false)).toBe('');
    expect(rustcWrapper({ RUSTC_WRAPPER: '' }, () => true)).toBe('');
    expect(rustcWrapper({ RUSTC_WRAPPER: 'other' }, () => false)).toBe('other');
  });

  it('honours explicit settings', () => {
    const r = devRuntimeEnv('/work/tessera', { TESSERA_DATA_DIR: '/tmp/x', RUSTC_WRAPPER: '' });
    expect(r.dataDir).toBe('/tmp/x');
    expect(r.env.RUSTC_WRAPPER).toBe('');
  });

  it("connects the developer's own Rithmic login from outside the repository", () => {
    const xdg = mkdtempSync(join(tmpdir(), 'tessera-config-'));
    onTestFinished(() => {
      rmSync(xdg, { recursive: true, force: true });
    });
    const env = { XDG_CONFIG_HOME: xdg, HOME: '/home/u' };
    const file = devCredentialsFile(env);
    expect(file).toBe(join(xdg, 'tessera/credentials.env'));
    expect(devCredentialsFile({ HOME: '/home/u' })).toBe('/home/u/.config/tessera/credentials.env');
    const none = devRuntimeEnv('/work/tessera', env);
    expect(none.rithmicCredentials).toBeNull();
    expect('TESSERA_RITHMIC_CREDENTIALS' in none.env).toBe(false);
    expect(loginWords(null)).toContain('no Rithmic login');
    mkdirSync(join(xdg, 'tessera'));
    writeFileSync(file, '', { mode: 0o600 });
    const own = devRuntimeEnv('/work/tessera', env);
    expect(own.rithmicCredentials).toBe(file);
    expect(own.env.TESSERA_RITHMIC_CREDENTIALS).toBe(file);
    expect(loginWords(file)).toBe(`Rithmic login from ${file}`);
    expect(devRuntimeEnv('/w', { ...env, TESSERA_RITHMIC_CREDENTIALS: '/elsewhere.env' }).rithmicCredentials).toBe(
      '/elsewhere.env',
    );
    const off = devRuntimeEnv('/w', { ...env, TESSERA_RITHMIC_CREDENTIALS: '' });
    expect(off.rithmicCredentials).toBeNull();
    expect('TESSERA_RITHMIC_CREDENTIALS' in off.env).toBe(false);
  });

  it('follows an absolute XDG_DATA_HOME and ignores a relative one', () => {
    expect(devDataRoot({ XDG_DATA_HOME: '/data' })).toBe('/data/tessera-dev');
    expect(devDataDir('/work/tessera', { XDG_DATA_HOME: '/data' })).toMatch(
      /^\/data\/tessera-dev\/tessera-[0-9a-f]{8}$/,
    );
    expect(devDataRoot({ XDG_DATA_HOME: 'rel' })).not.toContain('rel/');
  });

  it('gives every checkout and worktree its own data directory', () => {
    const env = { XDG_DATA_HOME: '/data' };
    const main = devDataDir('/work/tessera', env);
    const worktree = devDataDir('/work/tessera-wt/found-ts', env);
    const sameName = devDataDir('/elsewhere/tessera', env);
    expect(new Set([main, worktree, sameName]).size).toBe(3);
    expect(worktree).toMatch(/\/found-ts-[0-9a-f]{8}$/);
    expect(devDataDir('/work/tessera/', env)).toBe(main);
    expect(devDataDir('/work/x/../tessera', env)).toBe(main);
  });
});

describe('Rithmic’s directory in development', () => {
  const A = 'wss://directory-a.invalid:443';
  const B = 'wss://directory-b.invalid:443';

  it('comes from the config file outside the repository when the variable is unset', () => {
    const xdg = mkdtempSync(join(tmpdir(), 'tessera-config-'));
    onTestFinished(() => {
      rmSync(xdg, { recursive: true, force: true });
    });
    const env = { XDG_CONFIG_HOME: xdg, HOME: '/home/u' };
    expect(devRithmicDirectoryFile(env)).toBe(join(xdg, 'tessera/rithmic-directory'));
    expect(withRithmicDirectory(env).TESSERA_RITHMIC_DIRECTORY).toBeUndefined();
    mkdirSync(join(xdg, 'tessera'));
    writeFileSync(devRithmicDirectoryFile(env), `# Rithmic's directory\n${A}, ${B} # both answer\n\n`);
    expect(withRithmicDirectory(env).TESSERA_RITHMIC_DIRECTORY).toBe(`${A},${B}`);
    expect(devRuntimeEnv('/work/tessera', env).env.TESSERA_RITHMIC_DIRECTORY).toBe(`${A},${B}`);
    expect(withRithmicDirectory({ ...env, TESSERA_RITHMIC_DIRECTORY: B }).TESSERA_RITHMIC_DIRECTORY).toBe(B);
    expect(withRithmicDirectory({ ...env, TESSERA_RITHMIC_DIRECTORY: ' ' }).TESSERA_RITHMIC_DIRECTORY).toBe(
      `${A},${B}`,
    );
    writeFileSync(devRithmicDirectoryFile(env), '# none yet\n');
    expect(withRithmicDirectory(env).TESSERA_RITHMIC_DIRECTORY).toBeUndefined();
  });

  it('is looked for under ~/.config without XDG_CONFIG_HOME', () => {
    expect(devRithmicDirectoryFile({ HOME: '/home/u' })).toBe('/home/u/.config/tessera/rithmic-directory');
    expect(withRithmicDirectory({ HOME: '/nonexistent-home' }).TESSERA_RITHMIC_DIRECTORY).toBeUndefined();
  });
});

describe('leftovers of the earlier shared dev data layout', () => {
  it('are found in the dev data root and named, never in a checkout directory', () => {
    const xdg = mkdtempSync(join(tmpdir(), 'tessera-xdg-'));
    onTestFinished(() => {
      rmSync(xdg, { recursive: true, force: true });
    });
    const env = { XDG_DATA_HOME: xdg };
    const root = devDataRoot(env);
    mkdirSync(devDataDir('/work/tessera', env), { recursive: true });
    expect(legacyDevData(root)).toEqual([]);
    expect(legacyDevDataNote(env)).toBeNull();
    writeFileSync(join(root, 'tessera.db'), '');
    mkdirSync(join(root, 'blobs'));
    mkdirSync(join(root, 'logs'));
    expect(legacyDevData(root)).toEqual(['tessera.db', 'blobs', 'logs']);
    const note = legacyDevDataNote(env) ?? '';
    expect(note).toContain(root);
    expect(note).toContain('rm -r tessera.db blobs logs');
    expect(note).not.toContain(devDataDir('/work/tessera', env));
  });
});
