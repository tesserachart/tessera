import {
  Key,
  MOTION,
  SPLASH_INTRO_MS,
  SPLASH_MARK_CLASS,
  cx,
  formatCountdown,
  splashMarkSvg,
  useRootFlag,
} from '@tessera/ui';
import wordmark from '@tessera/ui/brand/wordmark.svg';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import {
  DATA_DIR_LOCKED,
  RUNTIME_FAILED,
  RUNTIME_STARTING,
  SESSION_EXPIRED,
  SESSION_MISSING,
  useConnection,
  useNow,
} from '../app/runtimeContext.ts';
import { waitingToRetry } from '@tessera/protocol';
import { connectionNow, retryNow } from '../app/connection.ts';
import { useHostKind } from '../app/host.ts';
import { introElapsed, introPlayed, seamCut, useDropBoot, type SeamCut } from './boot.ts';
import { patch } from '../app/store.ts';
import { arrivalStore } from './arrival.ts';

const SPLASH_BEAT_MS = 320;
export const SPLASH_SPLIT_MS = 1100;

function RetryIn({ at }: { at: number }) {
  const now = useNow();
  return <span className="tabular-nums whitespace-nowrap">{formatCountdown(Math.max(0, at - now))}</span>;
}

const MARK_HTML = { __html: splashMarkSvg() };

export function SplashFrame({
  children,
  leaving,
  className,
  role,
  label,
  style,
  lockRef,
  copy,
  over,
  onboard = false,
}: {
  children?: ReactNode;
  leaving?: boolean;
  className?: string;
  role?: 'alert' | 'dialog';
  label?: string;
  style?: CSSProperties;
  lockRef?: Ref<HTMLDivElement>;
  copy?: boolean;
  over?: ReactNode;
  onboard?: boolean;
}) {
  useRootFlag('data-onboarding', onboard);
  const [at] = useState(() => ({ '--intro-at': `${String(-Math.round(introElapsed()))}ms` }) as CSSProperties);
  useDropBoot();
  return (
    <div
      className={cx('t-splash t-sh-splash', leaving && 'is-leaving', onboard && 't-sh-onboard', className)}
      style={{ ...at, ...style }}
      role={copy ? undefined : role}
      aria-label={copy ? undefined : label}
      aria-modal={role === 'dialog' && !copy ? true : undefined}
      aria-live={copy ? undefined : 'polite'}
      aria-hidden={copy ? true : undefined}
    >
      <div className="lock" ref={lockRef}>
        <i className={SPLASH_MARK_CLASS} role="img" aria-label="Tessera" dangerouslySetInnerHTML={MARK_HTML} />
        <img className="wm" src={wordmark} alt="" />
        {children}
      </div>
      {over}
    </div>
  );
}

