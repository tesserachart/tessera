import { ToolFailed, type Layout, type LayoutSummary, type Timeframe } from '@tessera/protocol';
import {
  Button,
  Dialog,
  DialogContent,
  Mark,
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  TextInput,
  Tooltip,
} from '@tessera/ui';
import { useState, type SyntheticEvent } from 'react';
import { refreshTools, useHasTool, useToolValue, runTool } from '../app/tools.ts';
import { FEEDBACK_KEY } from '../feedback/model.ts';
import { openFeedback } from '../feedback/store.ts';
import { writeSetting } from '../state/runtimeSettings.ts';
import { useServer } from '../app/runtimeContext.ts';
import { useClock } from '../app/clock.ts';
import { appHost } from '../app/services.ts';
import { checkAction, checkForUpdates, useUpdate } from '../app/updates.ts';
import { displaySymbol } from '../market/instruments.ts';
import { newChartSetup } from '../chart/templates/model.ts';
import { templatesStore } from '../chart/templates/store.ts';
import { RETIRED_AREA_LAYOUTS, useStageView, seedLayout } from '../state/layouts.ts';
import { useUi, setWorkspace, uiStore } from '../state/ui.ts';
import { activeChartTarget, resetWorkspaceLayout, saveLayout } from '../workspace/controller.ts';
import { leaveWorkspace, revertWorkspace, saveWorkspace, switchWorkspace, useUnsaved } from '../workspace/document.ts';
import { SAVE_WORKSPACE_KEY } from '../shell/keys.ts';
import { newWorkspaceLayout } from '../workspace/layouts.ts';
import { STORY_PRESETS, storyLayout, storyName, storyPreset, type StoryPreset } from '../workspace/presets.ts';
import { appMenuStore } from './appMenuStore.ts';
import { ArrangeSub } from './ArrangeSub.tsx';
import { PanelsSub } from './PanelsSub.tsx';
import {
  chartsBrief,
  copyName,
  newWorkspaceId,
  nextWorkspaceName,
  preferredInstrument,
  retargetDock,
} from './workspaces.ts';
import { read, patch, useStore } from '../app/store.ts';

type Ask = { kind: 'rename' | 'save-as' | 'delete'; w: LayoutSummary } | null;

