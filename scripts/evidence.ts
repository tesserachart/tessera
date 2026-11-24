import { execFileSync } from 'node:child_process';

const EVIDENCE_FOLDER = /^(pr-[^/]*|docs\/pr)\//i;
const MEDIA = /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|heic|mp4|m4v|mov|webm|mkv|avi)$/i;
export const ASSET_FOLDERS = [
  'apps/*/public/',
  'apps/*/src/assets/',
  'apps/desktop/src-tauri/icons/',
  'apps/desktop/src-tauri/dmg/',
  'packages/ui/brand/',
  'packages/ui/icons/',
] as const;

const folderPattern = (folder: string) => new RegExp(`^${folder.replaceAll('*', '[^/]+')}`);
const assetFolders = ASSET_FOLDERS.map(folderPattern);

const isAsset = (path: string) => assetFolders.some((folder) => folder.test(path));

export function misplacedEvidence(added: readonly string[]): string[] {
  return added.filter((path) => EVIDENCE_FOLDER.test(path) || (MEDIA.test(path) && !isAsset(path)));
}

function git(repo: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function baseCommit(repo: string): string | null {
  return git(repo, 'merge-base', 'HEAD', 'origin/main') ?? git(repo, 'rev-parse', '--verify', '--quiet', 'HEAD^1');
}

export function addedFiles(repo: string, base: string): string[] {
  const out = git(repo, 'diff', '--cached', '--name-only', '--no-renames', '--diff-filter=A', '-z', base);
  return (out ?? '').split('\0').filter(Boolean);
}

export function report(misplaced: readonly string[]): string {
  return [
    'Screenshots, GIFs and videos that prove a pull request go in its body, never in the repository:',
    ...misplaced.map((path) => `  ${path}`),
    `Media the app ships lives in ${ASSET_FOLDERS.join(', ')}.`,
  ].join('\n');
}

if (import.meta.main) {
  const repo = process.cwd();
  const base = baseCommit(repo);
  if (base === null) {
    console.info('No base commit to compare against; nothing to check.');
    process.exit(0);
  }
  const misplaced = misplacedEvidence(addedFiles(repo, base));
  if (misplaced.length > 0) {
    console.error(report(misplaced));
    process.exit(1);
  }
  console.info(`No pull request evidence added since ${base.slice(0, 12)}.`);
}
