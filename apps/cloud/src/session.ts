import { base64url, EncryptJWT, errors as joseErrors, jwtDecrypt } from 'jose';
import { z } from 'zod';

export const LOGIN_TTL_SECONDS = 10 * 60;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const INVITE_TOKEN = /^[\w-]{43}$/;

const ReturnPath = z.union([
  z.enum(['/apply', '/admin']),
  z.templateLiteral(['/invite/', z.string().regex(INVITE_TOKEN)]),
]);
export type ReturnPath = z.infer<typeof ReturnPath>;

export function isInviteToken(token: string): boolean {
  return INVITE_TOKEN.test(token);
}

const Login = z.object({ state: z.string(), returnTo: ReturnPath });
type Login = z.infer<typeof Login>;

const Session = z.object({ userId: z.string(), providerSession: z.string(), csrf: z.string() });
export type Session = z.infer<typeof Session>;

const KINDS = {
  login: { audience: 'tessera-cloud:login', schema: Login, ttl: LOGIN_TTL_SECONDS },
  session: { audience: 'tessera-cloud:session', schema: Session, ttl: SESSION_TTL_SECONDS },
} as const;

type Kind = keyof typeof KINDS;
type Payload<K extends Kind> = z.infer<(typeof KINDS)[K]['schema']>;

export interface Sessions {
  seal<K extends Kind>(kind: K, payload: Payload<K>, now: Date): Promise<string>;
  open<K extends Kind>(kind: K, token: string, now: Date): Promise<Payload<K> | null>;
}

const keys = new Map<string, Promise<Uint8Array>>();

export function sessions(secret: string): Sessions {
  function key(): Promise<Uint8Array> {
    if (secret.length < 32) throw new Error('SESSION_SECRET is missing or shorter than 32 characters');
    let derived = keys.get(secret);
    if (derived === undefined) {
      derived = derive(secret);
      keys.set(secret, derived);
    }
    return derived;
  }

  return {
    async seal(kind, payload, now) {
      const { audience, ttl } = KINDS[kind];
      return new EncryptJWT(payload)
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
        .setAudience(audience)
        .setIssuedAt(now)
        .setExpirationTime(new Date(now.getTime() + ttl * 1000))
        .encrypt(await key());
    },

    async open(kind, token, now) {
      const { audience, schema } = KINDS[kind];
      try {
        const { payload } = await jwtDecrypt(token, await key(), {
          audience,
          currentDate: now,
          keyManagementAlgorithms: ['dir'],
          contentEncryptionAlgorithms: ['A256GCM'],
        });
        return schema.parse(payload) as Payload<typeof kind>;
      } catch (error) {
        if (error instanceof joseErrors.JOSEError || error instanceof z.ZodError) return null;
        throw error;
      }
    },
  };
}

async function derive(secret: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('tessera-cloud web cookies') },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export function randomToken(): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
}

export function sameToken(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
