import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { RELEASE_DOWNLOADS, LINUX_DEB_PATH } from '../packages/ui/src/downloads.ts';
import {
  nextVersion,
  PLATFORMS,
  publish,
  retried,
  stage,
  staleVersions,
  versionOrder,
  type Platform,
} from './channel.ts';

const BUILT: Record<Platform, [string, string][]> = {
  mac: [
    ['macos', 'Tessera.app.tar.gz'],
    ['dmg', 'Tessera_0.1.0_aarch64.dmg'],
  ],
  linux: [
    ['appimage', 'Tessera_0.1.0_amd64.AppImage'],
    ['deb', 'Tessera_0.1.0_amd64.deb'],
  ],
  windows: [['nsis', 'Tessera_0.1.0_x64-setup.exe']],
};

let work: string;
let info: MockInstance<typeof console.info>;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'channel-'));
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  info.mockRestore();
  rmSync(work, { recursive: true, force: true });
});

function built(platform: Platform): string {
  const dir = join(work, 'bundle', platform);
  for (const [sub, name] of BUILT[platform]) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, name), 'bundle');
    writeFileSync(join(dir, sub, `${name}.sig`), `signature of ${name}\n`);
  }
  return dir;
}

function staged(platform: Platform, version: string) {
  return stage(
    new Map([
      ['platform', platform],
      ['version', version],
      ['bundles', built(platform)],
      ['out', join(work, 'staged', platform)],
    ]),
  );
}

function dryRun(platforms: string) {
  info.mockClear();
  publish(
    new Map([
      ['platforms', platforms],
      ['commit', 'c0ffee00c0ffee00'],
      ['staged', join(work, 'staged')],
      ['dry-run', 'true'],
    ]),
  );
  return info.mock.calls.map(([line]) => String(line));
}

const uploads = (lines: string[]) =>
  lines
    .filter((l) => l.startsWith('would run: aws s3 cp'))
    .map((l) => l.split(' ')[6]!.replace('s3://<R2_BUCKET>/', ''));

describe('versions', () => {
  it('order by their numbers, never as text', () => {
    expect(versionOrder('0.2.0-alpha.42')).toEqual([0, 2, 0, 42]);
    expect(versionOrder('0.1.0-beta.5')).toBeNull();
    expect(versionOrder('0.2.0-alpha.4+abc')).toBeNull();
  });

  it('keep the newest three', () => {
    const listed = [
      '0.2.0-alpha.9',
      '0.2.0-alpha.10',
      '0.2.0-alpha.8',
      '0.1.0-beta.7',
      'notes',
      '0.3.0-alpha.1',
      '0.2.0-alpha.11',
    ];
    expect(staleVersions(listed)).toEqual(['0.2.0-alpha.9', '0.2.0-alpha.8']);
    expect(staleVersions(['0.2.0-alpha.1', '0.2.0-alpha.2'])).toEqual([]);
  });

  it('build the next one above every platform’s published one', () => {
    expect(nextVersion('0.2.0', ['0.2.0-alpha.1', '0.2.0-alpha.9', '0.1.0-beta.7'])).toBe('0.2.0-alpha.10');
    expect(nextVersion('0.2.0', [])).toBe('0.2.0-alpha.1');
    expect(nextVersion('0.3.0', ['0.2.0-alpha.9'])).toBe('0.3.0-alpha.1');
    expect(nextVersion('0.2.0-alpha.1', ['0.3.0-alpha.2'])).toBe('0.3.0-alpha.3');
  });

  it('refuse one that is not an alpha', () => {
    expect(() => staged('linux', '0.1.0-beta.3')).toThrow('is not X.Y.Z-alpha.N');
  });
});

