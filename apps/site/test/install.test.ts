import { describe, expect, it } from 'vitest';

import { firstTabWithRows, installTabs } from '../src/lib/install.ts';

const BASE = 'https://updates.example';

describe('installTabs', () => {
  it('offers Mac, Windows and Linux in that order', () => {
    expect(installTabs(BASE, ['linux', 'mac']).map((t) => t.platform)).toEqual(['mac', 'windows', 'linux']);
  });

  it('gives a platform that is not published no command and no link', () => {
    const windows = installTabs(BASE, ['mac', 'linux']).find((t) => t.platform === 'windows')!;
    expect(windows.rows).toEqual([]);
  });

  it('gives every platform nothing when there is no release feed', () => {
    expect(installTabs('', ['mac', 'windows', 'linux']).every((t) => t.rows.length === 0)).toBe(true);
  });

  it('points every command and download at the release feed', () => {
    const rows = installTabs(`${BASE}/`, ['mac', 'windows', 'linux']).flatMap((t) => t.rows);
    for (const row of rows) {
      const urls = `${row.command ?? ''} ${row.download ?? ''}`.match(/https?:\/\/\S+/g) ?? [];
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url.startsWith(`${BASE}/`) && !url.startsWith(`${BASE}//`)).toBe(true);
    }
  });

  it('downloads the Mac disk image and opens it from the terminal', () => {
    const mac = installTabs(BASE, ['mac'])[0]!;
    expect(mac.rows.map((r) => r.label)).toEqual(['Terminal', 'Download']);
    expect(mac.rows[0]!.command).toBe(
      `curl -fLo ~/Downloads/Tessera.dmg ${BASE}/mac/Tessera-latest-mac-arm64.dmg && open ~/Downloads/Tessera.dmg`,
    );
    expect(mac.rows[1]!.download).toBe(`${BASE}/mac/Tessera-latest-mac-arm64.dmg`);
  });

  it('downloads the Windows installer and runs it from PowerShell', () => {
    const windows = installTabs(BASE, ['windows']).find((t) => t.platform === 'windows')!;
    expect(windows.rows.map((r) => r.label)).toEqual(['PowerShell', 'Download']);
    expect(windows.rows[0]!.command).toBe(
      `iwr ${BASE}/windows/Tessera-latest-windows-x64-setup.exe -OutFile "$env:TEMP\\Tessera-setup.exe"; & "$env:TEMP\\Tessera-setup.exe"`,
    );
    expect(windows.rows[1]!.download).toBe(`${BASE}/windows/Tessera-latest-windows-x64-setup.exe`);
  });

  it('installs the Linux .deb with apt', () => {
    const linux = installTabs(BASE, ['linux']).find((t) => t.platform === 'linux')!;
    expect(linux.rows.find((r) => r.label === 'Debian, Ubuntu')!.command).toBe(
      `curl -fLo /tmp/tessera.deb ${BASE}/linux/Tessera-latest-linux-amd64.deb && sudo apt install /tmp/tessera.deb`,
    );
  });
});

describe('firstTabWithRows', () => {
  it('opens on the first published platform', () => {
    expect(firstTabWithRows(installTabs(BASE, ['linux']))).toBe('linux');
  });

  it('opens on Mac when nothing is published', () => {
    expect(firstTabWithRows(installTabs('', []))).toBe('mac');
  });
});
