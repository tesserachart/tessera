import type { Services } from './app.ts';
import { approvalEmail } from './emails.tsx';
import { MailFailed } from './mail.ts';
import type { User } from './store.ts';

export const STALE_SEND_MS = 5 * 60 * 1000;

export async function sendApproval(services: Services, person: User, resend: boolean): Promise<void> {
  const { store, mailer, site, now } = services;
  const claimed = await store.claimApprovalEmail(
    person.id,
    now(),
    resend ? { staleBefore: new Date(now().getTime() - STALE_SEND_MS) } : undefined,
  );
  if (!claimed) return;
  const application = await store.application(person.id);
  const email = await approvalEmail({
    to: person.email,
    name: person.name,
    platform: application?.platform ?? null,
    downloads: site.downloads,
    siteUrl: site.url,
  });
  let error: string | null = null;
  try {
    await mailer.send(email);
  } catch (failure) {
    error = failure instanceof MailFailed ? failure.code : 'unknown';
    console.error('approval email failed', person.id, failure);
  }
  await store.finishApprovalEmail(person.id, error, now());
}
