import { useEffect, useState, type ReactNode } from 'react';
import { tileTurns } from './turns.ts';

export function TileTurn({ first, children }: { first: boolean; children: ReactNode }) {
  const [on, setOn] = useState(false);
  useEffect(() => tileTurns.take(first, () => setOn(true)), [first]);
  return on ? children : <div className="tile" />;
}
