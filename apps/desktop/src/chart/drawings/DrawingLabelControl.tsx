import type { Drawing, DrawingLabel } from '@tessera/protocol';
import {
  ICON_BUTTON,
  FormRow,
  FormSection,
  Icon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Segmented,
  Select,
  TextArea,
  ToggleGroup,
  Tooltip,
  cx,
} from '@tessera/ui';
import { useState } from 'react';
import { Check, ColorControl } from '../settings/controls.tsx';
import type { ChartRef } from '../settings/store.ts';
import { relabelDrawing } from './actions.ts';
import { LABEL_SIZES, inAnalystColour, labelControls, labelOf, placementWords } from './model.ts';

type Face = 'bold' | 'italic';

const FACES = [
  { value: 'bold', label: <b>B</b>, title: 'Bold' },
  { value: 'italic', label: <i>I</i>, title: 'Italic' },
] as const;

export function LabelControl({ chart, drawing: d }: { chart: ChartRef; drawing: Drawing }) {
  const l = labelOf(d);
  const [text, setText] = useState<string | null>(null);
  if (!l) return null;
  const c = labelControls(d.kind);
  const where = placementWords(d.kind);
  const set = (patch: Partial<DrawingLabel>, merge?: string) =>
    relabelDrawing(chart, d.id, patch, merge === undefined ? {} : { merge });
  const sizes = [...new Set([...LABEL_SIZES, l.size])].sort((a, b) => a - b);
  const faces: Face[] = [...(l.bold ? (['bold'] as const) : []), ...(l.italic ? (['italic'] as const) : [])];
  const name = c.words ? 'Text' : 'Labels';
  const shown = c.words ? l.text !== '' || (c.price && l.showPrice) : l.showLevels || (c.price && l.showPrice);
  const analyst = !l.color && inAnalystColour(d);
  return (
    <Popover
      onOpenChange={(open) => {
        if (!open && text !== null) set({ text });
        setText(null);
      }}
    >
      <Tooltip content={name}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cx(ICON_BUTTON, 'w-7 h-7', shown && 'text-t1 bg-raise shadow-none')}
            aria-label={c.words && l.text ? `Text: ${l.text}` : name}
          >
            <Icon name="label" className="text-inherit" />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent className="dsb-label" side="bottom" align="center" aria-label={name}>
        {c.words ? (
          <TextArea
            className="dsb-label-text"
            aria-label="Text"
            placeholder="Text"
            rows={2}
            spellCheck={false}
            value={text ?? l.text}
            onChange={(e) => {
              setText(e.target.value);
              relabelDrawing(chart, d.id, { text: e.target.value }, { typing: true });
            }}
            onBlur={() => {
              if (text === null) return;
              set({ text });
              setText(null);
            }}
          />
        ) : null}
        <div className="dsb-label-row">
          <ColorControl
            color={l.color ?? d.style.color}
            analyst={analyst}
            label="Text colour"
            onChange={(n, gesture) => set({ color: n.color }, gesture)}
          />
          {l.color ? (
            <Tooltip content="The line’s colour">
              <button
                type="button"
                className={cx(ICON_BUTTON, 'w-6 h-6 -ml-1')}
                aria-label="Text in the line’s colour"
                onClick={() => set({ color: undefined })}
              >
                <Icon name="reset" className="text-inherit" />
              </button>
            </Tooltip>
          ) : null}
          <Select
            size="s"
            className="dsb-label-size"
            label="Text size"
            value={String(l.size)}
            options={sizes.map((s) => ({ value: String(s), label: `${String(s)} px` }))}
            onValueChange={(v) => set({ size: Number(v) })}
          />
          <ToggleGroup<Face>
            label="Text style"
            className="dsb-label-face"
            options={FACES}
            value={faces}
            onToggle={(face, on) => set(face === 'bold' ? { bold: on } : { italic: on })}
          />
        </div>
        <FormSection className="dsb-label-place">
          {c.placement ? (
            <>
              <FormRow label={d.kind === 'vertical_line' ? 'Along' : 'Horizontal'}>
                <Segmented
                  label={d.kind === 'vertical_line' ? 'Along the line' : 'Horizontal'}
                  options={where.align}
                  value={l.align}
                  onChange={(align) => set({ align })}
                />
              </FormRow>
              <FormRow label={d.kind === 'vertical_line' ? 'Side' : 'Vertical'}>
                <Segmented
                  label={d.kind === 'vertical_line' ? 'Side of the line' : 'Vertical'}
                  options={where.position}
                  value={l.position}
                  onChange={(position) => set({ position })}
                />
              </FormRow>
            </>
          ) : null}
          {c.price || c.levels ? (
            <FormRow label="Show">
              <span className="dsb-label-checks">
                {c.levels ? (
                  <Check checked={l.showLevels} label="Levels" onChange={(showLevels) => set({ showLevels })} />
                ) : null}
                {c.price ? (
                  <Check
                    checked={l.showPrice}
                    label={c.levels ? 'Prices' : 'Price'}
                    onChange={(showPrice) => set({ showPrice })}
                  />
                ) : null}
              </span>
            </FormRow>
          ) : null}
        </FormSection>
      </PopoverContent>
    </Popover>
  );
}
