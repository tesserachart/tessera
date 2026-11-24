import type { Drawing, DrawingExtend } from '@tessera/protocol';
import {
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
  ICON_BUTTON,
  Tooltip,
  cx,
} from '@tessera/ui';
import { forwardRef, useState } from 'react';
import { openAlertForm } from '../../alerts/formStore.ts';
import { drawingChoice } from '../../alerts/seed.ts';
import { displaySymbol, useInstrumentSpec } from '../../market/instruments.ts';
import { layoutsStore } from '../../state/layouts.ts';
import { Check, ColorControl, LineControl } from '../settings/controls.tsx';
import type { ChartRef } from '../settings/store.ts';
import { removeDrawing, restyleDrawing, updateDrawing } from './actions.ts';
import { LabelControl } from './DrawingLabelControl.tsx';
import { DrawingTemplateMenu } from './DrawingTemplateMenu.tsx';
import {
  levelChoices,
  extendChoices,
  inAnalystColour,
  parseLevel,
  styleControls,
  toggleLevel,
  toolOf,
} from './model.ts';
import { selectDrawing, editNote } from './store.ts';
import { read } from '../../app/store.ts';

const EXTENDS: readonly { value: DrawingExtend; label: string }[] = [
  { value: 'none', label: 'Stops at its anchors' },
  { value: 'left', label: 'Extends left' },
  { value: 'right', label: 'Extends right' },
  { value: 'both', label: 'Extends both ways' },
];

function levelWord(l: number): string {
  return String(Number(l.toFixed(4)));
}

