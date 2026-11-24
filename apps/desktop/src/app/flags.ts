import { useEffect } from 'react';
import { FLAGS, type FlagKey } from './flagKeys.ts';
import { track, useTelemetryConfig } from './telemetry.ts';

const called = new Set<FlagKey>();

export function useFlag(key: FlagKey): boolean | string {
  const config = useTelemetryConfig();
  const value = config?.flags[key] ?? FLAGS[key].fallback;
  const asked = config !== undefined && key in config.flags;
  useEffect(() => {
    if (!asked || called.has(key)) return;
    called.add(key);
    track({ event: '$feature_flag_called', $feature_flag: key, $feature_flag_response: value });
  }, [asked, key, value]);
  return value;
}
