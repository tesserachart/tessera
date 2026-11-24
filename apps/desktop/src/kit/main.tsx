import '@tessera/ui/styles.css';
import './kit.css';
import { TooltipProvider, installSelectionScope } from '@tessera/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Kit } from './Kit.tsx';
import { HomeKit } from './HomeKit.tsx';
import { ShellFrameKit, SplashKit } from './ShellKit.tsx';
import { DockKit } from './DockKit.tsx';
import { AnalystKit } from './AnalystKit.tsx';

const q = new URLSearchParams(window.location.search);
const page = q.get('p') ?? '2';
const env = q.get('env') ?? 'paper';
const shell = page === 'shell' || page === 'splash';
if (env === 'none') delete document.documentElement.dataset.env;
else document.documentElement.dataset.env = env;
document.documentElement.classList.toggle('kit-shell', shell);
installSelectionScope();
const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      {page === 'dock' ? (
        <DockKit />
      ) : page === 'analyst' ? (
        <AnalystKit />
      ) : page === 'home' ? (
        <HomeKit section={q.get('s') ?? 'levels'} />
      ) : page === 'shell' ? (
        <ShellFrameKit
          env={(['paper', 'eval', 'live', 'none'].includes(env) ? env : 'paper') as never}
          keys={q.get('keys') === '1'}
        />
      ) : page === 'splash' ? (
        <SplashKit say={q.get('say')} />
      ) : (
        <Kit page={page} />
      )}
    </TooltipProvider>
  </StrictMode>,
);
