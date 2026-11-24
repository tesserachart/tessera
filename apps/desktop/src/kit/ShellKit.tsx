import { Icon, Mark, RailItem, cx, envKind, type EnvironmentName, ICON_BUTTON } from '@tessera/ui';
import '../styles/shell.css';
import '../styles/frame.css';
import '../styles/rail.css';
import { SplashFrame } from '../shell/Splash.tsx';

type KitEnv = 'paper' | 'eval' | 'live' | 'none';

function KitRow({ tabs, focused, end }: { tabs: string[]; focused?: boolean; end?: boolean }) {
  return (
    <div className={cx('kit-band-row', focused && 'is-focused')} data-band-end={end ? '' : undefined}>
      {tabs.map((t, i) => (
        <span key={t} className={cx('dock-tab', i === 0 && 'kit-on')}>
          <span className="dock-tab-title">{t}</span>
        </span>
      ))}
      <span className="kit-void" />
    </div>
  );
}

export function ShellFrameKit({ env, keys }: { env: KitEnv; keys: boolean }) {
  const first = env === 'none';
  const wordEnv: EnvironmentName | null = first ? null : env;
  return (
    <div
      className={cx('t-app t-shell kit-shell', keys && 'show-keys')}
      data-chrome="custom"
      data-env={wordEnv ? envKind(wordEnv) : undefined}
    >
      <div className="ar-rail">
        <div className="ar-rail-head">
          <span className="app-menu-btn">
            <Mark size={20} />
          </span>
        </div>
        <nav className="ar-rail-nav" aria-label="Areas">
          <div className="ar-rail-top">
            <RailItem icon="desk" label="Desk" current />
            <RailItem icon="markets" label="Markets" />
          </div>
        </nav>
      </div>
      <div className="t-shell-body kit-band">
        <KitRow tabs={['NQ Z6 · 5m']} focused />
        <KitRow tabs={['NQ Z6 · 1m']} />
        <KitRow tabs={['Trade', 'Analyst']} end />
      </div>
      <div className="window-controls shell-wc">
        {(['minimise', 'maximise', 'close'] as const).map((i) => (
          <span key={i} className={ICON_BUTTON}>
            <Icon name={i} />
          </span>
        ))}
      </div>
    </div>
  );
}

export function SplashKit({ say }: { say: string | null }) {
  return (
    <SplashFrame>
      {say ? (
        <div className="say">{say}</div>
      ) : (
        <div className="meet">
          <span>
            You <b>Paper</b>
          </span>
          <span className="t-seam" aria-hidden="true">
            <span />
            <span className="lit" />
          </span>
          <span>
            Analyst <b>Codex</b>
          </span>
        </div>
      )}
    </SplashFrame>
  );
}