export function Splash() {
  const conn = useConnection();
  const hostKind = useHostKind();
  const [details, setDetails] = useState(false);
  const failing = conn.attempt > 0;
  const code = conn.lastErrorCode;
  const expired = code === SESSION_EXPIRED;
  const missing = code === SESSION_MISSING;
  const canRetry = waitingToRetry(conn);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'r' || e.key === 'R') {
        if (waitingToRetry(connectionNow())) retryNow();
      } else if (e.key === 'd' || e.key === 'D') setDetails((d) => !d);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const state = expired
    ? 'Session ended'
    : missing
      ? 'Open the runtime’s URL'
      : code === DATA_DIR_LOCKED
        ? 'Data directory in use'
        : code === RUNTIME_FAILED
          ? 'Runtime failed to start'
          : code === RUNTIME_STARTING
            ? 'Starting runtime'
            : failing
              ? 'Runtime unreachable'
              : hostKind === 'tauri'
                ? 'Starting runtime'
                : 'Connecting';

  if (!failing && !code) return <SplashFrame role="alert" label={state} />;

  const printedUrl = (
    <>
      Open the link the runtime printed when it started (<code>bun run dev</code> and <code>bun run serve</code> print{' '}
      <code>…/#ticket=…</code>)
    </>
  );
  return (
    <SplashFrame role="alert" className="is-failing">
      <div className="say">
        {state}
        {conn.nextRetryAt && canRetry ? (
          <>
            {' '}
            <span className="text-inherit">·</span> next try <RetryIn at={conn.nextRetryAt} />
          </>
        ) : null}
      </div>
      <div className="doc">
        {expired ? (
          <p>
            The runtime serving this page was restarted and has a new token, so this page’s session no longer works.{' '}
            {printedUrl}; this page keeps retrying in case that URL is opened in another tab.
          </p>
        ) : missing ? (
          <p>
            This page has no session with the runtime yet. {printedUrl}: the page keeps its token for this address, so
            reloads and other tabs connect too.
          </p>
        ) : code === DATA_DIR_LOCKED ? (
          <p>
            Another tessera-runtime holds this checkout’s data directory, so the dev server cannot start its own. Stop
            that runtime (often a <code>bun run serve</code> or <code>bun run tauri:dev</code> of the same checkout) or
            give this dev server its own <code>TESSERA_DATA_DIR</code>. It keeps retrying and connects once the
            directory is free.
          </p>
        ) : code === RUNTIME_FAILED ? (
          <p>
            The dev server’s last start of the runtime failed before it was ready, for example on a Rust compile error.
            Its output is in the <code>bun run dev</code> terminal; save a fix and it retries by itself.
          </p>
        ) : code === RUNTIME_STARTING ? (
          <p>
            The dev server is building and starting the runtime (the first cargo build takes a few minutes). This page
            connects as soon as it is ready.
          </p>
        ) : hostKind === 'tauri' ? (
          <p>The desktop shell starts the runtime as a sidecar. It keeps retrying; the shell’s log has its output.</p>
        ) : (
          <p>
            The runtime is not answering yet; this page keeps retrying. In development <code>bun run dev</code> starts
            it; to serve this UI from the runtime, run <code>tessera-runtime serve --ui-dir apps/desktop/dist</code> and
            open the URL it prints.
          </p>
        )}
        {details ? (
          <dl className="kv" aria-label="Details" data-selectable>
            <div>
              <dt>Endpoint</dt>
              <dd title={conn.endpoint ?? undefined}>
                {conn.endpoint ?? (hostKind === 'tauri' ? 'sidecar (starting)' : 'discovering…')}
              </dd>
            </div>
            <div>
              <dt>Attempt</dt>
              <dd className="tabular-nums whitespace-nowrap">{conn.attempt}</dd>
            </div>
            {conn.lastError ? (
              <div>
                <dt>Last error</dt>
                <dd>{conn.lastError}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>
      <div className="acts">
        <button
          type="button"
          onClick={retryNow}
          disabled={!canRetry}
          title={canRetry ? undefined : 'Already trying to reach the runtime'}
        >
          <Key shortcut="r" aria-hidden="true" className="text-on-petrol-2 in-[.show-keys]:text-on-petrol-2" />
          Retry now
        </button>
        <button type="button" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
          <Key shortcut="d" aria-hidden="true" className="text-on-petrol-2 in-[.show-keys]:text-on-petrol-2" />
          Details
        </button>
      </div>
    </SplashFrame>
  );
}

export function SplashRest() {
  return createPortal(
    <SplashFrame className="is-exit">
      <div className="say" aria-hidden="true">
        &nbsp;
      </div>
    </SplashFrame>,
    document.body,
  );
}

export function SplashExit({
  you,
  analyst,
  say = null,
}: {
  you: string | null;
  analyst: string | null;
  say?: string | null;
}) {
  const [phase, setPhase] = useState<'rest' | 'split' | 'parting' | 'leaving' | 'gone'>('rest');
  const [cut, setCut] = useState<SeamCut | null>(null);
  const [played] = useState(introPlayed);
  const lock = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reduced =
      document.documentElement.dataset.motion === 'reduced' ||
      (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const intro = reduced ? 0 : Math.max(0, SPLASH_INTRO_MS - introElapsed());
    const rest = played ? 0 : intro + SPLASH_BEAT_MS;
    let fade: ReturnType<typeof setTimeout> | undefined;
    const go = setTimeout(() => {
      const box = lock.current?.querySelector('.t-intro svg')?.getBoundingClientRect();
      if (played || reduced || !box) {
        setPhase('leaving');
        fade = setTimeout(() => setPhase('gone'), reduced ? 0 : MOTION.fadeMs + 40);
        return;
      }
      setCut(seamCut(box, window.innerHeight));
      setPhase('split');
    }, rest);
    return () => {
      clearTimeout(go);
      clearTimeout(fade);
    };
  }, [played]);
  useEffect(() => {
    if (phase === 'split') {
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setPhase('parting'));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    if (phase === 'parting') {
      const root = document.documentElement;
      root.classList.add('t-arriving');
      const done = setTimeout(() => setPhase('gone'), SPLASH_SPLIT_MS + 40);
      return () => {
        clearTimeout(done);
        root.classList.remove('t-arriving');
      };
    }
    if (phase === 'gone') patch(arrivalStore, { arrived: true });
    return undefined;
  }, [phase]);
  if (phase === 'gone') return null;
  const words =
    you && analyst && !played ? (
      <div className="meet">
        <span>
          You <b>{you}</b>
        </span>
        <span className="t-seam" aria-hidden="true">
          <span />
          <span className="lit" />
        </span>
        <span>
          Analyst <b>{analyst}</b>
        </span>
      </div>
    ) : say && !played ? (
      <div className="say">{say}</div>
    ) : (
      <div className="say" aria-hidden="true">
        &nbsp;
      </div>
    );
  const edge = cut ? (
    <svg className="cut" aria-hidden="true">
      <polyline points={cut.edge} />
    </svg>
  ) : null;
  if (cut && (phase === 'split' || phase === 'parting')) {
    return createPortal(
      <div
        className={cx('t-split', phase === 'parting' && 'is-parting')}
        style={{ '--cut-o': cut.origin } as CSSProperties}
      >
        <SplashFrame className="is-exit is-left" style={{ clipPath: cut.left }} over={edge}>
          {words}
        </SplashFrame>
        <SplashFrame className="is-exit is-right" style={{ clipPath: cut.right }} over={edge} copy>
          {words}
        </SplashFrame>
      </div>,
      document.body,
    );
  }
  return createPortal(
    <SplashFrame leaving={phase === 'leaving'} className="is-exit" lockRef={lock}>
      {words}
    </SplashFrame>,
    document.body,
  );
}
