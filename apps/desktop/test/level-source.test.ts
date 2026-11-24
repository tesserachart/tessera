import { describe, expect, it } from 'vitest';
import {
  EMPTY_FORM,
  formFromSpec,
  formProblem,
  parseSpec,
  samplesOf,
  slugId,
  specFromForm,
  splitUrl,
  type LevelSourceForm,
} from '../src/accounts/levelSource.ts';

const form = (patch: Partial<LevelSourceForm> = {}): LevelSourceForm => ({
  ...EMPTY_FORM,
  vendor: 'Acme Data',
  url: 'https://api.acme.test/v1/levels/{ticker}?dte=0',
  secret: 'k-1',
  tickers: [
    { root: 'nq', ticker: 'NDX', add: '41.5' },
    { root: 'QQQ', ticker: 'QQQ', add: '' },
    { root: '', ticker: '', add: '' },
  ],
  fields: [
    { field: 'call_wall', path: 'data.cw', label: 'Call Wall' },
    { field: 'put_wall', path: '', label: '' },
    { field: '', path: '', label: '' },
  ],
  asOf: 'ts',
  ...patch,
});

describe('levels from an API (the form)', () => {
  it('splits the request URL, keeping {ticker} and the query', () => {
    expect(splitUrl('https://api.acme.test/v1/levels/{ticker}?dte=0&x=a%20b')).toEqual({
      baseUrl: 'https://api.acme.test',
      path: '/v1/levels/{ticker}',
      query: { dte: '0', x: 'a b' },
    });
    expect(splitUrl('https://api.acme.test')).toEqual({ baseUrl: 'https://api.acme.test', path: '/', query: {} });
    expect(splitUrl('api.acme.test/x')).toBeNull();
    expect(slugId('Acme Data')).toBe('acme-data');
    expect(slugId('42 Levels')).toBe('src-42-levels');
  });

  it('says what is missing in plain words', () => {
    expect(formProblem(form())).toBeNull();
    expect(formProblem(form({ vendor: ' ' }))).toBe('Name the vendor');
    expect(formProblem(form({ url: 'http://api.acme.test/{ticker}' }))).toBe(
      'The request is https:// (it carries the key)',
    );
    expect(formProblem(form({ url: 'http://127.0.0.1:8080/{ticker}' }))).toBeNull();
    expect(formProblem(form({ url: 'https://api.acme.test/levels' }))).toBe(
      'Put {ticker} where the vendor’s ticker goes',
    );
    expect(formProblem(form({ tickers: [{ root: 'NQ', ticker: '', add: '' }] }))).toBe(
      'Map at least one instrument to a ticker',
    );
    expect(formProblem(form({ fields: [] }))).toBe('Name at least one field of the answer');
    expect(formProblem(form({ every: '1' }))).toBe('Ask at most every 5 seconds');
  });

  it('makes a spec the runtime runs, without the key in it', () => {
    const spec = specFromForm(form());
    expect(spec).toMatchObject({
      version: 1,
      id: 'acme-data',
      vendor: 'Acme Data',
      baseUrl: 'https://api.acme.test',
      auth: { in: 'header', name: 'Authorization', prefix: 'Bearer ' },
      instruments: [
        { root: 'NQ', ticker: 'NDX', convert: { model: 'additive', additive: 41.5 } },
        { root: 'QQQ', ticker: 'QQQ' },
      ],
      requests: [
        {
          id: 'levels',
          package: 'Levels',
          path: '/v1/levels/{ticker}',
          query: { dte: '0' },
          asOf: { path: 'ts', unit: 'seconds' },
          fields: [
            { field: 'call_wall', path: 'data.cw', label: 'Call Wall', naIf: [0] },
            { field: 'put_wall', naIf: [0] },
          ],
        },
      ],
      schedule: { everySeconds: 300, window: { session: 'us_rth' }, offHours: 'once' },
    });
    expect(JSON.stringify(spec)).not.toContain('k-1');
    expect(specFromForm(form({ auth: 'query', authName: 'apikey' })).auth).toEqual({
      in: 'query',
      name: 'apikey',
      prefix: '',
    });
    expect(specFromForm(form({ auth: 'none' })).auth).toBeUndefined();
    expect(specFromForm(form({ id: 'acme', vendor: 'Acme Renamed' })).id).toBe('acme');
  });

  it('reads a spec back into the form, and refuses one it cannot say', () => {
    const spec = specFromForm(form());
    const back = formFromSpec(spec)!;
    expect(back.url).toBe('https://api.acme.test/v1/levels/{ticker}?dte=0');
    expect(back.tickers).toEqual([
      { root: 'NQ', ticker: 'NDX', add: '41.5' },
      { root: 'QQQ', ticker: 'QQQ', add: '' },
    ]);
    expect(back.secret).toBe('');
    expect(specFromForm(back)).toEqual(spec);
    expect(formFromSpec({ ...spec, requests: [...spec.requests, spec.requests[0]!] })).toBeNull();
    expect(
      formFromSpec({ ...spec, instruments: [{ root: 'NQ', ticker: 'NDX', convert: { model: 'ratio', ratio: 1.01 } }] }),
    ).toBeNull();
  });

  it('reads a pasted spec, filling what the runtime defaults', () => {
    const spec = specFromForm(form());
    expect(parseSpec(JSON.stringify(spec))).toEqual({ spec });
    const short = parseSpec(
      JSON.stringify({
        version: 1,
        id: 'x',
        name: 'X',
        vendor: 'X',
        baseUrl: 'https://x.test',
        instruments: [],
        requests: [],
      }),
    );
    expect(short).toMatchObject({ spec: { headers: {}, schedule: { everySeconds: 60 }, recordRaw: true } });
    expect(parseSpec('')).toEqual({ error: 'Paste a spec' });
    expect(parseSpec('{x')).toEqual({ error: 'The spec is not JSON' });
    expect(parseSpec('{"id": "x"}')).toEqual({ error: 'A spec has an id, a baseUrl, instruments and requests' });
  });

  it('reads a pasted sample, or says it is not JSON', () => {
    expect(samplesOf(form({ sample: '' }))).toEqual({ samples: {} });
    expect(samplesOf(form({ sample: '{"data": {"cw": 1}}' }))).toEqual({ samples: { levels: { data: { cw: 1 } } } });
    expect(samplesOf(form({ sample: '{nope' }))).toEqual({ error: 'The sample is not JSON' });
  });
});
