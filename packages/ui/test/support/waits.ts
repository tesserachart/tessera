import { configure } from '@testing-library/react';
import { HANG_GUARD_MS } from '../../../../vitest.hang-guards.ts';

configure({ asyncUtilTimeout: HANG_GUARD_MS });
