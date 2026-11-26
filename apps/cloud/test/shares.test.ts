import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isShareId, shareId } from '../src/shares.ts';
import { store } from '../src/store.ts';
import DESKTOP from './desktop-sign-in.json';
import { database, FakeIdentity, MemoryBodies, NOW, reset, SITE, testApp } from './support.ts';

const ADA = { subject: 'idp_ada', email: 'ada@example.com', emailVerified: true, name: 'Ada Lovelace' };
const BEA = { subject: 'idp_bea', email: 'bea@example.com', emailVerified: true, name: 'Bea' };

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const PNG_BASE64 = btoa(String.fromCharCode(...PNG));

let db: D1Database;
let dispose: () => Promise<void>;
let bodies: MemoryBodies;
let app: ReturnType<typeof testApp>;

beforeAll(async () => {
  ({ db, dispose } = await database());
});

afterAll(() => dispose());

beforeEach(async () => {
  await reset(db);
  bodies = new MemoryBodies();
  app = testApp(db, new FakeIdentity({ 'code-ada': ADA, 'code-bea': BEA }), { shares: bodies });
});

function call(path: string, method: string, token?: string, body?: unknown) {
  return app.request(`https://account.test${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function signIn(code: string, approved = true): Promise<{ token: string; entitlements: string[] }> {
  const response = await call('/v1/auth/token', 'POST', undefined, { code, code_verifier: DESKTOP.code_verifier });
  const session = await response.json<{ access_token: string; account: { user: { id: string } } }>();
  if (approved) await store(db).approve(session.account.user.id, session.account.user.id, NOW);
  const me = await call('/v1/me', 'GET', session.access_token);
  const account = await me.json<{ entitlements: string[] }>();
  return { token: session.access_token, entitlements: account.entitlements };
}

const chart = {
  kind: 'chart',
  title: 'NQZ6 · 5m',
  image: { type: 'image/png', data: PNG_BASE64 },
  width: 1600,
  height: 900,
};

const conversation = {
  kind: 'conversation',
  title: 'Opening drive on NQ',
  conversation: {
    v: 1,
    title: 'Opening drive on NQ',
    amounts: false,
    turns: [
      { role: 'user', text: 'How did NQ open today?', files: 2 },
      {
        role: 'analyst',
        work: [
          { ns: 'chart', label: 'Read bars', meta: '1.2 s', failed: false },
          { ns: 'market', label: 'Read the tape', meta: null, failed: false },
          { ns: 'levels', label: 'Read gamma levels', meta: null, failed: true },
        ],
        workedMs: 12_300,
        answer: 'NQ opened **above** the overnight high and held 21,450.25.',
        blocks: [
          {
            kind: 'measured',
            title: 'First 30 minutes',
            text: '',
            rows: [
              ['Range', '84.25 pts'],
              ['Volume', '41,200'],
            ],
          },
          { kind: 'hypothesis', title: null, text: 'Buyers may defend 21,450.', rows: [] },
        ],
      },
    ],
  },
};

const indicator = {
  kind: 'indicator',
  title: 'RSI',
  display: {
    name: 'RSI',
    about: 'Indicator',
    lines: [
      { label: 'Length', value: '14' },
      { label: 'Line', value: '#8ed1fc' },
    ],
    parts: [],
    code: [],
  },
  setup: {
    kind: 'indicator',
    v: 1,
    layer: { kind: 'indicator', params: { indicator: 'rsi', length: 14, source: 'close' }, visible: true },
    custom: [],
    later: { nested: [1, 'two', null, { deep: true }] },
  },
};

const template = {
  kind: 'template',
  title: 'Order flow',
  display: {
    name: 'Order flow',
    about: 'Chart template · 2 indicators',
    lines: [{ label: 'Chart type', value: 'Candles' }],
    parts: [
      { name: 'VWAP', lines: [{ label: 'Anchor', value: 'Session' }] },
      { name: 'Volume profile', lines: [{ label: 'Rows', value: 'Auto' }] },
    ],
    code: [],
  },
  setup: { kind: 'template', v: 1, name: 'Order flow', chartType: 'candles', layers: [], custom: [] },
};

const workspace = {
  kind: 'layout',
  title: 'Scalping desk',
  display: {
    name: 'Scalping desk',
    about: 'Workspace · 2 charts',
    lines: [],
    parts: [
      { name: 'NQ · 5m', lines: [{ label: 'Opening range', value: 'Custom' }] },
      { name: 'ES · 1m', lines: [] },
    ],
    code: [
      { name: 'Opening range', code: 'export default function run(bars) {\n  return bars.map((b) => b.high);\n}' },
    ],
  },
  setup: { kind: 'layout', v: 1, name: 'Scalping desk', activeChartId: 'a', charts: [], dock: null, custom: [] },
};

const SETUPS = [indicator, template, workspace];

interface Shared {
  id: string;
  url: string;
  kind: string;
  title: string;
  created_at: string;
}

async function share(token: string, body: unknown = chart): Promise<Shared> {
  const response = await call('/v1/shares', 'POST', token, body);
  expect(response.status).toBe(201);
  return response.json();
}

async function page(url: string): Promise<string> {
  const response = await app.request(url);
  expect(response.status).toBe(200);
  return response.text();
}

function analystSays(answer: string, extra: Partial<Record<string, unknown>> = {}) {
  return {
    ...conversation,
    conversation: {
      ...conversation.conversation,
      turns: [{ role: 'analyst', work: [], workedMs: null, answer, blocks: [], ...extra }],
    },
  };
}

describe('sharing a chart', () => {
  it('gives a short link whose page shows the chart signed out, with the Tessera mark and no account', async () => {
    const { token } = await signIn('code-ada');
    const shared = await share(token);
    expect(shared.url).toBe(`https://account.test/s/${shared.id}`);
    expect(isShareId(shared.id)).toBe(true);
    expect(shared).toMatchObject({ kind: 'chart', title: 'NQZ6 · 5m', created_at: NOW.toISOString() });

    const text = await page(shared.url);
    expect(text).toContain('/assets/wordmark.svg');
    expect(text).toContain(`${shared.url}/image`);
    expect(text).toContain('<div class="frame" style="--w:1600px;--ratio:1.7778"><h1>NQZ6 · 5m</h1>');
    for (const secret of ['ada@example.com', 'Ada Lovelace', 'idp_ada', 'Sign out']) expect(text).not.toContain(secret);

    const image = await app.request(`${shared.url}/image`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG);
    expect((await app.request(`${shared.url}/setup`)).status).toBe(404);
  });

  it('keeps the page and the image out of search and caches', async () => {
    const { token } = await signIn('code-ada');
    const shared = await share(token);
    for (const path of [shared.url, `${shared.url}/image`]) {
      const response = await app.request(path);
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
    expect(await page(shared.url)).toContain('content="noindex, nofollow, noarchive"');
  });

  it('lists only the owner’s own links, newest first', async () => {
    const ada = await signIn('code-ada');
    const bea = await signIn('code-bea');
    const first = await share(ada.token);
    const theirs = await share(bea.token);
    const second = await share(ada.token, { ...chart, title: 'ESZ6 · 1m' });
    const listed = await (await call('/v1/shares', 'GET', ada.token)).json<{ shares: Shared[] }>();
    const ids = listed.shares.map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(ids).not.toContain(theirs.id);
  });

  it('kills the link and the image when the owner deletes it, and only the owner can', async () => {
    const ada = await signIn('code-ada');
    const bea = await signIn('code-bea');
    const shared = await share(ada.token);

    expect((await call(`/v1/shares/${shared.id}`, 'DELETE', bea.token)).status).toBe(404);
    expect((await app.request(shared.url)).status).toBe(200);

    expect((await call(`/v1/shares/${shared.id}`, 'DELETE', ada.token)).status).toBe(204);
    const gone = await app.request(shared.url);
    expect(gone.status).toBe(404);
    expect(gone.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
    expect((await app.request(`${shared.url}/image`)).status).toBe(404);
    expect(bodies.kept.size).toBe(0);
    expect((await call(`/v1/shares/${shared.id}`, 'DELETE', ada.token)).status).toBe(404);
  });

  it('has no listing anywhere: unknown and malformed links are not found', async () => {
    const { token } = await signIn('code-ada');
    await share(token);
    for (const path of ['/s', '/s/', `/s/${shareId()}`, `/s/${shareId()}/setup`, '/s/..%2Fadmin', '/s/short']) {
      expect((await app.request(`https://account.test${path}`)).status, path).toBe(404);
    }
    expect((await call('/v1/shares', 'GET')).status).toBe(401);
  });

  it('takes a share only signed in, with access, and a real picture', async () => {
    expect((await call('/v1/shares', 'POST', undefined, chart)).status).toBe(401);
    const pending = await signIn('code-bea', false);
    expect((await call('/v1/shares', 'POST', pending.token, chart)).status).toBe(403);
    const { token } = await signIn('code-ada');
    const notPng = { ...chart, image: { type: 'image/png', data: btoa('<svg onload=alert(1)>') } };
    expect((await call('/v1/shares', 'POST', token, notPng)).status).toBe(400);
    expect((await call('/v1/shares', 'POST', token, { ...chart, kind: 'conversation' })).status).toBe(400);
    expect((await call('/v1/shares', 'POST', token, { ...chart, title: '' })).status).toBe(400);
    expect(bodies.kept.size).toBe(0);
  });

  it('offers sharing only to an approved account on a Cloud with somewhere to keep the pictures', async () => {
    expect((await signIn('code-ada')).entitlements).toContain('share');
    expect((await signIn('code-bea', false)).entitlements).not.toContain('share');

    app = testApp(db, new FakeIdentity({ 'code-ada': ADA }), { shares: null });
    const off = await signIn('code-ada');
    expect(off.entitlements).not.toContain('share');
    expect((await call('/v1/shares', 'POST', off.token, chart)).status).toBe(503);
    expect((await call('/v1/shares', 'POST', off.token, indicator)).status).toBe(503);
    expect(await (await call('/v1/shares', 'GET', off.token)).json()).toEqual({ shares: [] });
  });

  it('makes ids that are short, unguessable and url-safe', () => {
    const ids = new Set(Array.from({ length: 2000 }, shareId));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(isShareId(id)).toBe(true);
  });
});

