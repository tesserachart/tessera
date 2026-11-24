import type { SoundEvent } from '../events.ts';
import type { SoundName } from '../tones.ts';

export const VOICE_LINE_IDS = [
  'order_filled',
  'market_filled',
  'limit_filled',
  'stop_filled',
  'stop_limit_filled',
  'partially_filled',
  'stop_hit',
  'target_hit',
  'position_closed',
  'position_reversed',
  'order_cancelled',
  'order_rejected',
  'loss_limit',
  'account_locked',
  'connection_lost',
  'connection_restored',
  'alert',
  'big_buyer',
  'big_seller',
] as const;

export type VoiceLineId = (typeof VOICE_LINE_IDS)[number];

export type VoiceGroup = 'trade' | 'alert' | 'connection';

export interface VoiceLine {
  /** Its full stop makes the vendor read it as a statement, falling at the end. */
  text: string;
  event: SoundEvent;
  tone: SoundName | null;
  fallback?: VoiceLineId;
  rank: number;
  group: VoiceGroup;
}

export const VOICE_LINES: Readonly<Record<VoiceLineId, VoiceLine>> = {
  order_filled: { text: 'Order filled.', event: 'fill', tone: 'fill', rank: 40, group: 'trade' },
  market_filled: {
    text: 'Market filled.',
    event: 'fill',
    tone: 'fill',
    fallback: 'order_filled',
    rank: 41,
    group: 'trade',
  },
  limit_filled: {
    text: 'Limit filled.',
    event: 'fill',
    tone: 'fill',
    fallback: 'order_filled',
    rank: 41,
    group: 'trade',
  },
  stop_filled: {
    text: 'Stop order filled.',
    event: 'fill',
    tone: 'fill',
    fallback: 'order_filled',
    rank: 41,
    group: 'trade',
  },
  stop_limit_filled: {
    text: 'Stop limit filled.',
    event: 'fill',
    tone: 'fill',
    fallback: 'order_filled',
    rank: 41,
    group: 'trade',
  },
  partially_filled: { text: 'Partially filled.', event: 'fill', tone: 'fill', rank: 30, group: 'trade' },
  stop_hit: { text: 'Stop loss hit.', event: 'stop', tone: 'stop', rank: 70, group: 'trade' },
  target_hit: { text: 'Target hit.', event: 'target', tone: 'target', rank: 65, group: 'trade' },
  position_closed: { text: 'Position closed.', event: 'fill', tone: null, rank: 55, group: 'trade' },
  position_reversed: { text: 'Position reversed.', event: 'fill', tone: null, rank: 60, group: 'trade' },
  order_cancelled: { text: 'Order cancelled.', event: 'cancelled', tone: null, rank: 20, group: 'trade' },
  order_rejected: { text: 'Order rejected.', event: 'rejected', tone: 'rejected', rank: 80, group: 'trade' },
  loss_limit: { text: 'Loss limit reached.', event: 'rejected', tone: null, rank: 90, group: 'trade' },
  account_locked: { text: 'Account locked.', event: 'rejected', tone: null, rank: 90, group: 'trade' },
  connection_lost: { text: 'Connection lost.', event: 'connection', tone: null, rank: 100, group: 'connection' },
  connection_restored: {
    text: 'Connection restored.',
    event: 'connection',
    tone: null,
    rank: 45,
    group: 'connection',
  },
  alert: { text: 'Alert.', event: 'alert', tone: 'alert', rank: 50, group: 'alert' },
  big_buyer: { text: 'Big buyer.', event: 'alert', tone: 'alertAsk', rank: 50, group: 'alert' },
  big_seller: { text: 'Big seller.', event: 'alert', tone: 'alertBid', rank: 50, group: 'alert' },
};

export const EVENT_SAMPLE: Readonly<Record<SoundEvent, VoiceLineId>> = {
  fill: 'order_filled',
  stop: 'stop_hit',
  target: 'target_hit',
  rejected: 'order_rejected',
  cancelled: 'order_cancelled',
  connection: 'connection_lost',
  alert: 'alert',
};

export function fallbackChain(line: VoiceLineId): VoiceLineId[] {
  const out: VoiceLineId[] = [];
  for (let at: VoiceLineId | undefined = line; at && !out.includes(at); at = VOICE_LINES[at].fallback) out.push(at);
  return out;
}
