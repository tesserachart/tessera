import { createContext, useContext } from 'react';

export const ShownContext = createContext(true);

export function useShown(): boolean {
  return useContext(ShownContext);
}
