import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const MAIN = 'origin/main';
const BRANCHES = 'refs/remotes/origin/';
const STACK_LABEL = 'stack';

export interface Carried {
  branch: string;
  commits: number;
}

export interface Base {
  behind: number;
  carried: Carried[];
  newestCarried: string | null;
}

function git(repo: string, ...args: string[]): string[] {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
}

function otherBranchesContaining(repo: string, commit: string): string[] {
  return git(repo, 'for-each-ref', '--format=%(refname)', '--contains', commit, BRANCHES)
    .filter((ref) => ref !== `${BRANCHES}main` && ref !== `${BRANCHES}HEAD`)
    .map((ref) => ref.slice(BRANCHES.length));
}

export function readBase(repo: string): Base {
  const behind = Number(git(repo, 'rev-list', '--count', `HEAD..${MAIN}`)[0]);
  const stackedOnHead = new Set(otherBranchesContaining(repo, 'HEAD'));
  const counts = new Map<string, number>();
  let newestCarried: string | null = null;
  for (const commit of git(repo, 'rev-list', '--topo-order', 'HEAD', `^${MAIN}`)) {
    const owners = otherBranchesContaining(repo, commit).filter((branch) => !stackedOnHead.has(branch));
    if (owners.length > 0) newestCarried ??= commit;
    for (const branch of owners) counts.set(branch, (counts.get(branch) ?? 0) + 1);
  }
  const carried = [...counts]
    .map(([branch, commits]) => ({ branch, commits }))
    .sort((a, b) => b.commits - a.commits || a.branch.localeCompare(b.branch));
  return { behind, carried, newestCarried };
}

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

export function judge(base: Base, maxBehind: number, labels: readonly string[]): { ok: boolean; report: string } {
  const stale = base.behind > maxBehind;
  const facts = [
    `${plural(base.behind, 'commit')} behind ${MAIN} (at most ${String(maxBehind)})`,
    ...base.carried.map(
      ({ branch, commits }) => `carries ${plural(commits, 'commit')} from ${branch}, a branch main does not have`,
    ),
  ];
  if (!stale && base.carried.length === 0) return { ok: true, report: `Fresh base: ${facts.join('; ')}.` };
  if (labels.includes(STACK_LABEL)) {
    return { ok: true, report: `Labelled ${STACK_LABEL}, so a stacked base passes: ${facts.join('; ')}.` };
  }
  const rebase = base.newestCarried
    ? `git rebase --onto ${MAIN} ${base.newestCarried.slice(0, 12)}`
    : `git rebase ${MAIN}`;
  return {
    ok: false,
    report: [
      'This branch is built on a stale base:',
      ...facts.map((fact) => `  - ${fact}`),
      `Rebase it on ${MAIN}${base.newestCarried ? ', leaving the other branch’s commits behind' : ''}:`,
      '  git fetch origin main',
      `  ${rebase}`,
      '  git push --force-with-lease',
      `For a deliberate stack, label the pull request "${STACK_LABEL}" and this check passes.`,
    ].join('\n'),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { 'max-behind': { type: 'string' }, labels: { type: 'string', default: '' } },
  });
  const maxBehind = Number(values['max-behind']);
  if (!Number.isInteger(maxBehind) || maxBehind < 0) {
    console.error('usage: bun scripts/stale-base.ts --max-behind <commits> [--labels <one label per line>]');
    process.exit(2);
  }
  const { ok, report } = judge(readBase(process.cwd()), maxBehind, values.labels.split('\n'));
  if (ok) console.info(report);
  else console.error(report);
  process.exit(ok ? 0 : 1);
}
