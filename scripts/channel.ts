import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const tauriDir = join(repo, 'apps/desktop/src-tauri');

const NAME = 'Tessera';
const PRERELEASE = 'alpha';
const KEEP = 3;
export const S3_RETRY_WAITS_MS = [5_000, 15_000, 45_000];
const S3_PART_SIZE = '64MB';

interface Bundle {
  dir: string;
  suffix: string;
  file: (stem: string, version: string) => string;
  installer: boolean;
  updater: string[];
}

// The updater asks `{os}-{arch}-{bundle type}` first, then `{os}-{arch}`.
export const PLATFORMS = {
  mac: [
    {
      dir: 'macos',
      suffix: '.app.tar.gz',
      file: (stem) => `${stem}.app.tar.gz`,
      installer: false,
      updater: ['darwin-aarch64'],
    },
    { dir: 'dmg', suffix: '.dmg', file: (stem, v) => `${stem}-${v}-mac-arm64.dmg`, installer: true, updater: [] },
  ],
  linux: [
    {
      dir: 'appimage',
      suffix: '.AppImage',
      file: (stem, v) => `${stem}-${v}-linux-amd64.AppImage`,
      installer: true,
      updater: ['linux-x86_64', 'linux-x86_64-appimage'],
    },
    {
      dir: 'deb',
      suffix: '.deb',
      file: (stem, v) => `${stem}-${v}-linux-amd64.deb`,
      installer: true,
      updater: ['linux-x86_64-deb'],
    },
  ],
  windows: [
    {
      dir: 'nsis',
      suffix: '.exe',
      file: (stem, v) => `${stem}-${v}-windows-x64-setup.exe`,
      installer: true,
      updater: ['windows-x86_64', 'windows-x86_64-nsis'],
    },
  ],
} as const satisfies Record<string, readonly Bundle[]>;
export type Platform = keyof typeof PLATFORMS;

export interface Staged {
  platform: Platform;
  version: string;
  files: { name: string; latest: string | null }[];
  updater: Record<string, { name: string; signature: string }>;
}

const STAGED = 'staged.json';
const LATEST = 'latest';

function flags(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith('--')) throw new Error(`unexpected ${k}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) m.set(k.slice(2), 'true');
    else {
      m.set(k.slice(2), v);
      i++;
    }
  }
  return m;
}

function need(f: Map<string, string>, k: string): string {
  const v = f.get(k);
  if (!v) throw new Error(`--${k} is required`);
  return v;
}

function oneOf<T extends string>(what: string, value: string, options: Record<T, unknown>): T {
  if (!Object.hasOwn(options, value)) throw new Error(`--${what}: ${Object.keys(options).join(' or ')}`);
  return value as T;
}

const platformOf = (f: Map<string, string>) => oneOf('platform', need(f, 'platform'), PLATFORMS);

export function versionOrder(version: string): number[] | null {
  const m = new RegExp(`^(\\d+)\\.(\\d+)\\.(\\d+)-${PRERELEASE}\\.(\\d+)$`).exec(version);
  return m ? m.slice(1).map(Number) : null;
}

function versionOf(f: Map<string, string>): string {
  const version = need(f, 'version');
  if (!versionOrder(version)) throw new Error(`--version ${version} is not X.Y.Z-${PRERELEASE}.N`);
  return version;
}

function newestFirst(a: number[], b: number[]): number {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return b[i]! - a[i]!;
  return 0;
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function retried<T>(what: string, run: () => T, waitsMs = S3_RETRY_WAITS_MS, wait = sleep): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return run();
    } catch (e) {
      const waitMs = waitsMs[attempt];
      if (waitMs === undefined) throw e;
      console.info(
        `::warning::${what} failed (attempt ${String(attempt + 1)} of ${String(waitsMs.length + 1)}); retrying in ${String(waitMs / 1000)} s`,
      );
      wait(waitMs);
    }
  }
}

function s3Config(dir: string): string {
  const path = join(dir, 'aws-config');
  writeFileSync(
    path,
    `[default]\ns3 =\n  multipart_threshold = ${S3_PART_SIZE}\n  multipart_chunksize = ${S3_PART_SIZE}\n`,
  );
  return path;
}

export function staleVersions(versions: string[]): string[] {
  return versions
    .map((v) => ({ v, order: versionOrder(v) }))
    .filter((x): x is { v: string; order: number[] } => x.order !== null)
    .sort((a, b) => newestFirst(a.order, b.order))
    .slice(KEEP)
    .map((x) => x.v);
}

export function nextVersion(base: string, published: string[]): string {
  const floor = versionOrder(`${base.split('-')[0]}-${PRERELEASE}.0`);
  if (!floor) throw new Error(`${base} is not X.Y.Z`);
  const orders = published.map(versionOrder).filter((o): o is number[] => o !== null);
  const [major, minor, patch, n] = [floor, ...orders].sort(newestFirst)[0]!;
  return `${String(major)}.${String(minor)}.${String(patch)}-${PRERELEASE}.${String(n! + 1)}`;
}

const latestUrl = (base: string, platform: Platform) => `${base}/${platform}/latest.json`;
const updatesUrl = () => (process.env.UPDATES_URL ?? '').replace(/\/+$/, '');

async function publishedLatest(platform: Platform): Promise<{ commit?: unknown; version?: unknown } | null> {
  const base = updatesUrl();
  if (!base) return null;
  const res = await fetch(latestUrl(base, platform), { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${platform}/latest.json answered ${String(res.status)}`);
  return (await res.json()) as { commit?: unknown; version?: unknown };
}

