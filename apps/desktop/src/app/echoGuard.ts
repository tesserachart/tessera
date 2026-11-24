import { stableStringify as stableJson } from './stableJson.ts';

export interface EchoGuard {
  write(key: string, value: unknown): (stored?: unknown) => boolean;
  admit(key: string, value: unknown, local: unknown): boolean;
  agree(key: string, value: unknown): void;
  agreed(key: string): string | undefined;
  writing(key: string): boolean;
}

const ECHO_TTL_MS = 15_000;

export function createEchoGuard(now: () => number = Date.now): EchoGuard {
  const sent = new Map<string, { value: string; at: number }[]>();
  const flying = new Map<string, number>();
  const base = new Map<string, string>();
  const latest = new Map<string, number>();
  let seq = 0;
  return {
    write(key, value) {
      const v = stableJson(value);
      const t = now();
      const list = (sent.get(key) ?? []).filter((s) => t - s.at < ECHO_TTL_MS);
      list.push({ value: v, at: t });
      sent.set(key, list);
      flying.set(key, (flying.get(key) ?? 0) + 1);
      base.set(key, v);
      const mine = ++seq;
      latest.set(key, mine);
      let done = false;
      return (stored) => {
        if (done) return false;
        done = true;
        const n = (flying.get(key) ?? 1) - 1;
        if (n > 0) flying.set(key, n);
        else flying.delete(key);
        const newest = latest.get(key) === mine;
        if (newest && stored !== undefined) base.set(key, stableJson(stored));
        return newest;
      };
    },
    admit(key, value, local) {
      const v = stableJson(value);
      const t = now();
      const list = (sent.get(key) ?? []).filter((s) => t - s.at < ECHO_TTL_MS);
      const mine = list.findIndex((s) => s.value === v);
      if (mine >= 0) {
        sent.set(key, list.slice(mine + 1));
        return false;
      }
      sent.set(key, list);
      if ((flying.get(key) ?? 0) > 0) return false;
      const agreed = base.get(key);
      if (agreed !== undefined && stableJson(local) !== agreed) return false;
      base.set(key, v);
      return true;
    },
    agree: (key, value) => {
      base.set(key, stableJson(value));
    },
    agreed: (key) => base.get(key),
    writing: (key) => (flying.get(key) ?? 0) > 0,
  };
}
