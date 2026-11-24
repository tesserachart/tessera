import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { z } from 'zod';

import { type AuthorizeRequest, type Claims, type Identity, IdentityRejected, type Tokens } from './identity.ts';

const API = 'https://api.workos.com';

export interface WorkosConfig {
  clientId: string;
  apiKey: string;
}

const AuthenticateResponse = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    email_verified: z.boolean(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
  }),
  access_token: z.string(),
  refresh_token: z.string(),
});

const AccessClaims = z.object({ sub: z.string(), sid: z.string(), exp: z.number() });

const REJECTIONS = new Set(['invalid_grant', 'invalid_request', 'session_expired', 'mfa_enrollment', 'sso_required']);

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function workos(config: WorkosConfig, fetcher: typeof fetch = fetch): Identity {
  let jwks = keySets.get(config.clientId);
  if (jwks === undefined) {
    jwks = createRemoteJWKSet(new URL(`${API}/sso/jwks/${config.clientId}`));
    keySets.set(config.clientId, jwks);
  }
  const keys = jwks;

  async function authenticate(grant: Record<string, string>): Promise<Tokens> {
    const response = await fetcher(`${API}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.apiKey, ...grant }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = z.object({ error: z.string() }).safeParse(body).data?.error;
      if (response.status < 500 && (code === undefined || REJECTIONS.has(code))) {
        throw new IdentityRejected(code ?? `status ${String(response.status)}`);
      }
      throw new Error(`WorkOS authenticate failed: ${String(response.status)} ${code ?? ''}`.trim());
    }
    const parsed = AuthenticateResponse.parse(body);
    const name = [parsed.user.first_name, parsed.user.last_name].filter(Boolean).join(' ');
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      profile: {
        subject: parsed.user.id,
        email: parsed.user.email,
        emailVerified: parsed.user.email_verified,
        name: name === '' ? null : name,
      },
    };
  }

  return {
    authorizeUrl({ redirectUri, state, codeChallenge, loginHint }: AuthorizeRequest): string {
      const url = new URL(`${API}/user_management/authorize`);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('provider', 'authkit');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      if (codeChallenge !== undefined) {
        url.searchParams.set('code_challenge', codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      if (loginHint !== undefined) url.searchParams.set('login_hint', loginHint);
      return url.toString();
    },

    exchange(code, codeVerifier) {
      return authenticate({
        grant_type: 'authorization_code',
        code,
        ...(codeVerifier === undefined ? {} : { code_verifier: codeVerifier }),
      });
    },

    refresh(refreshToken) {
      return authenticate({ grant_type: 'refresh_token', refresh_token: refreshToken });
    },

    async verify(accessToken): Promise<Claims> {
      try {
        const { payload } = await jwtVerify(accessToken, keys);
        const claims = AccessClaims.parse(payload);
        return { subject: claims.sub, sessionId: claims.sid, expiresAt: claims.exp };
      } catch (error) {
        if (error instanceof joseErrors.JWKSTimeout) throw error;
        if (error instanceof joseErrors.JOSEError || error instanceof z.ZodError) {
          throw new IdentityRejected(error.message);
        }
        throw error;
      }
    },

    async signOut(sessionId) {
      const response = await fetcher(`${API}/user_management/sessions/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ session_id: sessionId }),
      });
      // WorkOS answers 404 for an unknown or already revoked session.
      if (!response.ok && response.status !== 404) {
        throw new Error(`WorkOS session revoke failed: ${String(response.status)}`);
      }
    },
  };
}
