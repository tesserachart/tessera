import type { SessionMode } from '@tessera/protocol';
import type { IconName } from '@tessera/ui';

export interface ModeInfo {
  value: SessionMode;
  label: string;
  hint: string;
  icon: IconName;
}

export const MODES: readonly ModeInfo[] = [
  {
    value: 'read_only',
    label: 'Read only',
    hint: 'Reads and answers. Changes nothing and drafts no orders.',
    icon: 'mode-read',
  },
  {
    value: 'supervised',
    label: 'Supervised',
    hint: 'Asks before it changes anything. Every order is a draft you approve.',
    icon: 'mode-ask',
  },
  {
    value: 'auto_modify',
    label: 'Auto-modify',
    hint: 'Changes charts, layouts and settings without asking. Every order is a draft you approve.',
    icon: 'mode-modify',
  },
  {
    value: 'full_access',
    label: 'Full access',
    hint: 'Changes anything, and places, changes and closes orders without asking. Your risk limits still apply.',
    icon: 'mode-auto',
  },
];

export const isMode = (v: unknown): v is SessionMode => MODES.some((m) => m.value === v);

export function modeInfo(mode: SessionMode): ModeInfo {
  return MODES.find((m) => m.value === mode) ?? MODES.find((m) => m.value === 'supervised')!;
}

export const FULL_ACCESS_WARNING =
  'The analyst will place, change and close orders on your accounts without asking, including live accounts. Your risk limits still apply.';

export function asksFirst(from: SessionMode | null, to: SessionMode): boolean {
  return to === 'full_access' && from !== 'full_access';
}
