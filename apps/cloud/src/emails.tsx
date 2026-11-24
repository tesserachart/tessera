import { chosenFirst, type Download, type Platform, PLATFORM_NAMES } from '@tessera/ui/downloads';
import { firstOpenText } from '@tessera/ui/first-open';
import { html } from 'hono/html';

import type { Email } from './mail.ts';

export interface ApprovalInput {
  to: string;
  name: string | null;
  platform: Platform | null;
  downloads: readonly Download[];
  siteUrl: string;
}

export async function approvalEmail(input: ApprovalInput): Promise<Email> {
  const { to, name, platform, downloads, siteUrl } = input;
  const installUrl = `${siteUrl}/download`;
  const missing = platform !== null && !downloads.some((d) => d.platform === platform) ? platform : null;
  const shown = chosenFirst(downloads, platform);
  const steps = (d: Download) => platform === null || missing !== null || d.platform === platform;
  const greeting = name === null ? 'Hi,' : `Hi ${name},`;
  const lead =
    downloads.length === 0
      ? `Your Tessera alpha account is ready. Download Tessera from ${installUrl} and sign in with ${to}.`
      : `Your Tessera alpha account is ready. Download Tessera and sign in with ${to}.`;

  const text = [
    greeting,
    lead,
    ...shown.flatMap((d) => [
      `Download for ${PLATFORM_NAMES[d.platform]} (${d.meta}):\n${d.url}`,
      ...(steps(d) ? [firstOpenText(d.firstOpen)] : []),
    ]),
    ...(missing === null ? [] : [`Tessera for ${PLATFORM_NAMES[missing]} is not out yet.`]),
    ...(downloads.length === 0 ? [] : [`Install steps: ${installUrl}`]),
    'Tessera',
  ].join('\n\n');

  const page = (
    <html lang="en">
      <body style="margin:0;padding:32px 16px;background:#003648;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55">
        <div style="max-width:520px;margin:0 auto;padding:32px;background:#f6f9f9;color:#0b1418">
          <p style="margin:0 0 16px">{greeting}</p>
          <p style="margin:0 0 24px">
            {downloads.length === 0 ? (
              <>
                Your Tessera alpha account is ready. Download Tessera from <a href={installUrl}>{installUrl}</a> and
                sign in with <strong>{to}</strong>.
              </>
            ) : (
              <>
                Your Tessera alpha account is ready. Download Tessera and sign in with <strong>{to}</strong>.
              </>
            )}
          </p>
          {shown.map((d) => (
            <div style="margin:0 0 24px">
              <a
                href={d.url}
                style="display:inline-block;padding:12px 20px;background:#0b2a33;color:#eaf8f6;font-weight:600;text-decoration:none"
              >
                Download for {PLATFORM_NAMES[d.platform]}
              </a>
              <p style="margin:8px 0 0;color:#56646b;font-size:13px">{d.meta}</p>
              {steps(d) ? (
                <div style="margin:16px 0 0;color:#56646b">
                  <p style="margin:0 0 8px">{d.firstOpen.intro}</p>
                  <ol style="margin:0 0 8px;padding-left:20px">
                    {d.firstOpen.steps.map((step) => (
                      <li style="margin:0 0 6px">{step}</li>
                    ))}
                  </ol>
                  {d.firstOpen.alternative === undefined ? null : <p style="margin:0">{d.firstOpen.alternative}</p>}
                </div>
              ) : null}
            </div>
          ))}
          {missing === null ? null : (
            <p style="margin:0 0 24px">Tessera for {PLATFORM_NAMES[missing]} is not out yet.</p>
          )}
          {downloads.length === 0 ? null : (
            <p style="margin:0 0 24px">
              <a href={installUrl} style="color:#147387">
                Install steps
              </a>
            </p>
          )}
          <p style="margin:0;color:#56646b">Tessera</p>
        </div>
      </body>
    </html>
  );

  return {
    to,
    subject: 'Your Tessera alpha access is ready',
    text,
    html: String(await html`<!doctype html>${page}`),
  };
}