describe('a release', () => {
  it('keeps the Mac’s bucket paths, which installed builds already poll', () => {
    staged('mac', '0.2.0-alpha.1');
    expect(uploads(dryRun('mac'))).toEqual([
      'mac/0.2.0-alpha.1/Tessera.app.tar.gz',
      'mac/0.2.0-alpha.1/Tessera-0.2.0-alpha.1-mac-arm64.dmg',
      'mac/Tessera-latest-mac-arm64.dmg',
      'mac/latest.json',
    ]);
  });

  it('uploads every platform’s files before any platform’s latest.json moves', () => {
    for (const platform of Object.keys(PLATFORMS) as Platform[]) staged(platform, '0.2.0-alpha.1');
    const keys = uploads(dryRun('windows,mac,linux'));
    const versioned = keys.filter((k) => k.includes('/0.2.0-alpha.1/'));
    expect(versioned.sort()).toEqual([
      'linux/0.2.0-alpha.1/Tessera-0.2.0-alpha.1-linux-amd64.AppImage',
      'linux/0.2.0-alpha.1/Tessera-0.2.0-alpha.1-linux-amd64.deb',
      'mac/0.2.0-alpha.1/Tessera-0.2.0-alpha.1-mac-arm64.dmg',
      'mac/0.2.0-alpha.1/Tessera.app.tar.gz',
      'windows/0.2.0-alpha.1/Tessera-0.2.0-alpha.1-windows-x64-setup.exe',
    ]);
    expect(keys.slice(0, versioned.length)).toEqual(expect.arrayContaining(versioned));
    expect(keys.filter((k) => k.endsWith('/latest.json')).sort()).toEqual([
      'linux/latest.json',
      'mac/latest.json',
      'windows/latest.json',
    ]);
    for (const platform of ['linux', 'mac', 'windows']) {
      const own = keys.filter((k) => k.startsWith(`${platform}/`));
      expect(own.at(-1), platform).toBe(`${platform}/latest.json`);
    }
  });

  it('points each platform’s updater at its signed bundle', () => {
    for (const platform of Object.keys(PLATFORMS) as Platform[]) staged(platform, '0.2.0-alpha.1');
    dryRun('mac,linux,windows');
    const latest = JSON.parse(readFileSync(join(work, 'staged', 'windows', 'latest.json'), 'utf8')) as {
      version: string;
      commit: string;
      platforms: Record<string, { signature: string; url: string }>;
    };
    expect(latest.version).toBe('0.2.0-alpha.1');
    expect(latest.commit).toBe('c0ffee00c0ffee00');
    expect(latest.platforms).toEqual({
      'windows-x86_64': {
        signature: 'signature of Tessera_0.1.0_x64-setup.exe',
        url: '<UPDATES_URL>/windows/0.2.0-alpha.1/Tessera-0.2.0-alpha.1-windows-x64-setup.exe',
      },
      'windows-x86_64-nsis': {
        signature: 'signature of Tessera_0.1.0_x64-setup.exe',
        url: '<UPDATES_URL>/windows/0.2.0-alpha.1/Tessera-0.2.0-alpha.1-windows-x64-setup.exe',
      },
    });
  });

  it('publishes every file the site and the approval email link to', () => {
    for (const platform of Object.keys(PLATFORMS) as Platform[]) staged(platform, '0.2.0-alpha.1');
    const keys = uploads(dryRun('mac,linux,windows'));
    expect(keys).toEqual(expect.arrayContaining([...RELEASE_DOWNLOADS.map((d) => d.path), LINUX_DEB_PATH]));
  });

  it('publishes nothing unless every platform it ships was staged', () => {
    staged('mac', '0.2.0-alpha.1');
    staged('linux', '0.2.0-alpha.1');
    expect(() => dryRun('mac,linux,windows')).toThrow('expected staged builds for mac, linux, windows');
    expect(info.mock.calls.filter(([l]) => String(l).startsWith('would run'))).toEqual([]);
  });

  it('publishes nothing when the staged builds are of different versions', () => {
    staged('mac', '0.2.0-alpha.1');
    staged('linux', '0.2.0-alpha.2');
    expect(() => dryRun('mac,linux')).toThrow('not one version');
  });
});