describe('sharing a conversation', () => {
  it('opens signed out as the conversation: the question, the folded steps, the answer and its labelled results', async () => {
    const { token } = await signIn('code-ada');
    const shared = await share(token, conversation);
    expect(shared).toMatchObject({ kind: 'conversation', title: 'Opening drive on NQ' });
    const listed = await (await call('/v1/shares', 'GET', token)).json<{ shares: Shared[] }>();
    expect(listed.shares).toEqual([shared]);

    const text = await page(shared.url);
    expect(text).toContain('<h1>Opening drive on NQ</h1>');
    expect(text).toContain('How did NQ open today?');
    expect(text).toContain('2 attachments not shared');
    expect(text).toContain('Worked for 12 s · 3 steps · 1 failed');
    for (const step of ['Read bars', 'Read the tape', 'Read gamma levels']) expect(text).toContain(step);
    expect(text).toContain('<svg class="gl"');
    expect(text).toContain('NQ opened <strong>above</strong> the overnight high and held 21,450.25.');
    expect(text).toContain('<span class="mk">Measured</span><span class="rt">First 30 minutes</span>');
    expect(text).toContain('<dt>Range</dt><dd>84.25 pts</dd>');
    expect(text).toContain('<span class="mk">Hypothesis</span>');
    expect(text).toContain('P/L and amounts hidden.');

    const shown = await share(token, {
      ...conversation,
      conversation: { ...conversation.conversation, amounts: true },
    });
    expect(await page(shown.url)).toContain('Amounts shown.');
  });

  it('renders Markdown as text: no raw HTML, links only as their words, no pictures', async () => {
    const { token } = await signIn('code-ada');
    const answer = [
      'Look <script>alert(1)</script> here <b onclick="x()">bold</b>',
      '',
      '<div><iframe src="https://evil.example/frame"></iframe></div>',
      '',
      'Read [the setup](https://evil.example/phish) and <https://evil.example/auto>.',
      '',
      '![the chart](https://evil.example/pixel.png)',
      '',
      '| Level | Hits |',
      '| --- | ---: |',
      '| 21,450 | 3 |',
      '',
      '```js',
      'const a = "<img src=x onerror=alert(1)>";',
      '```',
    ].join('\n');
    const shared = await share(
      token,
      analystSays(answer, {
        blocks: [
          { kind: 'observed', title: '<i>t</i>', text: '<script>b()</script>', rows: [['<u>k</u>', '<em>v</em>']] },
        ],
      }),
    );
    const text = await page(shared.url);
    expect(text).not.toMatch(/<script|<iframe|<div><iframe|<b |<i>|<u>|<em>v|<p><\/p>/);
    expect(text).not.toContain('evil.example/phish');
    expect(text).not.toContain('evil.example/pixel');
    expect(text).not.toContain('the chart');
    expect(text.match(/<img/g)).toHaveLength(1);
    expect(text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(text).toContain('&lt;b onclick=&quot;x()&quot;&gt;bold&lt;/b&gt;');
    expect(text).toContain('Read <span class="ln">the setup</span>');
    expect(text).toContain('<td class="al-r">3</td>');
    expect(text).toContain('<pre><code>const a = &quot;&lt;img src=x onerror=alert(1)&gt;&quot;;</code></pre>');
    expect(text).toContain('&lt;u&gt;k&lt;/u&gt;');
  });

  it('shows an answer too tangled for Markdown as plain text, quickly', async () => {
    const { token } = await signIn('code-ada');
    const shared = await share(token, analystSays('*a_['.repeat(15_000)));
    const started = performance.now();
    expect(await page(shared.url)).toContain('<p class="plain">*a_[*a_[');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('dies with its link when deleted, and never answers for a picture or settings', async () => {
    const { token } = await signIn('code-ada');
    const shared = await share(token, conversation);
    expect((await app.request(`${shared.url}/image`)).status).toBe(404);
    expect((await app.request(`${shared.url}/setup`)).status).toBe(404);
    expect((await call(`/v1/shares/${shared.id}`, 'DELETE', token)).status).toBe(204);
    expect((await app.request(shared.url)).status).toBe(404);
    expect(bodies.kept.size).toBe(0);
  });

  it('refuses a conversation past its limits', async () => {
    const { token } = await signIn('code-ada');
    const long = 'x'.repeat(40_000);
    const big = {
      ...conversation,
      conversation: {
        ...conversation.conversation,
        turns: Array.from({ length: 30 }, () => ({
          role: 'analyst',
          work: [],
          workedMs: null,
          answer: long,
          blocks: [],
        })),
      },
    };
    expect((await call('/v1/shares', 'POST', token, big)).status).toBe(413);
    const tooMany = {
      ...conversation,
      conversation: {
        ...conversation.conversation,
        turns: Array.from({ length: 401 }, () => ({ role: 'user', text: 'hi', files: 0 })),
      },
    };
    expect((await call('/v1/shares', 'POST', token, tooMany)).status).toBe(400);
    expect((await call('/v1/shares', 'POST', token, analystSays('x'.repeat(60_001)))).status).toBe(400);
    expect((await call('/v1/shares', 'POST', token, { ...conversation, title: 'x'.repeat(121) })).status).toBe(400);
    expect(bodies.kept.size).toBe(0);
  });
});

describe('sharing an indicator, a template or a workspace', () => {
  it.each(SETUPS)('opens a $kind signed out and hands its settings back untouched', async (setup) => {
    const { token } = await signIn('code-ada');
    const shared = await share(token, setup);
    expect(shared).toMatchObject({ kind: setup.kind, title: setup.title });
    const listed = await (await call('/v1/shares', 'GET', token)).json<{ shares: Shared[] }>();
    expect(listed.shares).toEqual([shared]);

    const text = await page(shared.url);
    expect(text).toContain(`<h1>${setup.display.name}</h1>`);
    expect(text).toContain(setup.display.about);
    expect(text).toContain(`value="${shared.url}"`);
    expect(text).toMatch(
      /Paste this link into Tessera to (add it to your charts|use this template|use this workspace)\./,
    );

    const response = await app.request(`${shared.url}/setup`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
    expect(await response.json()).toEqual({
      id: shared.id,
      kind: setup.kind,
      title: setup.title,
      display: setup.display,
      setup: setup.setup,
    });
    expect((await app.request(`${shared.url}/image`)).status).toBe(404);

    expect((await call(`/v1/shares/${shared.id}`, 'DELETE', token)).status).toBe(204);
    expect((await app.request(shared.url)).status).toBe(404);
    const setupGone = await app.request(`${shared.url}/setup`);
    expect(setupGone.status).toBe(404);
    expect(await setupGone.json()).toEqual({ error: 'not_found' });
    expect(bodies.kept.size).toBe(0);
  });

  it('shows colours as swatches and custom code as code', async () => {
    const { token } = await signIn('code-ada');
    const rsi = await page((await share(token, indicator)).url);
    expect(rsi).toContain('<span class="sw" style="background:#8ed1fc"></span>#8ed1fc');
    expect(rsi).toContain('to add it to your charts.');
    const desk = await page((await share(token, workspace)).url);
    expect(desk).toContain(
      '<pre><code>export default function run(bars) {\n  return bars.map((b) =&gt; b.high);\n}</code></pre>',
    );
    expect(desk).toContain('to use this workspace.');
    const flow = await page((await share(token, template)).url);
    expect(flow).toContain('<h2>');
    expect(flow).toContain('Volume profile');
    expect(flow).toContain('to use this template.');
  });

  it('never paints a colour it was not given as one', async () => {
    const { token } = await signIn('code-ada');
    const sneaky = {
      ...indicator,
      display: { ...indicator.display, lines: [{ label: 'Line', value: 'red;background:url(https://evil.example)' }] },
    };
    const text = await page((await share(token, sneaky)).url);
    expect(text).not.toContain('class="sw"');
  });

  it('refuses settings of another kind, settings that are not an object, and settings past their limits', async () => {
    const { token } = await signIn('code-ada');
    const refused = [
      { ...indicator, setup: { ...indicator.setup, kind: 'template' } },
      { ...template, kind: 'layout' },
      { ...indicator, setup: [indicator.setup] },
      { ...indicator, setup: 'indicator' },
      { ...indicator, setup: { v: 1 } },
      { ...indicator, display: { ...indicator.display, name: 'x'.repeat(121) } },
      {
        ...indicator,
        display: { ...indicator.display, lines: Array.from({ length: 101 }, () => indicator.display.lines[0]) },
      },
      { ...workspace, display: { ...workspace.display, code: [{ name: 'Big', code: 'x'.repeat(100_001) }] } },
    ];
    for (const body of refused) expect((await call('/v1/shares', 'POST', token, body)).status).toBe(400);
    const heavy = {
      ...workspace,
      display: {
        ...workspace.display,
        code: Array.from({ length: 6 }, (_, i) => ({ name: `Custom ${String(i)}`, code: 'x'.repeat(100_000) })),
      },
    };
    expect((await call('/v1/shares', 'POST', token, heavy)).status).toBe(413);
    expect(bodies.kept.size).toBe(0);
  });
});

describe('every share page', () => {
  it('carries the mark, a way to try Tessera and noindex, and nothing about the owner', async () => {
    const { token } = await signIn('code-ada');
    for (const body of [chart, conversation, ...SETUPS]) {
      const shared = await share(token, body);
      const response = await app.request(shared.url);
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
      const text = await response.text();
      expect(text, body.kind).toContain('<img src="/assets/wordmark.svg"');
      expect(text, body.kind).toContain(`<a class="btn btn-s btn-quiet try" href="${SITE}">Try Tessera</a>`);
      expect(text, body.kind).toContain('<meta name="robots" content="noindex, nofollow, noarchive"/>');
      expect(text, body.kind).toContain(`<meta property="og:title" content="${body.title} · Tessera"/>`);
      expect(text, body.kind).toContain('<meta property="og:description"');
      for (const secret of ['ada@example.com', 'Ada Lovelace', 'idp_ada', 'Sign out']) {
        expect(text, body.kind).not.toContain(secret);
      }
    }
  });
});
