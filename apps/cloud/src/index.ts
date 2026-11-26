import { createApp } from './app.ts';
import { ASSETS } from './assets.ts';
import { downloads, publishedPlatforms } from '@tessera/ui/downloads';
import { DEFAULT_FEEDBACK_BRANCH, githubTracker, privateKeyPem } from './github.ts';
import { cloudflareMailer } from './mail.ts';
import { sessions } from './session.ts';
import { r2Bodies } from './shares.ts';
import { store } from './store.ts';
import { workos } from './workos.ts';

export interface Env {
  DB: D1Database;
  EMAIL?: SendEmail;
  WORKOS_CLIENT_ID: string;
  WORKOS_API_KEY: string;
  SESSION_SECRET?: string;
  SITE_URL: string;
  UPDATES_URL?: string;
  PLATFORMS?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  FEEDBACK_REPO: string;
  FEEDBACK_BRANCH?: string;
  SHARE_IMAGES?: R2Bucket;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function issueTracker(env: Env) {
  const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_INSTALLATION_ID: installationId } = env;
  if (!present(appId) || !present(privateKey) || !present(installationId) || !present(env.FEEDBACK_REPO)) return null;
  return githubTracker({
    appId,
    privateKey: privateKeyPem(privateKey),
    installationId,
    repo: env.FEEDBACK_REPO,
    branch: present(env.FEEDBACK_BRANCH) ? env.FEEDBACK_BRANCH : DEFAULT_FEEDBACK_BRANCH,
  });
}

export default createApp<Env>((env) => ({
  identity: workos({ clientId: env.WORKOS_CLIENT_ID, apiKey: env.WORKOS_API_KEY }),
  store: store(env.DB),
  sessions: sessions(env.SESSION_SECRET ?? ''),
  mailer: cloudflareMailer(env.EMAIL),
  issues: issueTracker(env),
  shares: env.SHARE_IMAGES === undefined ? null : r2Bodies(env.SHARE_IMAGES),
  site: {
    url: env.SITE_URL.replace(/\/+$/, ''),
    downloads: downloads(env.UPDATES_URL ?? '', publishedPlatforms(env.PLATFORMS ?? '')),
  },
  assets: ASSETS,
  now: () => new Date(),
}));