function LevelsControl({
  name,
  choices,
  levels,
  onChange,
}: {
  name: string;
  choices: readonly number[];
  levels: readonly number[];
  onChange: (next: number[]) => void;
}) {
  const [text, setText] = useState('');
  const all = [...new Set([...choices, ...levels])].sort((a, b) => a - b);
  const typed = parseLevel(text);
  const add = () => {
    if (typed === null) return;
    if (!levels.some((l) => Math.abs(l - typed) < 1e-9)) onChange([...levels, typed].sort((a, b) => a - b));
    setText('');
  };
  return (
    <Popover>
      <Tooltip content="Levels">
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cx(ICON_BUTTON, 'w-7 h-7')}
            aria-label={`Levels: ${levels.map(levelWord).join(', ')}`}
          >
            <Icon name="fib" className="text-inherit" />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent className="dsb-levels" side="bottom" align="center" aria-label={`${name} levels`}>
        <div className="dsb-level-grid" role="group" aria-label="Levels">
          {all.map((l) => {
            const on = levels.some((x) => Math.abs(x - l) < 1e-9);
            return (
              <Check key={l} checked={on} label={levelWord(l)} onChange={() => onChange(toggleLevel(levels, l))} />
            );
          })}
        </div>
        <div className={cx('t-input', 'is-num', 'dsb-level-add', text !== '' && typed === null && 'is-invalid')}>
          <input
            aria-label="Add a level"
            placeholder="Add a level"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

export const DrawingStyleBar = forwardRef<HTMLDivElement, { chart: ChartRef; drawing: Drawing }>(
  function DrawingStyleBar({ chart, drawing: d }, ref) {
    const c = styleControls(d);
    const name = toolOf(d.kind).label;
    const words = (v: DrawingExtend) => EXTENDS.find((e) => e.value === v)?.label ?? v;
    const extendWord = words(d.style.extend);
    const spec = useInstrumentSpec(d.instrument);
    const alertOn = drawingChoice(d);
    const alertAt = (e: { clientX: number; clientY: number }) => {
      if (!alertOn) return;
      const model = read(layoutsStore).layouts[chart.layoutId]?.charts[chart.tileId];
      const decimals = spec?.priceDecimals ?? 2;
      openAlertForm(
        {
          instrument: d.instrument,
          symbol: displaySymbol(d.instrument),
          interval: model?.timeframe ?? '1m',
          decimals,
          tick: spec?.tickSize ?? 10 ** -decimals,
          price: d.points[0]?.price ?? null,
          target: alertOn,
        },
        { x: e.clientX, y: e.clientY },
      );
    };
    return (
      <div
        ref={ref}
        className="dsb"
        role="toolbar"
        aria-label={`${name} style`}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget && (e.target as HTMLElement).closest('input, textarea')) return;
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            removeDrawing(chart, d.id);
          } else if (e.key === 'Escape') {
            selectDrawing(null);
          }
          e.stopPropagation();
        }}
      >
        <DrawingTemplateMenu chart={chart} drawing={d} />
        <span className="dsb-sep" />
        {c.color ? (
          <ColorControl
            color={d.style.color}
            analyst={inAnalystColour(d)}
            label="Colour"
            onChange={(n, gesture) => restyleDrawing(chart, d.id, { color: n.color }, gesture)}
          />
        ) : null}
        {c.line ? (
          <LineControl
            width={d.style.width}
            line={d.style.line}
            label="Line"
            onChange={(n) =>
              restyleDrawing(chart, d.id, {
                ...(n.width !== undefined ? { width: n.width } : {}),
                ...(n.line !== undefined ? { line: n.line } : {}),
              })
            }
          />
        ) : null}
        {c.label ? <LabelControl chart={chart} drawing={d} /> : null}
        {c.extend ? (
          <Menu modal={false}>
            <Tooltip content={extendWord}>
              <MenuTrigger asChild>
                <button
                  type="button"
                  className={cx(ICON_BUTTON, 'w-7 h-7', d.style.extend !== 'none' && 'text-t1 bg-raise shadow-none')}
                  aria-label={`Extension: ${extendWord.toLowerCase()}`}
                >
                  <Icon name="extend" className="text-inherit" />
                </button>
              </MenuTrigger>
            </Tooltip>
            <MenuContent align="center" className="ind-menu" style={{ minWidth: 176 }}>
              <MenuLabel>Extension</MenuLabel>
              <MenuRadioGroup
                value={d.style.extend}
                onValueChange={(v) => restyleDrawing(chart, d.id, { extend: v as DrawingExtend })}
              >
                {extendChoices(d.kind).map((v) => (
                  <MenuRadioItem key={v} value={v}>
                    {words(v)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
        ) : null}
        {c.levels ? (
          <LevelsControl
            name={name}
            choices={levelChoices(d.kind)}
            levels={d.levels ?? []}
            onChange={(levels) => updateDrawing(chart, d.id, { levels })}
          />
        ) : null}
        {c.text ? (
          <Tooltip content="Edit text">
            <button
              type="button"
              className={cx(ICON_BUTTON, 'w-7 h-7')}
              aria-label="Edit text"
              onClick={() => editNote({ ...chart, id: d.id })}
            >
              <Icon name="edit" className="text-inherit" />
            </button>
          </Tooltip>
        ) : null}
        <span className="dsb-sep" />
        {alertOn ? (
          <Tooltip content="Alert when price crosses it">
            <button
              type="button"
              className={cx(ICON_BUTTON, 'w-7 h-7')}
              aria-label="Alert on this line"
              onClick={alertAt}
            >
              <Icon name="alert" className="text-inherit" />
            </button>
          </Tooltip>
        ) : null}
        <Tooltip content={d.locked ? 'Locked: unlock to move' : 'Lock'}>
          <button
            type="button"
            className={cx(ICON_BUTTON, 'w-7 h-7', d.locked && 'text-t1 bg-raise shadow-none')}
            aria-label={d.locked ? 'Unlock' : 'Lock'}
            aria-pressed={d.locked}
            onClick={() => updateDrawing(chart, d.id, { locked: !d.locked })}
          >
            <Icon name={d.locked ? 'lock' : 'unlock'} className="text-inherit" />
          </button>
        </Tooltip>
        <Tooltip content="Remove" shortcut="backspace">
          <button
            type="button"
            className={cx(ICON_BUTTON, 'w-7 h-7')}
            aria-label={`Remove ${name.toLowerCase()}`}
            onClick={() => removeDrawing(chart, d.id)}
          >
            <Icon name="trash" className="text-inherit" />
          </button>
        </Tooltip>
      </div>
    );
  },
);