async function changed(f: Map<string, string>) {
  const platform = platformOf(f);
  const commit = need(f, 'commit');
  const published = await publishedLatest(platform).catch(() => null);
  console.info(published?.commit === commit ? 'false' : 'true');
}

async function next() {
  const base = (JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8')) as { version: string }).version;
  const published: string[] = [];
  for (const platform of Object.keys(PLATFORMS) as Platform[]) {
    const version = (await publishedLatest(platform))?.version;
    if (typeof version === 'string') published.push(version);
  }
  console.info(nextVersion(base, published));
}

async function published() {
  const base = updatesUrl();
  if (!base) throw new Error('UPDATES_URL is not set');
  const found: Platform[] = [];
  for (const platform of Object.keys(PLATFORMS) as Platform[]) {
    const res = await fetch(latestUrl(base, platform), { method: 'HEAD', cache: 'no-store' });
    if (res.ok) found.push(platform);
    else if (res.status !== 404) throw new Error(`${platform}/latest.json answered ${String(res.status)}`);
  }
  if (found.length === 0) throw new Error(`no platform is published at ${base}`);
  console.info(found.join(','));
}

function config(f: Map<string, string>) {
  const platform = platformOf(f);
  const version = versionOf(f);
  const out = resolve(need(f, 'out'));
  const confPath = join(tauriDir, 'tauri.conf.json');
  const conf = JSON.parse(readFileSync(confPath, 'utf8')) as Record<string, unknown>;
  conf.version = version;
  writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);
  const base = updatesUrl();
  const endpoints = base ? [latestUrl(base, platform)] : [];
  const overlay = { bundle: { createUpdaterArtifacts: true }, plugins: { updater: { endpoints } } };
  writeFileSync(out, `${JSON.stringify(overlay, null, 2)}\n`);
  console.info(`version  ${version}`);
  console.info(`endpoint ${endpoints[0] ?? '(none: UPDATES_URL is not set)'}`);
}

export function stage(f: Map<string, string>): Staged {
  const platform = platformOf(f);
  const version = versionOf(f);
  const bundles = resolve(need(f, 'bundles'));
  const out = resolve(need(f, 'out'));
  mkdirSync(out, { recursive: true });
  const staged: Staged = { platform, version, files: [], updater: {} };
  for (const bundle of PLATFORMS[platform] as readonly Bundle[]) {
    const dir = join(bundles, bundle.dir);
    const found = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(bundle.suffix)) : [];
    if (found.length !== 1) throw new Error(`expected one *${bundle.suffix} in ${dir}, found ${String(found.length)}`);
    const from = join(dir, found[0]!);
    const name = bundle.file(NAME, version);
    copyFileSync(from, join(out, name));
    staged.files.push({ name, latest: bundle.installer ? bundle.file(NAME, LATEST) : null });
    if (bundle.updater.length > 0) {
      const signature = readFileSync(`${from}.sig`, 'utf8').trim();
      for (const key of bundle.updater) staged.updater[key] = { name, signature };
    }
    console.info(`stage: ${from} → ${name}`);
  }
  writeFileSync(join(out, STAGED), `${JSON.stringify(staged, null, 2)}\n`);
  return staged;
}

function readStaged(root: string): { dir: string; staged: Staged }[] {
  const dirs = existsSync(join(root, STAGED))
    ? [root]
    : readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(root, e.name, STAGED)))
        .map((e) => join(root, e.name));
  return dirs.map((dir) => ({ dir, staged: JSON.parse(readFileSync(join(dir, STAGED), 'utf8')) as Staged }));
}

function installers(f: Map<string, string>) {
  for (const { dir, staged } of readStaged(resolve(need(f, 'staged')))) {
    for (const file of staged.files.filter((x) => x.latest !== null)) console.info(join(dir, file.name));
  }
}

