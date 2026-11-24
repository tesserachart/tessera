import {
  Button,
  ICON,
  Icon,
  Menu,
  MenuContent,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchList,
  Tooltip,
  cx,
  type ComboboxOption,
} from '@tessera/ui';
import { useState } from 'react';
import { meterBars } from './composerFoot.ts';
import {
  effortOf,
  effortRank,
  findModel,
  pickWords,
  providerIcon,
  unavailableWhy,
  type ModelPick,
  type ProviderView,
} from './models.ts';

export function ModelPicker({
  providers,
  pick,
  sessionProvider,
  onPick,
  onTurnOn,
  disabled = false,
}: {
  providers: readonly ProviderView[];
  pick: ModelPick | null;
  sessionProvider: string | null;
  onPick: (pick: ModelPick) => void;
  onTurnOn?: (providerId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rail, setRail] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const shown = rail ?? pick?.provider ?? providers[0]?.id ?? null;
  const provider = providers.find((p) => p.id === shown) ?? null;
  const searching = query.trim().length > 0;
  const list = searching ? providers : provider ? [provider] : [];
  const options: ComboboxOption[] = list.flatMap((p) =>
    p.models.map((m) => ({
      value: `${p.id}\u0000${m.id}`,
      label: m.label,
      keywords: [m.id, p.name],
      ...(searching ? { group: p.name } : {}),
      disabled: !p.ready,
      hint:
        sessionProvider && p.id !== sessionProvider ? 'new session' : m.id === p.defaultModel ? 'default' : undefined,
    })),
  );
  const current = pick ? `${pick.provider}\u0000${pick.model ?? provider?.defaultModel ?? ''}` : null;
  const why = provider ? unavailableWhy(provider) : null;
  const words = pickWords(providers, pick);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setRail(null);
          setQuery('');
        }
      }}
    >
      <Tooltip content={words.full} side="top">
        <PopoverTrigger asChild disabled={disabled}>
          <button type="button" className="ag-ctl ag-model" aria-label={`Model: ${words.full}`}>
            {pick ? <Icon name={providerIcon(pick.provider)} /> : null}
            <span className="tt">{words.short}</span>
            <Icon name="chevron-down" className="cv" />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent className="ag-picker" side="top" align="start" sideOffset={8}>
        <div className="ag-picker-rail" role="toolbar" aria-label="Providers" aria-orientation="vertical">
          {providers.map((p) => (
            <Tooltip
              key={p.id}
              side="left"
              content={p.ready ? `${p.name} · ${p.message ?? 'ready'}` : `${p.name} · ${unavailableWhy(p) ?? ''}`}
            >
              <button
                type="button"
                className={cx('ag-picker-prov', p.id === shown && 'is-on', !p.ready && 'is-off')}
                aria-label={p.name}
                aria-pressed={p.id === shown}
                onClick={() => {
                  setRail(p.id);
                  setQuery('');
                }}
              >
                <Icon name={providerIcon(p.id)} />
              </button>
            </Tooltip>
          ))}
        </div>
        <div className="ag-picker-main">
          {provider && !searching ? (
            <div className="ag-picker-head">
              <b>{provider.name}</b>
              <span>{provider.ready ? (provider.message ?? '') : ''}</span>
            </div>
          ) : null}
          <SearchList
            label="Models"
            placeholder="Search models"
            options={options}
            value={current}
            query={query}
            onQueryChange={setQuery}
            autoFocus
            empty="No model matches"
            onSelect={(v) => {
              const [prov, model] = v.split('\u0000');
              if (!prov || !model) return;
              onPick({
                provider: prov,
                model,
                effort: prov === pick?.provider && model === pick.model ? pick.effort : null,
              });
              setOpen(false);
              setRail(null);
              setQuery('');
            }}
          />
          {why && !searching ? <p className="ag-picker-why">{why}</p> : null}
          {provider && !provider.enabled && onTurnOn && !searching ? (
            <Button size="s" className="ag-picker-on" onClick={() => onTurnOn(provider.id)}>
              {`Turn on ${provider.name}`}
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function EffortMenu({
  providers,
  pick,
  onPick,
  disabled = false,
}: {
  providers: readonly ProviderView[];
  pick: ModelPick | null;
  onPick: (pick: ModelPick) => void;
  disabled?: boolean;
}) {
  const model = findModel(providers, pick);
  const effort = effortOf(model, pick?.effort ?? null);
  if (!pick || !model || model.efforts.length === 0 || !effort) return null;
  const word = model.efforts.find((e) => e.id === effort)?.label ?? effort;
  const rank = effortRank(model, effort) ?? { rank: -1, of: model.efforts.length };
  return (
    <Menu>
      <Tooltip
        content={
          <>
            Reasoning effort <span className="w">{word}</span>
          </>
        }
        side="top"
      >
        <MenuTrigger asChild disabled={disabled}>
          <button type="button" className="ag-ctl ag-effort" aria-label={`Reasoning effort: ${word}`}>
            <EffortMeter rank={rank.rank} of={rank.of} />
            <span className="tt">{word}</span>
            <Icon name="chevron-down" className="cv" />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent side="top" align="start" sideOffset={8} style={{ minWidth: 200 }}>
        <MenuLabel>Reasoning effort</MenuLabel>
        <MenuRadioGroup
          value={effort}
          onValueChange={(v) =>
            onPick({ ...pick, model: pick.model ?? model.id, effort: v === model.defaultEffort ? null : v })
          }
        >
          {model.efforts.map((e) => (
            <MenuRadioItem key={e.id} value={e.id} hint={e.id === model.defaultEffort ? 'default' : undefined}>
              {e.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

function EffortMeter({ rank, of }: { rank: number; of: number }) {
  return (
    <svg
      className={cx(ICON, 'alt')}
      viewBox="0 0 20 20"
      width="20"
      height="20"
      aria-hidden
      focusable="false"
      data-icon="effort"
    >
      <g fill="currentColor" shapeRendering="crispEdges">
        {meterBars(rank, of).map((b) => (
          <rect key={b.x} x={b.x} y={b.y} width={2} height={b.h} fillOpacity={b.lit ? 1 : 0.3} />
        ))}
      </g>
    </svg>
  );
}
