import type { Delivery } from '@tessera/protocol';
import { defineSetting } from '../state/setting.ts';

export type Dispatch = 'start' | Delivery;

export function followUpOf(setting: unknown): Delivery {
  return setting === 'queue' ? 'queue' : 'steer';
}

export const FOLLOW_UP = defineSetting('agent.followUp', followUpOf);

export function alternateOf(followUp: Delivery): Delivery {
  return followUp === 'queue' ? 'steer' : 'queue';
}

export function dispatchMode(input: { running: boolean; followUp: Delivery; alternate: boolean }): Dispatch {
  if (!input.running) return 'start';
  return input.alternate ? alternateOf(input.followUp) : input.followUp;
}

export function followUpHelp(followUp: Delivery, alternateKey: string): string {
  return followUp === 'steer'
    ? `A message goes into the running turn. ${alternateKey} queues one for when it ends.`
    : `A message waits for the running turn to end. ${alternateKey} steers one into it.`;
}
