import { act } from '@testing-library/react';

export const pause = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function actPause(): Promise<void> {
  await act(async () => {
    await pause();
  });
}