export function publish(f: Map<string, string>, s3RetryWaitsMs = S3_RETRY_WAITS_MS) {
  const platforms = need(f, 'platforms')
    .split(',')
    .map((p) => oneOf('platforms', p, PLATFORMS));
  const commit = need(f, 'commit');
  const dryRun = f.get('dry-run') === 'true';
  const all = readStaged(resolve(need(f, 'staged')));
  const found = all.map((s) => s.staged.platform).sort();
  if (found.join() !== [...platforms].sort().join()) {
    throw new Error(`expected staged builds for ${platforms.join(', ')}, found ${found.join(', ') || 'none'}`);
  }
  const versions = new Set(all.map((s) => s.staged.version));
  if (versions.size !== 1) {
    throw new Error(
      `the staged builds are not one version: ${all.map((s) => `${s.staged.platform} ${s.staged.version}`).join(', ')}`,
    );
  }
  const version = [...versions][0]!;
  const base = updatesUrl();
  const bucket = process.env.R2_BUCKET ?? '';
  const account = process.env.R2_ACCOUNT_ID ?? '';
  if (!dryRun && (!base || !bucket || !account)) {
    console.info(
      '::notice::No update bucket yet (R2 secrets and UPDATES_URL / R2_BUCKET variables): nothing published.',
    );
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'channel-'));
  const env = { ...process.env, AWS_CONFIG_FILE: s3Config(tmp) };
  const s3 = (...args: string[]) => {
    const command = ['s3', ...args, '--endpoint-url', `https://${account}.r2.cloudflarestorage.com`];
    if (dryRun) {
      console.info(`would run: aws ${command.slice(0, -2).join(' ').replaceAll('s3:///', 's3://<R2_BUCKET>/')}`);
      return '';
    }
    return retried(
      `aws s3 ${args.join(' ')}`,
      () => execFileSync('aws', command, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'inherit'] }),
      s3RetryWaitsMs,
    );
  };
  for (const { dir, staged } of all) {
    const at = staged.platform;
    for (const file of staged.files) s3('cp', join(dir, file.name), `s3://${bucket}/${at}/${version}/${file.name}`);
  }
  for (const { dir, staged } of all) {
    const at = staged.platform;
    for (const file of staged.files) {
      if (file.latest)
        s3('cp', join(dir, file.name), `s3://${bucket}/${at}/${file.latest}`, '--cache-control', 'no-cache');
    }
    const latestJson = {
      version,
      notes: `${NAME} ${version}, built from ${commit.slice(0, 8)}`,
      pub_date: new Date().toISOString(),
      commit,
      platforms: Object.fromEntries(
        Object.entries(staged.updater).map(([key, { name, signature }]) => [
          key,
          { signature, url: `${base || '<UPDATES_URL>'}/${at}/${version}/${name}` },
        ]),
      ),
    };
    const latestPath = join(tmp, `${staged.platform}-latest.json`);
    writeFileSync(latestPath, `${JSON.stringify(latestJson, null, 2)}\n`);
    s3(
      'cp',
      latestPath,
      `s3://${bucket}/${at}/latest.json`,
      '--cache-control',
      'no-cache',
      '--content-type',
      'application/json',
    );
    if (dryRun) {
      copyFileSync(latestPath, join(dir, 'latest.json'));
      console.info(readFileSync(latestPath, 'utf8'));
      continue;
    }
    const listed = s3('ls', `s3://${bucket}/${at}/`);
    const published = [...listed.matchAll(/^\s*PRE (\S+)\/$/gm)].map((m) => m[1]!);
    for (const old of staleVersions(published)) s3('rm', '--recursive', `s3://${bucket}/${at}/${old}/`);
    console.info(`published ${NAME} ${version} for ${staged.platform}`);
  }
}

const USAGE = [
  'usage: node scripts/channel.ts changed --platform P --commit SHA',
  '       node scripts/channel.ts next',
  '       node scripts/channel.ts published',
  '       node scripts/channel.ts config --platform P --version V --out FILE',
  '       node scripts/channel.ts stage --platform P --version V --bundles DIR --out DIR',
  '       node scripts/channel.ts installers --staged DIR',
  '       node scripts/channel.ts publish --platforms P,P --commit SHA --staged DIR [--dry-run]',
  `platforms: ${Object.keys(PLATFORMS).join(', ')}`,
].join('\n');

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (command === 'changed') return changed(f);
  if (command === 'next') return next();
  if (command === 'published') return published();
  if (command === 'config') return config(f);
  if (command === 'stage') return void stage(f);
  if (command === 'installers') return installers(f);
  if (command === 'publish') return publish(f);
  throw new Error(USAGE);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`channel: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
