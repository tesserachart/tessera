import type { AlertFire } from '@tessera/protocol';
import { notify } from '../app/host.ts';
import { announce } from '../sound/voice/speaker.ts';
import { deskToasts } from '../workspace/dock/deskToasts.ts';
import { revealTile } from '../workspace/dock/open.ts';
import { fireWords } from './words.ts';

export function deliverFire(f: AlertFire): void {
  const w = fireWords(f);
  if (f.deliver.sound) announce(f.side === 'ask' ? 'big_buyer' : f.side === 'bid' ? 'big_seller' : 'alert');
  deskToasts.push({
    tone: 'info',
    title: w.title,
    detail: w.detail,
    key: `alert:${f.alertId}`,
    action: { label: 'Show', run: () => void revealTile('alerts', { via: 'pointer', focus: true }) },
  });
  if (f.deliver.desktop) void notify({ title: w.title, body: w.detail }).catch(() => undefined);
}