function NameDialog({
  title,
  verb,
  start,
  unchanged,
  onDone,
}: {
  title: string;
  verb: string;
  start: string;
  unchanged: string | null;
  onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(start);
  const submit = (e: SyntheticEvent) => {
    e.preventDefault();
    const name = value.trim();
    onDone(name && name !== unchanged ? name : null);
  };
  return (
    <DialogContent className="ws-dialog" title={title}>
      <form className="ws-form" onSubmit={submit}>
        <TextInput
          aria-label="Workspace name"
          value={value}
          maxLength={64}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="ws-acts">
          <Button variant="quiet" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!value.trim()}>
            {verb}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

function DeleteDialog({ w, onDone }: { w: LayoutSummary; onDone: (ok: boolean) => void }) {
  const brief = chartsBrief(w.charts);
  return (
    <DialogContent
      className="ws-dialog"
      title={`Delete ${w.name}?`}
      description={brief ? `Its charts (${brief}), their drawings and its arrangement go.` : 'Its arrangement goes.'}
    >
      <div className="ws-acts">
        <Button variant="quiet" autoFocus onClick={() => onDone(false)}>
          Keep
        </Button>
        <Button variant="destructive" what={w.name} onClick={() => onDone(true)}>
          Delete
        </Button>
      </div>
    </DialogContent>
  );
}

function rowHint(w: LayoutSummary, defaultId: string): string | undefined {
  const words = [w.unsaved ? 'edited' : null, w.id === defaultId ? 'default' : null].filter((x) => x !== null);
  return words.length > 0 ? words.join(' · ') : undefined;
}

export function AppMenu() {
  const clock = useClock();
  const updateAction = checkAction(useUpdate());
  const server = useServer();
  const canList = useHasTool('layout.list');
  const open = useStore(appMenuStore, (s) => s.open);
  const sub = useStore(appMenuStore, (s) => s.sub);
  const list = useToolValue('layout.list', canList ? {} : null, { keepFor: 0 });
  const picked = useUi((s) => s.workspace);
  const [ask, setAsk] = useState<Ask>(null);
  const [error, setError] = useState<string | null>(null);
  const activeId = list?.activeId ?? server?.defaultLayoutId ?? 'default';
  const openId = picked ?? server?.defaultLayoutId ?? activeId;
  const rows = (list?.layouts ?? []).filter((l) => !RETIRED_AREA_LAYOUTS.includes(l.id));
  const current = rows.find((w) => w.id === openId) ?? null;
  const name = current?.name ?? 'Workspace';
  const names = rows.map((w) => w.name);

  const run = (fn: () => Promise<void>) => {
    setError(null);
    void fn()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        patch(appMenuStore, { open: true, sub: null });
      })
      .finally(() => void refreshTools('layout.list'));
  };
  const show = (id: string) => setWorkspace(id);
  const switchTo = (id: string) =>
    run(async () => {
      await switchWorkspace(id);
    });
  const openNew = async (fresh: Layout, failed: (err: unknown) => unknown = (err) => err) => {
    const left = await leaveWorkspace();
    if (!left) return;
    const saved = runTool('layout.save', {
      layoutId: fresh.id,
      name: fresh.name,
      ...(fresh.dock ? { dock: fresh.dock } : {}),
      charts: fresh.charts,
      ...(fresh.activeChartId ? { activeChartId: fresh.activeChartId } : {}),
    });
    seedLayout(fresh, saved);
    const back = openId;
    show(fresh.id);
    await saved.catch((err: unknown) => {
      if (read(uiStore).workspace === fresh.id) show(back);
      throw failed(err);
    });
    await left();
  };

  const create = () =>
    run(async () => {
      const settings = await runTool('settings.get', {
        keys: ['market.defaultInstrument', 'chart.defaultTimeframe'],
      }).catch(() => null);
      const chosen = settings?.settings['market.defaultInstrument']?.value;
      const timeframe = settings?.settings['chart.defaultTimeframe']?.value;
      const id = newWorkspaceId(clock.now());
      const tpl = read(templatesStore);
      const fresh = newWorkspaceLayout(id, clock.now() * 1e6, {
        name: nextWorkspaceName(names),
        instrument: preferredInstrument({ chosen, active: activeChartTarget() }),
        timeframe: typeof timeframe === 'string' ? (timeframe as Timeframe) : undefined,
        setup: newChartSetup(tpl, tpl.loaded),
      });
      await openNew(fresh);
    });
  const fromStory = (story: StoryPreset) =>
    run(async () => {
      const settings = await runTool('settings.get', { keys: ['market.defaultInstrument'] }).catch(() => null);
      const chosen = settings?.settings['market.defaultInstrument']?.value;
      const instrument = preferredInstrument({ chosen, active: activeChartTarget() });
      const id = newWorkspaceId(clock.now());
      const tpl = read(templatesStore);
      const fresh = storyLayout(story, {
        layoutId: id,
        name: storyName(story, names),
        nowNs: clock.now() * 1e6,
        instrument,
        setup: newChartSetup(tpl, tpl.loaded),
      });
      await openNew(fresh, (err) =>
        err instanceof ToolFailed && err.code === 'not_found' && instrument
          ? new Error(`${story.label} opens on ${displaySymbol(instrument)}, which no connection serves now`)
          : err,
      );
    });
  const saveAs = (w: LayoutSummary, name: string) =>
    run(async () => {
      await saveLayout();
      const full = await runTool('layout.get', { layoutId: w.id });
      const id = newWorkspaceId(clock.now());
      await runTool('layout.save', {
        layoutId: id,
        name,
        dock: retargetDock(full.dock, full.id, id),
        charts: full.charts,
        ...(full.activeChartId ? { activeChartId: full.activeChartId } : {}),
      });
      show(id);
      if (full.unsaved) await revertWorkspace(w.id);
    });
  const rename = (w: LayoutSummary, to: string) =>
    run(async () => {
      await runTool('layout.save', { layoutId: w.id, name: to });
    });
  const makeDefault = (w: LayoutSummary) =>
    run(async () => {
      await writeSetting('workspace.activeLayoutId', w.id);
    });
  const remove = (w: LayoutSummary) =>
    run(async () => {
      if (openId === w.id) show(activeId);
      await runTool('layout.delete', { layoutId: w.id });
    });

  const isDefault = current?.id === activeId;
  const unsaved = useUnsaved(current ? openId : null);
  const label = unsaved ? `${name} — Edited` : name;
  const storyId = useStageView(openId).story;
  const story = storyId ? storyPreset(storyId) : null;
  return (
    <>
      <Menu
        open={open}
        onOpenChange={(o) => {
          patch(appMenuStore, o ? { open: true } : { open: false, sub: null });
          if (o) void refreshTools('layout.list');
        }}
      >
        <Tooltip content={label} side="right">
          <MenuTrigger asChild>
            <button
              type="button"
              className="app-menu-btn"
              aria-label={`Tessera menu: ${label}`}
              data-unsaved={unsaved ? '' : undefined}
            >
              <Mark size={20} />
            </button>
          </MenuTrigger>
        </Tooltip>
        <MenuContent align="start" side="right" className="app-menu" style={{ width: 264 }}>
          <div className="app-menu-head">
            <span className="nm">
              {name}
              {unsaved ? <span className="ed"> — Edited</span> : null}
            </span>
            {current && current.charts.length > 0 ? <span className="br">{chartsBrief(current.charts)}</span> : null}
          </div>
          <MenuSeparator />
          {rows.length > 0 ? (
            <MenuSub
              open={sub === 'workspaces'}
              onOpenChange={(o) => patch(appMenuStore, { sub: o ? 'workspaces' : null })}
            >
              <MenuSubTrigger>Switch workspace</MenuSubTrigger>
              <MenuSubContent className="ws-menu" style={{ width: 280 }} onFocusOutside={(e) => e.preventDefault()}>
                <MenuRadioGroup value={openId} onValueChange={switchTo}>
                  {rows.map((w) => (
                    <MenuRadioItem key={w.id} value={w.id} hint={rowHint(w, activeId)}>
                      <span className="ws-row">
                        <span className="nm">{w.name}</span>
                        <span className="br">{chartsBrief(w.charts)}</span>
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuSubContent>
            </MenuSub>
          ) : null}
          {canList ? (
            <>
              <MenuItem onSelect={create}>New workspace</MenuItem>
              <MenuSub>
                <MenuSubTrigger>New from preset</MenuSubTrigger>
                <MenuSubContent className="ws-menu" style={{ width: 280 }}>
                  {STORY_PRESETS.map((p) => (
                    <MenuItem key={p.id} onSelect={() => fromStory(p)}>
                      <span className="ws-row">
                        <span className="nm">{p.label}</span>
                        <span className="br">{p.brief}</span>
                      </span>
                    </MenuItem>
                  ))}
                </MenuSubContent>
              </MenuSub>
              <MenuSeparator />
              {current ? (
                <>
                  <MenuItem shortcut={SAVE_WORKSPACE_KEY} onSelect={() => run(() => saveWorkspace())}>
                    Save
                  </MenuItem>
                  <MenuItem onSelect={() => setAsk({ kind: 'save-as', w: current })}>Save as…</MenuItem>
                  {unsaved ? <MenuItem onSelect={() => run(() => revertWorkspace())}>Revert to saved</MenuItem> : null}
                  <MenuItem onSelect={() => setAsk({ kind: 'rename', w: current })}>Rename…</MenuItem>
                  {isDefault ? null : <MenuItem onSelect={() => makeDefault(current)}>Set as default</MenuItem>}
                </>
              ) : null}
            </>
          ) : null}
          <MenuItem onSelect={() => void resetWorkspaceLayout()}>
            {story ? `Reset to ${story.label}` : 'Reset to default'}
          </MenuItem>
          {current ? (
            <MenuItem
              destructive
              disabled={isDefault}
              hint={isDefault ? 'the default' : undefined}
              onSelect={() => setAsk({ kind: 'delete', w: current })}
            >
              Delete…
            </MenuItem>
          ) : null}
          <MenuSeparator />
          {appHost().updates ? (
            <>
              <MenuItem disabled={updateAction.busy} onSelect={() => void checkForUpdates()}>
                {updateAction.words}
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          <PanelsSub />
          <ArrangeSub
            layoutId={openId}
            open={sub === 'arrange'}
            onOpenChange={(o) => patch(appMenuStore, { sub: o ? 'arrange' : null })}
          />
          <MenuSeparator />
          <MenuItem shortcut={FEEDBACK_KEY} onSelect={() => openFeedback()}>
            Send feedback…
          </MenuItem>
          {error ? (
            <div className="ws-err" role="alert">
              {error}
            </div>
          ) : null}
        </MenuContent>
      </Menu>
      <Dialog open={ask !== null} onOpenChange={(o) => (o ? undefined : setAsk(null))}>
        {ask?.kind === 'rename' ? (
          <NameDialog
            title="Rename workspace"
            verb="Rename"
            start={ask.w.name}
            unchanged={ask.w.name}
            onDone={(to) => {
              setAsk(null);
              if (to) rename(ask.w, to);
            }}
          />
        ) : ask?.kind === 'save-as' ? (
          <NameDialog
            title="Save as a new workspace"
            verb="Save"
            start={copyName(ask.w.name, names)}
            unchanged={null}
            onDone={(to) => {
              setAsk(null);
              if (to) saveAs(ask.w, to);
            }}
          />
        ) : ask?.kind === 'delete' ? (
          <DeleteDialog
            w={ask.w}
            onDone={(ok) => {
              setAsk(null);
              if (ok) remove(ask.w);
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}
