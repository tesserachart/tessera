import { createContext, useContext } from 'react';
import type { Fold } from './fit.ts';

export const HeaderFolds = createContext<ReadonlySet<Fold>>(new Set());

export function useFolded(fold: Fold): boolean {
  return useContext(HeaderFolds).has(fold);
}
