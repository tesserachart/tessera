import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LAUNCH_LINK_FILE = 'launch-link';

export function launchLink(origin: string, ticket: string): string {
  return `${origin.replace(/\/+$/, '')}/#ticket=${encodeURIComponent(ticket)}`;
}

export type Announced = { printed: true } | { printed: false; file: string };

export function announceLaunchLink(
  link: string,
  dataDir: string,
  terminal: boolean,
  say: (line: string) => void,
): Announced {
  if (terminal) {
    say(`open ${link}`);
    return { printed: true };
  }
  const file = join(dataDir, LAUNCH_LINK_FILE);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // `writeFileSync`'s `mode` only affects a newly created file.
  rmSync(file, { force: true });
  writeFileSync(file, `${link}\n`, { mode: 0o600, flag: 'wx' });
  say(`open the link in ${file} (it lets a page in, so it is not printed where others may read it)`);
  return { printed: false, file };
}

export function retireLaunchLink(announced: Announced | null): void {
  if (announced && !announced.printed) rmSync(announced.file, { force: true });
}
