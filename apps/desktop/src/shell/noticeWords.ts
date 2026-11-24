import { screenWords } from './deskWords.ts';

export interface NoticeSource {
  tone: 'ok' | 'err' | 'info';
  text: string;
  what?: string;
  head?: string;
}

export interface NoticeWords {
  title: string;
  detail: string | null;
}

const NOTHING_SENT = /[.\s]*\bNothing sent\.?$/;
const NOT_SENT = 'Not sent';
const DID_NOT_GO = 'It did not go through. Check Orders.';

function escaped(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function line(s: string): string {
  const t = s.trim().replace(/\.$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function withoutAccount(text: string, account: string | null): string {
  if (!account) return text;
  const name = escaped(account);
  const prefixed = new RegExp(`^${name}(?: \\([^()]*\\))?: `);
  if (prefixed.test(text)) return text.replace(prefixed, '');
  return text.replace(new RegExp(`^${name} \\([^()]*\\) (?=\\S)`), 'This account ');
}

export function noticeWords(r: NoticeSource, account: string | null = null): NoticeWords {
  if (r.head) {
    const under = noticeWords({ tone: r.tone, text: r.text, what: r.what }, account);
    return { title: r.head, detail: under.title === NOT_SENT ? under.detail : noticeLine(under) };
  }
  const text = withoutAccount(r.text.trim(), account);
  const what = r.what && text.startsWith(`${r.what}: `) ? r.what : null;
  const said = what ? withoutAccount(text.slice(what.length + 2), account) : text;
  if (r.tone === 'err' && NOTHING_SENT.test(said)) {
    const why = screenWords(said.replace(NOTHING_SENT, ''), '');
    return { title: NOT_SENT, detail: why ? line(why) : null };
  }
  const rest = r.tone === 'err' ? screenWords(said, DID_NOT_GO) : said;
  if (what) return { title: line(rest), detail: what };
  const cut = rest.indexOf('; ');
  if (cut > 0) return { title: line(rest.slice(0, cut)), detail: line(rest.slice(cut + 2)) };
  return { title: line(rest), detail: null };
}

export function noticeLine(r: NoticeSource | NoticeWords, account: string | null = null): string {
  const w = 'title' in r ? r : noticeWords(r, account);
  return w.detail ? `${w.title}: ${w.detail}` : w.title;
}

export function refusedLine(r: { text: string; what: string }, account: string | null): string {
  const w = noticeWords({ tone: 'err', text: r.text, what: r.what }, account);
  return w.detail ? `${w.detail} · ${w.title}` : w.title;
}
