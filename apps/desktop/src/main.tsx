import '@tessera/ui/styles.css';
import 'dockview-react/dist/styles/dockview.css';
import './styles/app.css';
import { makeBridge, parseTileWindowSearch } from '@tessera/bridge';
import { brandFontsReady, installInputModality, installResizeQuiet, installSelectionScope } from '@tessera/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { applyChrome } from './app/chrome.ts';
import { installSystemMode, installTheme, installWindowAppearance } from './theme/store.ts';
import { appServices } from './app/runtime.ts';
import { installTelemetry, reportError } from './app/telemetry.ts';
import { uiStore } from './state/ui.ts';
import { read, watch } from './app/store.ts';

const FONT_WAIT_MS = 2000;

async function main(): Promise<void> {
  installTelemetry();
  installTheme();
  installSystemMode();
  applyChrome(read(uiStore));
  watch(uiStore, (s) => applyChrome(s));
  installResizeQuiet();
  installInputModality();
  installSelectionScope();

  const [host] = await Promise.all([
    makeBridge({ discovery: import.meta.env.DEV ? 'dev' : 'auto' }),
    brandFontsReady(typeof document === 'undefined' ? null : document.fonts, FONT_WAIT_MS),
  ]);
  installWindowAppearance(host.window);
  const tile = parseTileWindowSearch(window.location.search);

  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  createRoot(root, {
    onUncaughtError: (error, info) => {
      console.error('the window stopped drawing', error, info.componentStack);
      reportError(error, { kind: 'render', place: 'Window', componentStack: info.componentStack });
    },
  }).render(
    <StrictMode>
      <App services={appServices(host)} tile={tile} />
    </StrictMode>,
  );
}

void main();
