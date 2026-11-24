import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FROM } from '../src/mail.ts';

const Bindings = z.object({
  send_email: z.array(z.object({ name: z.string(), allowed_sender_addresses: z.array(z.string()) })),
});
const WranglerConfig = Bindings.extend({ env: z.record(z.string(), Bindings) });

describe('mail', () => {
  it('sends from an address the EMAIL binding allows in every environment', () => {
    const config = WranglerConfig.parse(parse(readFileSync(join(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8')));
    for (const [env, { send_email }] of [['production', config] as const, ...Object.entries(config.env)]) {
      const allowed = send_email.find(({ name }) => name === 'EMAIL')?.allowed_sender_addresses;
      expect(allowed, env).toContain(FROM.email);
    }
  });
});
