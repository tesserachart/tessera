import { downloads, LINUX_DEB_PATH, PLATFORM_NAMES, type Platform } from '@tessera/ui/downloads';

interface InstallRow {
  label: string;
  command?: string;
  note?: string;
  download?: string;
}

export interface InstallTab {
  platform: Platform;
  name: string;
  rows: InstallRow[];
}

const TAB_ORDER: readonly Platform[] = ['mac', 'windows', 'linux'];

function rowsFor(platform: Platform, url: string, meta: string, base: string): InstallRow[] {
  switch (platform) {
    case 'mac':
      return [
        { label: 'Terminal', command: `curl -fLo ~/Downloads/Tessera.dmg ${url} && open ~/Downloads/Tessera.dmg` },
        { label: 'Download', note: meta, download: url },
      ];
    case 'windows':
      return [
        {
          label: 'PowerShell',
          command: `iwr ${url} -OutFile "$env:TEMP\\Tessera-setup.exe"; & "$env:TEMP\\Tessera-setup.exe"`,
        },
        { label: 'Download', note: meta, download: url },
      ];
    case 'linux':
      return [
        {
          label: 'AppImage',
          command: `curl -fLo ~/Tessera.AppImage ${url} && chmod +x ~/Tessera.AppImage && ~/Tessera.AppImage`,
        },
        {
          label: 'Debian, Ubuntu',
          command: `curl -fLo /tmp/tessera.deb ${base}/${LINUX_DEB_PATH} && sudo apt install /tmp/tessera.deb`,
        },
        { label: 'Download', note: 'x86_64 AppImage', download: url },
      ];
  }
}

export function installTabs(updatesUrl: string, published: readonly Platform[]): InstallTab[] {
  const base = updatesUrl.replace(/\/+$/, '');
  const builds = downloads(base, published);
  return TAB_ORDER.map((platform) => {
    const build = builds.find((b) => b.platform === platform);
    return {
      platform,
      name: PLATFORM_NAMES[platform],
      rows: build ? rowsFor(platform, build.url, build.meta, base) : [],
    };
  });
}

export function firstTabWithRows(tabs: readonly InstallTab[]): Platform {
  return (tabs.find((t) => t.rows.length > 0) ?? tabs[0]!).platform;
}
