import { describe, expect, it } from 'vitest';

import { sessions } from '../src/session.ts';
import { NOW, SECRET } from './support.ts';

describe('login return path', () => {
  const token = 'a'.repeat(43);

  async function roundTrip(returnTo: string) {
    const seal = sessions(SECRET);
    const sealed = await seal.seal('login', { state: 's', returnTo } as never, NOW);
    return seal.open('login', sealed, NOW);
  }

  it.each(['/apply', '/admin', `/invite/${token}`])('returns to %s', async (returnTo) => {
    expect(await roundTrip(returnTo)).toEqual({ state: 's', returnTo });
  });

  it.each([
    '//evil.example',
    'https://evil.example/apply',
    '/invite/short',
    `/invite/${token}/more`,
    `/invite/${token}\n`,
    `/invite/${token}?next=https://evil.example`,
  ])('refuses %j', async (returnTo) => {
    expect(await roundTrip(returnTo)).toBeNull();
  });
});
