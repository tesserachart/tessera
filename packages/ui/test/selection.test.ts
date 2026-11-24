import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installSelectionScope, selectionScope } from '../src/selection.ts';

const baseCss = readFileSync(join(import.meta.dirname, '../src/styles/base.css'), 'utf8');

const html = document.documentElement;
const $ = (id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};
/**
 * CSS UI 4 resolves `auto` to the parent's value and WebKit inherits it; happy-dom computes the declared value only.
 */
const select = (el: Element | null): string => {
  if (!el) return 'text';
  const own = getComputedStyle(el).getPropertyValue('user-select');
  return own && own !== 'auto' ? own : select(el.parentElement);
};
const cursor = (el: Element) => getComputedStyle(el).getPropertyValue('cursor');

const selectDeclarations = () =>
  [...baseCss.matchAll(/\{([^}]*)\}/g)]
    .map((m) => m[1] ?? '')
    .filter((body) => /(^|[\s;])user-select:/.test(body))
    .map((body) => ({
      std: /(?:^|[\s;])user-select:\s*([\w-]+)/.exec(body)?.[1],
      webkit: /-webkit-user-select:\s*([\w-]+)/.exec(body)?.[1],
    }));

const DESK = `
  <div id="bar" role="toolbar"><span id="symbol">NQ Z6</span><button id="buy">Buy</button></div>
  <div id="chart" class="tessera-chart"><canvas id="canvas"></canvas><span id="axis">21,004.25</span></div>
  <table id="positions"><tr><td id="pnl">+412.50</td></tr></table>
  <div id="tab" role="button">Analyst</div>
  <div id="conv" data-selectable="true">
    <div id="you" class="bubble">Where is the open?</div>
    <button id="toggle">Read 3 tools</button>
    <div id="say" class="md"><p id="answer">The open is <a id="link" href="#">21,000</a>.</p>
      <div id="code-head" data-selectable="false"><span id="lang">ts</span><button id="copy">Copy</button></div>
      <pre id="code"><code id="code-text">const open = 21000;</code></pre>
    </div>
  </div>
  <textarea id="composer"></textarea>
  <input id="field" value="NQ" />
  <div id="editor" contenteditable="true"><p id="note">Waited for the retest.</p></div>
  <div id="frozen" contenteditable="false"><span id="frozen-text">label</span></div>
  <span id="version" data-selectable="true">0.9.3</span>
  <pre id="logs">printed</pre>
`;

describe('selection: chrome never selects, text to copy does', () => {
  let style: HTMLStyleElement;
  beforeAll(() => {
    style = document.createElement('style');
    style.textContent = baseCss;
    document.head.append(style);
  });
  afterAll(() => {
    style.remove();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const CHROME = ['bar', 'symbol', 'buy', 'chart', 'canvas', 'axis', 'positions', 'pnl', 'tab', 'frozen-text'];
  const TEXT = ['you', 'answer', 'link', 'code', 'code-text', 'composer', 'field', 'editor', 'note', 'version', 'logs'];
  const CHROME_IN_TEXT = ['toggle', 'lang', 'copy', 'code-head'];

  it('the window is unselectable at its root, with the arrow for a pointer, and WebKit is told so too', () => {
    document.body.innerHTML = DESK;
    expect(select(html)).toBe('none');
    expect(cursor(html)).toBe('default');
    const rules = selectDeclarations();
    expect(rules.length).toBeGreaterThanOrEqual(4);
    for (const r of rules) expect(r.webkit).toBe(r.std);
  });

  it('chrome (bars, the chart, its axis, tables, tabs, buttons) is not selectable; the conversation, code, fields, editors and opted-in values are', () => {
    document.body.innerHTML = DESK;
    for (const id of CHROME) expect([id, select($(id))]).toEqual([id, 'none']);
    for (const id of CHROME_IN_TEXT) expect([id, select($(id))]).toEqual([id, 'none']);
    for (const id of TEXT) expect([id, select($(id))]).toEqual([id, 'text']);
  });

  it('the pointer is the arrow over chrome, and the browser’s own (an I-beam over text) over what can be selected', () => {
    document.body.innerHTML = DESK;
    for (const id of ['bar', 'symbol', 'chart', 'axis', 'pnl', 'tab', 'lang'])
      expect([id, cursor($(id))]).toEqual([id, 'default']);
    for (const id of ['answer', 'code', 'composer', 'field', 'note', 'version'])
      expect([id, cursor($(id))]).toEqual([id, 'auto']);
  });

  it('selection.ts reads the same elements as base.css: a scope for text, none for chrome', () => {
    document.body.innerHTML = DESK;
    for (const id of [...CHROME, ...CHROME_IN_TEXT]) expect([id, selectionScope($(id))]).toEqual([id, null]);
    for (const id of ['you', 'answer', 'link', 'code', 'code-text'])
      expect([id, selectionScope($(id))?.id]).toEqual([id, 'conv']);
    for (const id of ['composer', 'field', 'editor', 'version', 'logs'])
      expect([id, selectionScope($(id))?.id]).toEqual([id, id]);
    expect(selectionScope($('note'))?.id).toBe('editor');
  });
});

describe('installSelectionScope: a press decides what a drag may select', () => {
  let style: HTMLStyleElement;
  let uninstall: () => void;
  beforeAll(() => {
    style = document.createElement('style');
    style.textContent = baseCss;
    document.head.append(style);
    uninstall = installSelectionScope(window);
  });
  afterAll(() => {
    uninstall();
    style.remove();
  });
  afterEach(() => {
    $('answer').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    document.body.innerHTML = '';
  });

  const press = (id: string) => $(id).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  const selectStart = (id: string) =>
    $(id).dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true }));

  it('a drag that begins on the chart, a bar or a button selects nothing, wherever it goes (WebKit would let it)', () => {
    document.body.innerHTML = DESK;
    for (const from of ['canvas', 'axis', 'bar', 'buy', 'pnl', 'copy']) {
      press(from);
      expect([from, selectStart('answer')]).toEqual([from, false]);
      expect([from, selectStart(from)]).toEqual([from, false]);
    }
  });

  it('a selection begun in a message stays in the conversation: text elsewhere is out of its reach until the press ends', () => {
    document.body.innerHTML = DESK;
    press('answer');
    expect(selectStart('answer')).toBe(true);
    expect(html.dataset.selecting).toBe('');
    expect($('conv').hasAttribute('data-selection-scope')).toBe(true);
    for (const id of ['you', 'answer', 'code', 'code-text']) expect([id, select($(id))]).toEqual([id, 'text']);
    for (const id of ['version', 'logs']) expect([id, select($(id))]).toEqual([id, 'none']);
    expect(select($('composer'))).toBe('text');
    $('answer').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(html.dataset.selecting).toBeUndefined();
    expect(document.querySelector('[data-selection-scope]')).toBeNull();
  });

  it('a field selects as fields do, and a selection from the keyboard is left alone', () => {
    document.body.innerHTML = DESK;
    press('composer');
    expect(selectStart('composer')).toBe(true);
    expect(html.dataset.selecting).toBeUndefined();
    $('composer').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(selectStart('answer')).toBe(true);
    expect(html.dataset.selecting).toBeUndefined();
  });
});