describe('an upload to the update bucket', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function bucketThatDrops(failingKey: string, failures: number) {
    const bin = join(work, 'bin');
    mkdirSync(bin, { recursive: true });
    const log = join(work, 'aws.log');
    writeFileSync(
      join(bin, 'aws'),
      [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$FAKE_AWS_LOG"',
        `case "$*" in *"${failingKey} "*)`,
        `  tries=$(grep -c "${failingKey} " "$FAKE_AWS_LOG")`,
        `  if [ "$tries" -le ${String(failures)} ]; then`,
        '    echo "An error occurred (NoSuchUpload) when calling the CompleteMultipartUpload operation" >&2',
        '    exit 1',
        '  fi;;',
        'esac',
        'case "$1 $2" in "s3 cp") cp "$AWS_CONFIG_FILE" "$FAKE_AWS_LOG.config";; esac',
      ].join('\n'),
    );
    chmodSync(join(bin, 'aws'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    vi.stubEnv('R2_BUCKET', 'bucket');
    vi.stubEnv('R2_ACCOUNT_ID', 'account');
    vi.stubEnv('UPDATES_URL', 'https://updates.example');
    vi.stubEnv('FAKE_AWS_LOG', log);
    return log;
  }

  const publishAll = () =>
    publish(
      new Map([
        ['platforms', 'mac,linux,windows'],
        ['commit', 'c0ffee00c0ffee00'],
        ['staged', join(work, 'staged')],
      ]),
      [0, 0, 0],
    );

  const copiedKeys = (log: string) =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('s3 cp '))
      .map((l) => l.split(' ')[3]!.replace('s3://bucket/', ''));

  it.skipIf(process.platform === 'win32')(
    'retries a multipart upload R2 dropped and still publishes every platform',
    () => {
      for (const platform of Object.keys(PLATFORMS) as Platform[]) staged(platform, '0.2.0-alpha.1');
      const dmg = 'mac/0.2.0-alpha.1/Tessera-0.2.0-alpha.1-mac-arm64.dmg';
      const log = bucketThatDrops(dmg, 2);
      publishAll();
      const keys = copiedKeys(log);
      expect(keys.filter((k) => k === dmg)).toHaveLength(3);
      expect(new Set(keys)).toEqual(
        new Set([
          'linux/0.2.0-alpha.1/Tessera-0.2.0-alpha.1-linux-amd64.AppImage',
          'linux/0.2.0-alpha.1/Tessera-0.2.0-alpha.1-linux-amd64.deb',
          dmg,
          'mac/0.2.0-alpha.1/Tessera.app.tar.gz',
          'windows/0.2.0-alpha.1/Tessera-0.2.0-alpha.1-windows-x64-setup.exe',
          'linux/Tessera-latest-linux-amd64.AppImage',
          'linux/Tessera-latest-linux-amd64.deb',
          'mac/Tessera-latest-mac-arm64.dmg',
          'windows/Tessera-latest-windows-x64-setup.exe',
          'linux/latest.json',
          'mac/latest.json',
          'windows/latest.json',
        ]),
      );
      expect(readFileSync(`${log}.config`, 'utf8')).toMatch(/multipart_chunksize = 64MB/);
    },
  );

  it.skipIf(process.platform === 'win32')('moves no latest.json when an upload keeps failing', () => {
    for (const platform of Object.keys(PLATFORMS) as Platform[]) staged(platform, '0.2.0-alpha.1');
    const log = bucketThatDrops('mac/0.2.0-alpha.1/Tessera-0.2.0-alpha.1-mac-arm64.dmg', 4);
    expect(publishAll).toThrow('Command failed');
    expect(copiedKeys(log).filter((k) => k.endsWith('latest.json'))).toEqual([]);
  });

  it('gives up after its last wait', () => {
    const waits: number[] = [];
    let tries = 0;
    const fail = () => {
      tries++;
      throw new Error('dropped');
    };
    expect(() => retried('upload', fail, [1, 2], (ms) => waits.push(ms))).toThrow('dropped');
    expect(tries).toBe(3);
    expect(waits).toEqual([1, 2]);
  });
});
