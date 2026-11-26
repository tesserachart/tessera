import { formatPercent, formatPrice, useDocumentEnv, usePlatform, useShowKeysOnHold } from '@tessera/ui';
import { useEffect, useRef } from 'react';
import { useSignInFocus } from '../account/signInFocus.ts';
import { AlertsData } from '../alerts/AlertsData.tsx';
import { AnalystData } from '../analyst/AnalystData.tsx';
import { AreaRail } from '../areas/AreaRail.tsx';
import { AreaView } from '../areas/AreaView.tsx';
import { useProfileCommand } from '../areas/profile/hooks.ts';
import { openSettings } from '../areas/settings/store.ts';
import { watchForUpdates } from '../app/updates.ts';
import { DeskToasts } from '../workspace/dock/DeskToasts.tsx';
import { setWindowTitle } from '../app/host.ts';
import { useTelemetry } from '../app/telemetry.ts';
import { useConnection } from '../app/runtimeContext.ts';
import { registerBuiltinCommands } from '../commands/builtin.ts';
import { commands } from '../commands/registry.ts';
import { useKeybindings } from '../commands/useKeybindings.ts';
import { displaySymbol, useInstrumentSpec } from '../market/instruments.ts';
import { quoteChange, useQuote } from '../market/quotes.ts';
import { useSettingsSync } from '../state/settingsSync.ts';
import { useFollowScheme } from '../theme/follow.ts';
import { setComposerDraft } from '../state/ui.ts';
import { useActiveChart } from '../state/workspace.ts';
import { Workspace } from '../workspace/Workspace.tsx';
import { focusComposer } from './composer.ts';
import { ShellDataProvider } from './ShellData.tsx';
import { useShellData } from './shellData.ts';
import { Annunciator } from './Annunciator.tsx';
import { ConnectionStatus } from './ConnectionStatus.tsx';
import { RithmicMarks } from './RithmicMarks.tsx';
import { HistoryStatus } from './HistoryStatus.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { KeyOverlay } from './KeyOverlay.tsx';
import { windowTitle } from './marks.ts';
import { useWindowChrome } from './titleBar.ts';
import { WindowControls } from './WindowControls.tsx';
import { Arrival } from './Arrival.tsx';
import { UpdateDialog } from './UpdateDialog.tsx';
import { FeedbackDialog } from '../feedback/FeedbackDialog.tsx';
import { listenForSharedLinks } from '../share/open.ts';
import { ShareDialog } from '../share/ShareDialog.tsx';
import { SharedLinkDialog } from '../share/SharedLinkDialog.tsx';
import { WorkspaceDialogs } from '../frame/WorkspaceDialogs.tsx';
import { UpdatePrompt } from './UpdatePrompt.tsx';
import { arrivalStore } from './arrival.ts';
import { useStaleNotices } from './staleNotices.ts';
import { useCopyNotes } from './copyNotes.ts';
import { useSurveyInvite } from './surveyInvite.ts';
import { read, useStore } from '../app/store.ts';
import { areaStore, showArea } from '../areas/store.ts';
import { revealTile } from '../workspace/dock/open.ts';

function WindowTitle() {
  const chart = useActiveChart();
  const { drafts } = useShellData();
  const spec = useInstrumentSpec(chart?.instrument ?? null);
  const id = spec?.instrument ?? chart?.instrument ?? null;
  const q = useQuote(id);
  const { pct } = quoteChange(q);
  const title = windowTitle({
    symbol: id ? displaySymbol(id) : null,
    last: (q?.last ?? null) === null ? null : formatPrice(q?.last, spec?.priceDecimals ?? 2),
    pct: pct === null ? null : formatPercent(pct),
    drafts,
  });
  const last = useRef({ title: '', at: 0 });
  useEffect(() => {
    const now = Date.now();
    if (title === last.current.title) return;
    const wait = Math.max(0, 1000 - (now - last.current.at));
    const t = setTimeout(() => {
      last.current = { title, at: Date.now() };
      void setWindowTitle(title).catch(() => undefined);
    }, wait);
    return () => clearTimeout(t);
  }, [title]);
  return null;
}

function Frame() {
  useSettingsSync();
  useFollowScheme();
  const link = useConnection().status;
  const chrome = useWindowChrome();
  const { env } = useShellData();
  const onboarding = useStore(arrivalStore, (s) => s.onboarding);
  useDocumentEnv(env);
  return (
    <div className="t-app t-shell" data-link={link === 'open' ? undefined : 'down'} data-chrome={chrome}>
      <AreaRail />
      <div className="t-shell-body">
        <AreaView desk={<Workspace />} />
        <CommandPalette />
      </div>
      {onboarding ? null : <KeyOverlay />}
      <footer className="t-shell-footer" aria-label="Status and notices">
        <Annunciator />
        <DeskToasts />
        <HistoryStatus />
        <ConnectionStatus />
        <RithmicMarks opensNotices />
      </footer>
      {chrome === 'custom' ? <WindowControls className="shell-wc" /> : null}
      <WindowTitle />
      <UpdatePrompt />
      <UpdateDialog />
      <FeedbackDialog />
      <ShareDialog />
      <SharedLinkDialog />
      <WorkspaceDialogs />
      <Arrival />
    </div>
  );
}

function useShellEvents() {
  useEffect(() => {
    const onHome = (e: Event) => {
      const section = (e as CustomEvent<{ section?: unknown } | null>).detail?.section;
      openSettings(typeof section === 'string' ? section : null);
    };
    const onAsk = (e: Event) => {
      const text = (e as CustomEvent<{ text?: unknown } | null>).detail?.text;
      if (read(areaStore).area === 'desk') revealTile('analyst', { via: 'pointer' });
      else showArea('agents');
      if (typeof text === 'string') setComposerDraft(text);
      focusComposer();
    };
    window.addEventListener('tessera:open-home', onHome);
    window.addEventListener('tessera:ask-analyst', onAsk);
    return () => {
      window.removeEventListener('tessera:open-home', onHome);
      window.removeEventListener('tessera:ask-analyst', onAsk);
    };
  }, []);
}

function ShellEffects() {
  useShellEvents();
  useTelemetry();
  useSurveyInvite();
  useSignInFocus();
  useProfileCommand();
  useStaleNotices();
  useCopyNotes();
  return null;
}

export function Shell() {
  const platform = usePlatform();
  const onboarding = useStore(arrivalStore, (s) => s.onboarding);
  useKeybindings(commands, !onboarding);
  useShowKeysOnHold(platform);
  useEffect(() => registerBuiltinCommands(commands, { runtime: true, focusComposer }), []);
  useEffect(() => watchForUpdates(), []);
  useEffect(() => listenForSharedLinks('desk'), []);
  return (
    <ShellDataProvider>
      <AnalystData />
      <AlertsData deliver />
      <Frame />
      <ShellEffects />
    </ShellDataProvider>
  );
}
