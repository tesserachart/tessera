import { vi } from 'vitest';
import { sessionAgainMs } from '../../src/market/flow/hub.ts';

export async function readsAgain(attempt: number): Promise<void> {
  const noJitter = vi.spyOn(Math, 'random').mockReturnValue(0);
  const wait = sessionAgainMs(attempt);
  noJitter.mockRestore();
  await vi.advanceTimersByTimeAsync(wait);
}
