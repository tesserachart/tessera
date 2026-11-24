import type { RuntimeCredential, RuntimeSessionListener } from './types.ts';

export const LAUNCH_PARAM = 'ticket';
export const RELOAD_TICKET_KEY = 'tessera.reload-ticket';
const RETIRED_TOKEN_KEY = 'tessera.runtime-token';
export const SESSION_CHANNEL = 'tessera.session';
const ASK_MS = 250;

type Message = { kind: 'ask'; from: string } | { kind: 'token'; token: string; to?: string };

export interface PageSessionOptions {
  location: Pick<Location, 'href' | 'reload'>;
  history: Pick<History, 'replaceState' | 'state'>;
  sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  localStorage: Pick<Storage, 'removeItem'> | null;
  channel: Pick<BroadcastChannel, 'postMessage' | 'addEventListener'> | null;
  events: Pick<Window, 'addEventListener'>;
}

export interface PageSession extends RuntimeSessionListener {
  readonly credential: () => Promise<RuntimeCredential | null>;
}

export function pageSession(options: PageSessionOptions): PageSession {
  const { location, history, sessionStorage, localStorage, channel, events } = options;
  const me = randomId();
  let token: string | null = null;
  let refusedToken: string | null = null;
  let reloadTicket: string | null = null;
  const tickets: string[] = [];
  let launch: string | null = null;
  let sent: 'token' | 'ticket' | null = null;
  const waiting = new Set<(token: string) => void>();

  const post = (message: Message) => {
    try {
      channel?.postMessage(message);
    } catch {}
  };

  const adopt = (t: string) => {
    token = t;
    refusedToken = null;
  };

  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const given = fragment.get(LAUNCH_PARAM);
  if (given) {
    launch = given;
    tickets.push(given);
  }
  if (fragment.has(LAUNCH_PARAM)) {
    fragment.delete(LAUNCH_PARAM);
    const rest = fragment.toString();
    history.replaceState(history.state, '', url.pathname + url.search + (rest ? `#${rest}` : ''));
  }

  try {
    const left = sessionStorage?.getItem(RELOAD_TICKET_KEY) ?? null;
    sessionStorage?.removeItem(RELOAD_TICKET_KEY);
    if (left) tickets.push(left);
  } catch {}
  try {
    localStorage?.removeItem(RETIRED_TOKEN_KEY);
  } catch {}

  channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
    const m = event.data;
    if (!isMessage(m)) return;
    if (m.kind === 'ask') {
      if (token && token !== refusedToken) post({ kind: 'token', token, to: m.from });
    } else if (m.to === undefined) {
      adopt(m.token);
    } else if (m.to === me && m.token !== refusedToken) {
      for (const resolve of [...waiting]) resolve(m.token);
    }
  });

  // A link that changes only the fragment does not load the page again.
  events.addEventListener('hashchange', () => {
    if (new URLSearchParams(new URL(location.href).hash.slice(1)).has(LAUNCH_PARAM)) location.reload();
  });
  events.addEventListener('pagehide', () => {
    if (!reloadTicket) return;
    try {
      sessionStorage?.setItem(RELOAD_TICKET_KEY, reloadTicket);
    } catch {}
  });
  // Back from the back/forward cache, the page still holds everything in memory.
  events.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    try {
      sessionStorage?.removeItem(RELOAD_TICKET_KEY);
    } catch {}
  });

  const ask = () =>
    new Promise<string | null>((resolve) => {
      if (!channel) {
        resolve(null);
        return;
      }
      const done = (t: string | null) => {
        clearTimeout(timer);
        waiting.delete(done);
        resolve(t);
      };
      const timer = setTimeout(() => {
        done(null);
      }, ASK_MS);
      waiting.add(done);
      post({ kind: 'ask', from: me });
    });

  return {
    credential: async () => {
      if (token && token !== refusedToken) {
        sent = 'token';
        return { token };
      }
      const ticket = tickets[0];
      if (ticket) {
        sent = 'ticket';
        return { ticket };
      }
      const handed = await ask();
      if (handed) adopt(handed);
      sent = token ? 'token' : null;
      return token ? { token } : null;
    },
    kept: (keep) => {
      reloadTicket = keep.reloadTicket;
      if (sent === 'ticket') {
        if (keep.token && tickets[0] === launch) post({ kind: 'token', token: keep.token });
        tickets.length = 0;
        launch = null;
      }
      if (keep.token) adopt(keep.token);
      else refusedToken = null;
    },
    refused: (problem) => {
      reloadTicket = null;
      if (sent === 'ticket') {
        if (tickets.shift() === launch) launch = null;
      } else if (problem === 'session_expired') {
        refusedToken = token;
      }
    },
  };
}

function isMessage(m: unknown): m is Message {
  if (typeof m !== 'object' || m === null) return false;
  const v = m as Record<string, unknown>;
  if (v.kind === 'ask') return typeof v.from === 'string';
  return (
    v.kind === 'token' &&
    typeof v.token === 'string' &&
    v.token !== '' &&
    (v.to === undefined || typeof v.to === 'string')
  );
}

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${String(Date.now())}-${String(Math.random()).slice(2)}`;
}
