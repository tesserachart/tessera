import type {
  Drawing,
  DrawingKind,
  DrawingLabel,
  DrawingLabelInput,
  DrawingStyle,
  DrawingTemplate,
  LabelAlign,
  LabelPosition,
  LineDash,
} from '@tessera/protocol';
import { isFibKind } from '@tessera/chart';
import { stableStringify } from '../../workspace/layouts.ts';
import {
  defaultLabel,
  defaultLevels,
  defaultStyle,
  LABEL_KINDS,
  LABEL_SIZE,
  labelControls,
  labelLook,
  labelOf,
  LEVEL_MAX,
  LEVEL_MIN,
  DRAWING_TOOLS,
  type NewDrawingLook,
} from './model.ts';

export const DRAWING_TEMPLATE_NAME_MAX = 48;

export interface DrawingLook {
  style: DrawingStyle;
  label: DrawingLabel | null;
  levels: number[] | null;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

const KINDS: readonly DrawingKind[] = DRAWING_TOOLS.map((t) => t.kind);
const LINES: readonly LineDash[] = ['solid', 'dash', 'dot'];
const EXTENDS: readonly DrawingStyle['extend'][] = ['none', 'left', 'right', 'both'];
const ALIGNS: readonly LabelAlign[] = ['left', 'center', 'right'];
const POSITIONS: readonly LabelPosition[] = ['above', 'on', 'below'];

export function isDrawingKind(v: unknown): v is DrawingKind {
  return KINDS.includes(v as DrawingKind);
}

export function readLabel(kind: DrawingKind, v: unknown): DrawingLabel | null {
  const o = obj(v);
  if (!o || !LABEL_KINDS.has(kind)) return null;
  const l = defaultLabel(kind);
  if (typeof o.color === 'string' && o.color) l.color = o.color;
  if (typeof o.size === 'number' && o.size >= 8 && o.size <= 40) l.size = Math.round(o.size);
  if (typeof o.bold === 'boolean') l.bold = o.bold;
  if (typeof o.italic === 'boolean') l.italic = o.italic;
  if (ALIGNS.includes(o.align as LabelAlign)) l.align = o.align as LabelAlign;
  if (POSITIONS.includes(o.position as LabelPosition)) l.position = o.position as LabelPosition;
  if (typeof o.showPrice === 'boolean') l.showPrice = o.showPrice && labelControls(kind).price;
  if (typeof o.showLevels === 'boolean') l.showLevels = o.showLevels;
  return l;
}

export function readLevels(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out = [
    ...new Set(
      v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x >= LEVEL_MIN && x <= LEVEL_MAX),
    ),
  ].sort((a, b) => a - b);
  return out.length ? out.slice(0, 24) : null;
}

function readStyle(kind: DrawingKind, v: unknown): DrawingStyle {
  const o = obj(v) ?? {};
  const s = defaultStyle(kind);
  if (typeof o.color === 'string' && o.color) s.color = o.color;
  if (typeof o.width === 'number' && o.width >= 0.5 && o.width <= 4) s.width = o.width;
  if (LINES.includes(o.line as LineDash)) s.line = o.line as LineDash;
  if (EXTENDS.includes(o.extend as DrawingStyle['extend'])) s.extend = o.extend as DrawingStyle['extend'];
  return s;
}

