import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..');
const script = join(repo, 'scripts/cloud-session-setup.sh');
const settings = JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8')) as {
  hooks?: {
    SessionStart?: { matcher?: string; hooks?: { command?: string; args?: string[] }[] }[];
  };
};
const tauriLinux = readFileSync(join(repo, '.github/actions/tauri-linux/action.yml'), 'utf8');
const setup = readFileSync(script, 'utf8');

describe('cloud session setup', () => {
  it('exits immediately outside Claude Code cloud', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: repo, PS4: '+ ' };
    delete env.CLAUDE_CODE_REMOTE;
    const result = spawnSync('bash', ['-x', script], {
      cwd: repo,
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const ran = result.stderr.trim().split('\n');
    expect(ran).toHaveLength(3);
    expect(ran.at(-1)).toBe('+ exit 0');
  });

  it('runs from .claude/settings.json on SessionStart in the cloud', () => {
    const hooks = settings.hooks?.SessionStart ?? [];
    expect(hooks.some((group) => group.matcher === 'startup|resume')).toBe(true);
    const commands = hooks.flatMap((group) => group.hooks ?? []);
    expect(
      commands.some(
        (hook) =>
          hook.command === 'bash' && (hook.args ?? []).includes('${CLAUDE_PROJECT_DIR}/scripts/cloud-session-setup.sh'),
      ),
    ).toBe(true);
    expect(setup).toMatch(/CLAUDE_CODE_REMOTE/);
    expect(setup).toMatch(/rustup/);
    expect(setup).toMatch(/bun\.sh\/install/);
    expect(setup).toMatch(/get\.nexte\.st\/0\.9\.150\/linux/);
    expect(setup).toMatch(/CLAUDE_ENV_FILE/);
  });

  it('installs the same Tauri Linux packages CI uses', () => {
    const listed = /\bpkgs=\(([\s\S]*?)\)/.exec(tauriLinux)?.[1] ?? '';
    const fromCi = listed.split(/\s+/).filter((token) => /^[a-z0-9][a-z0-9.+-]*$/i.test(token));
    expect(fromCi.length).toBeGreaterThan(0);
    for (const pkg of new Set(fromCi)) {
      expect(setup, pkg).toContain(pkg);
    }
    expect(setup).toContain('build-essential');
  });
});
