import type { FieldSpec, InstrumentMapping, JsonValue, LevelSourceSpec, TimeUnit } from '@tessera/protocol';

export interface TickerRow {
  root: string;
  ticker: string;
  add: string;
}

export interface FieldRow {
  field: string;
  path: string;
  label: string;
}

export type AuthMode = 'none' | 'header' | 'query';

export interface LevelSourceForm {
  id: string | null;
  vendor: string;
  package: string;
  url: string;
  auth: AuthMode;
  authName: string;
  authPrefix: string;
  secret: string;
  tickers: TickerRow[];
  fields: FieldRow[];
  asOf: string;
  asOfUnit: TimeUnit;
  zeroIsNa: boolean;
  every: string;
  rthOnly: boolean;
  sample: string;
}

export const EMPTY_FORM: LevelSourceForm = {
  id: null,
  vendor: '',
  package: 'Levels',
  url: '',
  auth: 'header',
  authName: 'Authorization',
  authPrefix: 'Bearer ',
  secret: '',
  tickers: [{ root: 'NQ', ticker: '', add: '' }],
  fields: [{ field: '', path: '', label: '' }],
  asOf: '',
  asOfUnit: 'seconds',
  zeroIsNa: true,
  every: '300',
  rthOnly: true,
  sample: '',
};

export const REQUEST_ID = 'levels';

export function slugId(vendor: string): string {
  const s = vendor
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(s) ? s.slice(0, 40) : `src-${s}`.slice(0, 40);
}

