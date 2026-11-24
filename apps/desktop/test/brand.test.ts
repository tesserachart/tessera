import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setFaviconDraft } from '../src/app/favicon.ts';

const app = join(import.meta.dirname, '..');
const html = readFileSync(join(app, 'index.html'), 'utf8');

describe('the keyed T: app icon and favicon (v5 brand/final-1)', () => {
  it('bundles the identity’s icons for Tauri and the page', () => {
    const conf = JSON.parse(readFileSync(join(app, 'src-tauri/tauri.conf.json'), 'utf8')) as {
      bundle: { icon: string[] };
    };
    for (const icon of conf.bundle.icon) expect(existsSync(join(app, 'src-tauri', icon)), icon).toBe(true);
    for (const href of [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="\/([^"]+)"/g)].map((m) => m[1]!))
      expect(existsSync(join(app, 'public', href)), href).toBe(true);
    for (const f of ['favicon-draft.ico', 'favicon-draft-16.png', 'favicon-draft-32.png'])
      expect(existsSync(join(app, 'public', f)), f).toBe(true);
  });

  it('shows the draft cut while a draft waits, and the rest cut after', () => {
    document.head.innerHTML = [...html.matchAll(/<link rel="icon"[^>]*>/g)].map((m) => m[0]).join('');
    const hrefs = () => [...document.querySelectorAll('link[rel="icon"]')].map((l) => l.getAttribute('href'));
    expect(hrefs()).toEqual(['/favicon.ico', '/favicon.svg', '/favicon-32.png', '/favicon-16.png']);
    setFaviconDraft(true);
    expect(hrefs()).toEqual([
      '/favicon-draft.ico',
      '/favicon-draft-32.png',
      '/favicon-draft-32.png',
      '/favicon-draft-16.png',
    ]);
    setFaviconDraft(false);
    expect(hrefs()).toEqual(['/favicon.ico', '/favicon.svg', '/favicon-32.png', '/favicon-16.png']);
  });
});

describe('the app’s pages', () => {
  it('keep one slot for the boot splash the build fills in', () => {
    expect(html.split('<!--boot-->')).toHaveLength(2);
  });

  it('send no Referer with what they load', () => {
    for (const page of ['index.html', 'kit.html']) {
      expect(readFileSync(join(app, page), 'utf8'), page).toContain('<meta name="referrer" content="no-referrer" />');
    }
  });
});
