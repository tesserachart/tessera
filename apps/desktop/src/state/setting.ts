export interface Setting<T> {
  readonly key: string;
  readonly read: (raw: unknown) => T;
}

export function defineSetting<T>(key: string, decode: (raw: unknown) => T): Setting<T> {
  let last: { raw: unknown; value: T } | null = null;
  return {
    key,
    read: (raw) => {
      if (!last || !Object.is(last.raw, raw)) last = { raw, value: decode(raw) };
      return last.value;
    },
  };
}

export const textOrNull = (raw: unknown): string | null => (typeof raw === 'string' ? raw : null);

export const onUnlessOff = (raw: unknown): boolean => raw !== false;

export const stored = (raw: unknown): unknown => raw;
