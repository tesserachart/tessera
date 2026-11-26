import { afterEach, describe, expect, it } from 'vitest';
import { ABOVE_ATTR, copyPage, OUT_ATTR, shiftedTranslate, type PageRead } from '../src/feedback/page.ts';
import { bitmapPart, meet, paintsOver, stackRank } from '../src/feedback/pixels.ts';
import { classesNeeded, cssFor, inlineUrls, itemsOf } from '../src/feedback/sheets.ts';

const SLOT = 'fb-css-slot';

function readOf(over: Partial<PageRead> = {}): PageRead {
  return {
    frame: { left: 0, top: 0, right: 800, bottom: 600 },
    painted: [],
    out: new Set(),
    above: new Set(),
    hidden: new Set(),
    scrolled: new Map(),
    ...over,
  };
}

function parsed(markup: string): Document {
  return new DOMParser().parseFromString(markup, 'application/xhtml+xml');
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('the window picture', () => {
  it('takes from a canvas only the pixels that show, at the canvas’s own resolution', () => {
    const box = { left: 100, top: 50, right: 500, bottom: 350 };
    const shown = meet(box, { left: 0, top: 0, right: 300, bottom: 600 });
    expect(shown).toEqual({ left: 100, top: 50, right: 300, bottom: 350 });
    expect(bitmapPart(box, shown!, { width: 800, height: 600 })).toEqual({ left: 0, top: 0, right: 400, bottom: 600 });
    expect(meet(box, { left: 600, top: 0, right: 700, bottom: 100 })).toBeNull();
  });

  it('lays back over a canvas what is drawn above it, and nothing drawn beneath it', () => {
    document.body.innerHTML = `
      <div id="panel" style="position:relative">
        <div id="before" style="position:absolute;z-index:5"></div>
        <canvas id="chart" style="position:absolute;z-index:1"></canvas>
        <div id="legend" style="position:absolute"></div>
        <div id="flow"></div>
      </div>
      <div id="menu" style="position:fixed;z-index:50"></div>`;
    const el = (id: string) => document.getElementById(id)!;
    const rank = stackRank();
    expect(paintsOver(el('chart'), el('before'), rank)).toBe(true);
    expect(paintsOver(el('chart'), el('menu'), rank)).toBe(true);
    expect(paintsOver(el('chart'), el('flow'), rank)).toBe(false);
    expect(paintsOver(el('chart'), el('legend'), rank)).toBe(false);
    expect(paintsOver(el('chart'), el('panel'), rank)).toBe(false);
  });

  it('moves a scrolled box’s content by its scroll, keeping its own shift', () => {
    expect(shiftedTranslate('none', 0, 120)).toBe('calc(0px - 0px) calc(0px - 120px)');
    expect(shiftedTranslate('-50% 4px', 10, 0)).toBe('calc(-50% - 10px) calc(4px - 0px)');
    expect(shiftedTranslate('calc(50% + 2px)', 0, 3)).toBe('calc(calc(50% + 2px) - 0px) calc(0px - 3px)');
  });

  it('carries the page’s fonts inside the picture, reading each file once', async () => {
    const asked: string[] = [];
    const load = (url: string) => {
      asked.push(url);
      return url.endsWith('gone.woff2')
        ? Promise.reject(new Error('404'))
        : Promise.resolve(`data:font/woff2;x=${url}`);
    };
    const css =
      '@font-face{src:url(\'../fonts/a.woff2\')}\n.b{background:url("data:image/png;base64,AA")}\n' +
      '.c{mask:url(#cut)}\n@font-face{src:url(../fonts/a.woff2)}\n@font-face{src:url(/gone.woff2)}';
    const out = await inlineUrls(css, 'https://tessera.test/assets/app.css', load);
    expect(asked).toEqual(['https://tessera.test/fonts/a.woff2', 'https://tessera.test/gone.woff2']);
    expect(out).toContain('url("data:font/woff2;x=https://tessera.test/fonts/a.woff2")');
    expect(out).not.toContain('../fonts/a.woff2');
    expect(out).toContain('url("data:image/png;base64,AA")');
    expect(out).toContain('url(#cut)');
    expect(out).toContain('url(/gone.woff2)');
  });

  it('draws with the media the window has, not the picture’s own', () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      '.a{color:red}\n@media (max-resolution: 1dppx){.cut{display:inline}}\n@media (min-resolution: 2dppx){.vec{display:inline}}',
    );
    const css = cssFor(
      itemsOf(sheet.cssRules, (m) => m.includes('min-resolution')),
      new Set(['a', 'cut', 'vec']),
    );
    expect(css).toContain('.a');
    expect(css).toContain('.vec');
    expect(css).not.toContain('.cut');
    expect(css).not.toContain('@media');
  });

  it('carries only the rules something in the window can match', () => {
    expect(classesNeeded('.a .b, .c:hover')).toEqual([['a', 'b'], ['c']]);
    expect(classesNeeded('.hover\\:bg-x:hover, .w-1\\/2')).toEqual([['hover:bg-x'], ['w-1/2']]);
    expect(classesNeeded('.\\31 0')).toEqual([['10']]);
    expect(classesNeeded(':root, .a')).toBeNull();
    expect(classesNeeded('.a:not(.b), [data-x=".c"]')).toBeNull();
    expect(classesNeeded('.a:is(.b, .c)')).toEqual([['a']]);
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.used{color:red}\n.unused{color:blue}\n.used .unused{color:green}\n:root{--x:1}');
    const css = cssFor(
      itemsOf(sheet.cssRules, () => true),
      new Set(['used']),
    );
    expect(css).toContain('.used');
    expect(css).toContain('--x');
    expect(css).not.toContain('blue');
    expect(css).not.toContain('green');
  });

  it('copies the page with account words hidden, the sheet left out and what was typed kept', () => {
    document.body.innerHTML = `
      <main aria-label="Account APEX-1234567-01">
        <p>Long 1 on APEX-1234567-01</p>
        <input id="note" />
        <select id="side"><option>Buy</option><option>Sell</option></select>
        <img id="logo" src="logo.png" />
        <div id="list"><div id="row">Row</div>Loose text</div>
      </main>
      <aside id="sheet">Send feedback</aside>
      <script>run()</script>`;
    (document.getElementById('note') as HTMLInputElement).value = 'stop on APEX-1234567-01';
    (document.getElementById('side') as HTMLSelectElement).selectedIndex = 1;
    const sheet = document.getElementById('sheet')!;
    const logo = document.getElementById('logo')!;
    const list = document.getElementById('list')!;
    const { markup, classes } = copyPage(
      readOf({ out: new Set([sheet]), above: new Set([logo]), scrolled: new Map([[list, { x: 0, y: 40 }]]) }),
      ['APEX-1234567-01'],
      SLOT,
    );
    expect(markup).not.toContain('1234567');
    expect(classes.size).toBe(0);
    const doc = parsed(markup);
    expect(doc.querySelector('style')?.textContent).toBe(SLOT);
    expect(doc.querySelector('main')?.getAttribute('aria-label')).toBe('Account ••••');
    expect(doc.querySelector('p')?.textContent).toBe('Long 1 on ••••');
    expect(doc.getElementById('note')?.getAttribute('value')).toBe('stop on ••••');
    expect(doc.querySelectorAll('option')[1]?.hasAttribute('selected')).toBe(true);
    expect(doc.getElementById('sheet')?.hasAttribute(OUT_ATTR)).toBe(true);
    expect(doc.getElementById('logo')?.hasAttribute('src')).toBe(false);
    expect(doc.getElementById('logo')?.hasAttribute(OUT_ATTR)).toBe(true);
    expect(doc.getElementById('logo')?.hasAttribute(ABOVE_ATTR)).toBe(true);
    expect(doc.getElementById('row')?.getAttribute('style')).toContain('calc(0px - 40px)');
    expect(doc.querySelector('#list > span')?.getAttribute('style')).toContain('top: -40px');
    expect(doc.querySelector('script')).toBeNull();
  });
});
