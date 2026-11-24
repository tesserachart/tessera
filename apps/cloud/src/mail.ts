export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

export class MailFailed extends Error {
  override name = 'MailFailed';
  constructor(readonly code: string) {
    super(`mail not sent: ${code}`);
  }
}

export const FROM = { name: 'Tessera', email: 'beta@tesserachart.com' };

export function cloudflareMailer(binding: SendEmail | undefined): Mailer {
  return {
    async send(email) {
      if (binding === undefined) throw new MailFailed('no_binding');
      try {
        await binding.send({ from: FROM, to: email.to, subject: email.subject, text: email.text, html: email.html });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        throw new MailFailed(typeof code === 'string' ? code : error instanceof Error ? error.message : 'unknown');
      }
    },
  };
}
