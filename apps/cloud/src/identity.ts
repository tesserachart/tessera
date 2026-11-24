export interface Profile {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  profile: Profile;
}

export interface Claims {
  subject: string;
  sessionId: string;
  expiresAt: number;
}

export interface AuthorizeRequest {
  redirectUri: string;
  state: string;
  codeChallenge?: string;
  loginHint?: string;
}

export interface Identity {
  authorizeUrl(request: AuthorizeRequest): string;
  exchange(code: string, codeVerifier?: string): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens>;
  verify(accessToken: string): Promise<Claims>;
  signOut(sessionId: string): Promise<void>;
}

export class IdentityRejected extends Error {
  override name = 'IdentityRejected';
}
