import { usePlatform } from '@tessera/ui';
import { useHasTool, useToolValue } from '../app/tools.ts';

function savedWords(computer: 'mac' | 'other', store: 'keyring' | 'dev_file' | null): string {
  const here = computer === 'mac' ? 'this Mac' : 'this computer';
  return store === 'dev_file' ? `Saved in a development file on ${here}` : `Saved securely on ${here}`;
}

export function useSavedWords(): string {
  const platform = usePlatform();
  const info = useToolValue('runtime.data_info', useHasTool('runtime.data_info') ? {} : null, { keepFor: 60_000 });
  return savedWords(platform, info?.secretStore ?? null);
}