export function readDrawingTemplates(value: unknown): DrawingTemplate[] {
  const out: DrawingTemplate[] = [];
  const list = obj(value)?.templates;
  for (const raw of Array.isArray(list) ? list : []) {
    const t = obj(raw);
    const name = typeof t?.name === 'string' ? t.name.trim() : '';
    if (!t || typeof t.id !== 'string' || t.id === '' || name === '' || !isDrawingKind(t.kind)) continue;
    const kind = t.kind;
    if (out.some((x) => x.id === t.id || (x.kind === kind && sameName(x.name, name)))) continue;
    const label = readLabel(kind, t.label);
    const levels = isFibKind(kind) ? readLevels(t.levels) : null;
    out.push({
      id: t.id,
      name,
      kind,
      style: readStyle(kind, t.style),
      ...(label ? { label } : {}),
      ...(levels ? { levels } : {}),
    });
  }
  return out;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function templatesOf(all: readonly DrawingTemplate[], kind: DrawingKind): DrawingTemplate[] {
  return all.filter((t) => t.kind === kind);
}

export function templateNamed(
  all: readonly DrawingTemplate[],
  kind: DrawingKind,
  name: string,
): DrawingTemplate | null {
  return all.find((t) => t.kind === kind && sameName(t.name, name)) ?? null;
}

export function renameProblem(all: readonly DrawingTemplate[], t: DrawingTemplate, name: string): string | null {
  const n = name.trim();
  if (n === '') return 'A template needs a name';
  if (n.length > DRAWING_TEMPLATE_NAME_MAX) return `At most ${String(DRAWING_TEMPLATE_NAME_MAX)} characters`;
  if (all.some((x) => x.id !== t.id && x.kind === t.kind && sameName(x.name, n))) return `${n} is taken`;
  return null;
}

export function builtInLook(kind: DrawingKind): DrawingLook {
  return {
    style: defaultStyle(kind),
    label: LABEL_KINDS.has(kind) ? defaultLabel(kind) : null,
    levels: isFibKind(kind) ? [...(defaultLevels(kind) ?? [])] : null,
  };
}

export function lookOfDrawing(d: Drawing): DrawingLook {
  const label = labelOf(d);
  return {
    style: { ...d.style },
    label: label ? labelLook(label) : null,
    levels: isFibKind(d.kind) ? [...(d.levels ?? defaultLevels(d.kind) ?? [])] : null,
  };
}

export function lookOfTemplate(t: DrawingTemplate): DrawingLook {
  const base = builtInLook(t.kind);
  return {
    style: { ...t.style },
    label: base.label ? labelLook(t.label ?? base.label) : null,
    levels: base.levels ? [...(t.levels ?? base.levels)] : null,
  };
}

export function lookOfNew(kind: DrawingKind, entry: NewDrawingLook | undefined): DrawingLook {
  const base = builtInLook(kind);
  return {
    style: defaultStyle(kind, entry),
    label: base.label ? labelLook(entry?.label ? (readLabel(kind, entry.label) ?? base.label) : base.label) : null,
    levels: base.levels ? [...(entry?.levels ?? base.levels)] : null,
  };
}

export function sameLook(a: DrawingLook, b: DrawingLook): boolean {
  const norm = (l: DrawingLook) => ({
    style: l.style,
    label: l.label ? { ...l.label, text: '', color: l.label.color ?? null } : null,
    levels: l.levels,
  });
  return stableStringify(norm(a)) === stableStringify(norm(b));
}

export function withLook(d: Drawing, look: DrawingLook): Drawing {
  const words = d.label?.text ?? '';
  const next: Drawing = { ...d, style: { ...look.style } };
  if (look.label && LABEL_KINDS.has(d.kind)) next.label = { ...labelLook(look.label), text: words };
  if (look.levels && isFibKind(d.kind)) next.levels = [...look.levels];
  return next;
}

export function newDrawingEntry(look: DrawingLook): NewDrawingLook {
  return {
    ...look.style,
    ...(look.label ? { label: labelLook(look.label) } : {}),
    ...(look.levels ? { levels: [...look.levels] } : {}),
  };
}

export function labelInput(kind: DrawingKind, l: DrawingLabel): DrawingLabelInput {
  return {
    color: l.color ?? '',
    size: l.size || LABEL_SIZE,
    bold: l.bold,
    italic: l.italic,
    align: l.align,
    position: l.position,
    showPrice: l.showPrice,
    ...(isFibKind(kind) ? { showLevels: l.showLevels } : {}),
  };
}

const DASH_WORD: Record<LineDash, string> = { solid: '', dash: ' dashed', dot: ' dotted' };
const EXTEND_WORD: Record<DrawingStyle['extend'], string> = {
  none: '',
  left: 'extends left',
  right: 'extends right',
  both: 'extends both ways',
};

export function lookWords(kind: DrawingKind, look: DrawingLook, colorName: (c: string) => string): string {
  const base = builtInLook(kind);
  const s = look.style;
  const name = colorName(s.color);
  const parts = [`${name.charAt(0).toUpperCase()}${name.slice(1)}, ${String(s.width)} px${DASH_WORD[s.line]}`];
  if (s.extend !== base.style.extend && EXTEND_WORD[s.extend]) parts.push(EXTEND_WORD[s.extend]);
  const l = look.label;
  if (l && base.label) {
    const face = [`${String(l.size)} px`, ...(l.bold ? ['bold'] : []), ...(l.italic ? ['italic'] : [])].join(' ');
    const fib = isFibKind(kind);
    const priced = labelControls(kind).price;
    const words = [
      `${fib ? 'labels' : 'text'} ${face}`,
      ...(labelControls(kind).placement ? [l.align === 'center' ? 'centre' : l.align, l.position] : []),
      ...(fib
        ? [l.showLevels ? 'levels' : 'no levels', ...(priced ? [l.showPrice ? 'prices' : 'no prices'] : [])]
        : l.showPrice
          ? ['price']
          : []),
    ];
    if (!sameLook({ ...look, label: l }, { ...look, label: base.label })) parts.push(words.join(', '));
  }
  if (look.levels && base.levels && stableStringify(look.levels) !== stableStringify(base.levels)) {
    parts.push(`levels ${look.levels.map((v) => String(Number(v.toFixed(4)))).join(', ')}`);
  }
  return parts.join(' · ');
}
