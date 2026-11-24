import { configure } from '@testing-library/react';
import { vi } from 'vitest';
import { HANG_GUARD_MS } from '../../../../vitest.hang-guards.ts';

configure({ asyncUtilTimeout: HANG_GUARD_MS });

const waitFor = vi.waitFor.bind(vi);
vi.waitFor = (callback, options) =>
  waitFor(callback, typeof options === 'number' ? options : { timeout: HANG_GUARD_MS, ...options });
