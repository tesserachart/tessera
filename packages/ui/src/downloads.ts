import { type FirstOpen, LINUX_FIRST_OPEN, MAC_FIRST_OPEN, WINDOWS_FIRST_OPEN } from './firstOpen.ts';

export type Platform = 'mac' | 'windows' | 'linux';

export const PLATFORM_NAMES: Record<Platform, string> = { mac: 'Mac', windows: 'Windows', linux: 'Linux' };

export interface Download {
  platform: Platform;
  meta: string;
  url: string;
  firstOpen: FirstOpen;
}

export const RELEASE_DOWNLOADS: readonly (Omit<Download, 'url'> & { path: string })[] = [
  {
    platform: 'mac',
    meta: 'Apple silicon, macOS 13 or later',
    path: 'mac/Tessera-latest-mac-arm64.dmg',
    firstOpen: MAC_FIRST_OPEN,
  },
  {
    platform: 'windows',
    meta: 'Windows 10 or 11, x64',
    path: 'windows/Tessera-latest-windows-x64-setup.exe',
    firstOpen: WINDOWS_FIRST_OPEN,
  },
  {
    platform: 'linux',
    meta: 'x86_64, AppImage or .deb',
    path: 'linux/Tessera-latest-linux-amd64.AppImage',
    firstOpen: LINUX_FIRST_OPEN,
  },
];

export const LINUX_DEB_PATH = 'linux/Tessera-latest-linux-amd64.deb';

export function publishedPlatforms(list: string): Platform[] {
  const named = new Set(list.split(',').map((p) => p.trim()));
  return (Object.keys(PLATFORM_NAMES) as Platform[]).filter((p) => named.has(p));
}

export function downloads(updatesUrl: string, published: readonly Platform[]): Download[] {
  const base = updatesUrl.replace(/\/+$/, '');
  if (base === '') return [];
  return RELEASE_DOWNLOADS.filter((d) => published.includes(d.platform)).map(({ path, ...build }) => ({
    ...build,
    url: `${base}/${path}`,
  }));
}

export function chosenFirst(all: readonly Download[], platform: Platform | null): Download[] {
  return [...all].sort((a, b) => Number(b.platform === platform) - Number(a.platform === platform));
}
