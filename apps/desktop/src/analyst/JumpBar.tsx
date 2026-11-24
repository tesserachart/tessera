import type { Approval } from '@tessera/protocol';
import { Icon } from '@tessera/ui';
import { jumpWords } from './activity.ts';

export type Place = 'above' | 'below';

export function JumpBar({
  waiting,
  out,
  onJump,
}: {
  waiting: readonly Approval[];
  out: ReadonlyMap<string, Place>;
  onJump: (approval: Approval) => void;
}) {
  const first = waiting.find((a) => out.has(a.id));
  if (!first) return null;
  const place = out.get(first.id);
  return (
    <button type="button" className="an-jump" onClick={() => onJump(first)}>
      <span className="tx">{jumpWords(first)}</span>
      <Icon name={place === 'above' ? 'jump-up' : 'jump-down'} />
    </button>
  );
}