export function splitUrl(url: string): { baseUrl: string; path: string; query: Record<string, string> } | null {
  const m = /^(https?:\/\/[^/?#\s]+)(\/[^?#\s]*)?(?:\?([^#\s]*))?$/.exec(url.trim());
  if (!m) return null;
  const query: Record<string, string> = {};
  for (const pair of (m[3] ?? '').split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    const dec = (x: string) => {
      try {
        return decodeURIComponent(x.replace(/\+/g, ' '));
      } catch {
        return x;
      }
    };
    if (k) query[dec(k)] = dec(v);
  }
  return { baseUrl: m[1]!, path: m[2] ?? '/', query };
}

function joinUrl(spec: LevelSourceSpec): string {
  const r = spec.requests[0]!;
  const q = Object.entries(r.query)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${spec.baseUrl.replace(/\/+$/, '')}${r.path}${q ? `?${q}` : ''}`;
}

export function formProblem(f: LevelSourceForm): string | null {
  if (!f.vendor.trim()) return 'Name the vendor';
  const u = splitUrl(f.url);
  if (!u) return 'The request is a full URL, https://…';
  if (!u.baseUrl.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.baseUrl))
    return 'The request is https:// (it carries the key)';
  if (!f.url.includes('{ticker}')) return 'Put {ticker} where the vendor’s ticker goes';
  if (f.auth !== 'none' && !f.authName.trim()) return 'Name the header or parameter the key goes in';
  if (!f.tickers.some((t) => t.root.trim() && t.ticker.trim())) return 'Map at least one instrument to a ticker';
  if (f.tickers.some((t) => t.add.trim() && !Number.isFinite(Number(t.add)))) return 'Points to add are a number';
  if (!f.fields.some((x) => x.field.trim())) return 'Name at least one field of the answer';
  const every = Number(f.every);
  if (!Number.isInteger(every) || every < 5) return 'Ask at most every 5 seconds';
  return null;
}

export function specFromForm(f: LevelSourceForm): LevelSourceSpec {
  const u = splitUrl(f.url)!;
  const vendor = f.vendor.trim();
  const tickers = f.tickers.filter((t) => t.root.trim() && t.ticker.trim());
  const instruments: InstrumentMapping[] = tickers.map((t) => {
    const add = t.add.trim() ? Number(t.add) : 0;
    return {
      root: t.root.trim().toUpperCase(),
      ticker: t.ticker.trim(),
      ...(add ? { convert: { model: 'additive' as const, additive: add } } : {}),
    };
  });
  const fields: FieldSpec[] = f.fields
    .filter((x) => x.field.trim())
    .map((x) => ({
      field: x.field.trim(),
      ...(x.path.trim() ? { path: x.path.trim() } : {}),
      ...(x.label.trim() ? { label: x.label.trim() } : {}),
      unit: 'price' as const,
      naIf: f.zeroIsNa ? [0] : [],
    }));
  return {
    version: 1,
    id: f.id ?? slugId(vendor),
    name: vendor,
    vendor,
    baseUrl: u.baseUrl,
    ...(f.auth === 'none'
      ? {}
      : {
          auth: {
            in: f.auth,
            name: f.authName.trim(),
            prefix: f.auth === 'header' ? f.authPrefix : '',
          },
        }),
    headers: { Accept: 'application/json' },
    instruments,
    requests: [
      {
        id: REQUEST_ID,
        package: f.package.trim() || 'Levels',
        path: u.path,
        query: u.query,
        ...(f.asOf.trim() ? { asOf: { path: f.asOf.trim(), unit: f.asOfUnit } } : {}),
        fields,
      },
    ],
    schedule: {
      everySeconds: Number(f.every),
      ...(f.rthOnly ? { window: { session: 'us_rth' as const } } : {}),
      offHours: 'once',
    },
    limits: {
      pools: {},
    },
    recordRaw: true,
  };
}

export function formFromSpec(spec: LevelSourceSpec): LevelSourceForm | null {
  const r = spec.requests[0];
  if (spec.requests.length !== 1 || !r || r.items || r.fields.length === 0) return null;
  if (spec.instruments.some((m) => m.convert && m.convert.model !== 'additive')) return null;
  const zeroIsNa = r.fields.every((x) => x.naIf.length === 1 && x.naIf[0] === 0);
  if (!zeroIsNa && r.fields.some((x) => x.naIf.length > 0)) return null;
  return {
    id: spec.id,
    vendor: spec.vendor,
    package: r.package,
    url: joinUrl(spec),
    auth: spec.auth ? spec.auth.in : 'none',
    authName: spec.auth?.name ?? 'Authorization',
    authPrefix: spec.auth?.prefix ?? 'Bearer ',
    secret: '',
    tickers: spec.instruments.map((m) => ({
      root: m.root,
      ticker: m.ticker,
      add: m.convert?.model === 'additive' ? String(m.convert.additive) : '',
    })),
    fields: r.fields.map((x) => ({ field: x.field, path: x.path ?? '', label: x.label ?? '' })),
    asOf: r.asOf?.path ?? '',
    asOfUnit: r.asOf?.unit ?? 'seconds',
    zeroIsNa,
    every: String(spec.schedule.everySeconds),
    rthOnly: spec.schedule.window?.session === 'us_rth',
    sample: '',
  };
}

export function samplesOf(f: LevelSourceForm): { samples: Record<string, JsonValue> } | { error: string } {
  if (!f.sample.trim()) return { samples: {} };
  try {
    return { samples: { [REQUEST_ID]: JSON.parse(f.sample) as JsonValue } };
  } catch {
    return { error: 'The sample is not JSON' };
  }
}

export function parseSpec(text: string): { spec: LevelSourceSpec } | { error: string } {
  if (!text.trim()) return { error: 'Paste a spec' };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { error: 'The spec is not JSON' };
  }
  const o = v as Partial<LevelSourceSpec> | null;
  if (
    !o ||
    typeof o !== 'object' ||
    typeof o.id !== 'string' ||
    typeof o.baseUrl !== 'string' ||
    !Array.isArray(o.instruments) ||
    !Array.isArray(o.requests)
  )
    return { error: 'A spec has an id, a baseUrl, instruments and requests' };
  return {
    spec: {
      headers: {},
      schedule: { everySeconds: 60, offHours: 'once' },
      limits: { pools: {} },
      recordRaw: true,
      ...o,
    } as LevelSourceSpec,
  };
}
