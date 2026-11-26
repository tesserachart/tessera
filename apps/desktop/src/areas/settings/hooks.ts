import { useLoadPending } from '@tessera/ui';
import { useSyncExternalStore } from 'react';
import { healthStore } from '../../app/health.ts';
import { useAccountList } from '../../app/portfolio.ts';
import { useStore } from '../../app/store.ts';
import { commands, type Command } from '../../commands/registry.ts';
import { keyedCommands } from './words.ts';

export function useKeyedCommands(): Command[] {
  useSyncExternalStore(commands.subscribe, commands.getVersion);
  return keyedCommands(commands.list());
}

export function useShellKnown(): void {
  useLoadPending(useStore(healthStore) === null);
  useLoadPending(useAccountList() === null);
}
