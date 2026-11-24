import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react';
import { useTheme } from '../../theme/store.ts';
import type { ThemeMode } from '../../theme/resolve.ts';
import type { CodeProblem } from './model.ts';

export function CodeEditor({
  value,
  onChange,
  onRun,
  onSave,
  problem,
  label,
}: {
  value: string;
  onChange: (code: string) => void;
  onRun: () => void;
  onSave: () => void;
  problem: CodeProblem | null;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onRun, onSave });
  const look = useRef(new Compartment());
  const mode = useTheme((s) => s.resolved.mode);
  useLayoutEffect(() => {
    handlers.current = { onChange, onRun, onSave };
  });

  const createView = useEffectEvent((parent: HTMLElement) => {
    return new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          indentOnInput(),
          indentUnit.of('  '),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          javascript(),
          javascriptLanguage.data.of({ autocomplete: completeTessera }),
          autocompletion({ icons: false }),
          syntaxHighlighting(HIGHLIGHT),
          lintGutter(),
          look.current.of(themeFor(mode)),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                handlers.current.onRun();
                return true;
              },
            },
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                handlers.current.onSave();
                return true;
              },
            },
            indentWithTab,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
  });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const v = createView(el);
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: look.current.reconfigure(themeFor(mode)) });
  }, [mode]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const diagnostics: Diagnostic[] = [];
    if (problem?.line && problem.line >= 1 && problem.line <= v.state.doc.lines) {
      const line = v.state.doc.line(problem.line);
      const col = problem.column && problem.column > 0 ? Math.min(line.length, problem.column - 1) : 0;
      diagnostics.push({
        from: line.from + col,
        to: Math.max(line.from + col, line.to),
        severity: 'error',
        message: problem.message,
      });
    }
    v.dispatch(setDiagnostics(v.state, diagnostics));
  }, [problem, value]);

  return <div ref={host} className="ia-code" />;
}

const fn = (pairs: readonly (readonly [string, string])[]): readonly Completion[] =>
  pairs.map(([label, detail]) => ({ label, detail, type: 'function' }));

const TA = fn([
  ['sma', '(x, n) simple moving average'],
  ['ema', '(x, n) exponential moving average'],
  ['rma', "(x, n) Wilder's moving average"],
  ['wma', '(x, n) weighted moving average'],
  ['stdev', '(x, n) rolling standard deviation'],
  ['zscore', '(x, n) distance from the rolling mean, in deviations'],
  ['sum', '(x, n) rolling sum'],
  ['cum', '(x) running sum'],
  ['highest', '(x, n) rolling maximum'],
  ['lowest', '(x, n) rolling minimum'],
  ['shift', '(x, k) x, k bars later'],
  ['change', '(x, k) x minus its value k bars earlier'],
  ['crossover', '(a, b) where a crosses above b'],
  ['crossunder', '(a, b) where a crosses below b'],
  ['rsi', '(x, n) relative strength index'],
  ['tr', '(bars) true range'],
  ['atr', '(bars, n) average true range'],
  ['vwap', "(bars, { reset: 'day' }) session VWAP"],
  ['vwapStdev', '(bars) deviation around the VWAP'],
  ['firstAbove', '(x, level, from) first bar above, or -1'],
  ['firstBelow', '(x, level, from) first bar below, or -1'],
]);

const SESSION = fn([
  ['list', "(bars, '07:00-10:00', 'Europe/London') each occurrence, UTC without a zone"],
  ['days', '(bars) trading days'],
  ['weeks', '(bars) trading weeks'],
  ['ids', '(bars, hours, zone) occurrence per bar'],
  ['high', '(bars, period, zone) high so far'],
  ['low', '(bars, period, zone) low so far'],
  ['prior', "(bars, 'day') previous high and low"],
  ['clock', "(t, zone = 'UTC') calendar and clock in a zone"],
]);

const DRAW = fn([
  ['line', '(time1, price1, [time2, price2,] options)'],
  ['label', '(time, price, text, options)'],
  ['box', '(time1, price1, time2, price2, options)'],
]);

const BARS: readonly Completion[] = [
  ['time', 'bar open time, UTC seconds'],
  ['open', ''],
  ['high', ''],
  ['low', ''],
  ['close', ''],
  ['volume', ''],
  ['hl2', '(high + low) / 2'],
  ['hlc3', '(high + low + close) / 3'],
  ['ohlc4', '(open + high + low + close) / 4'],
  ['day', 'trading day, yyyymmdd'],
  ['length', 'number of bars'],
  ['buyVolume', 'when the market reports sides'],
  ['sellVolume', 'when the market reports sides'],
  ['delta', 'buy − sell volume'],
].map(([label, detail]) => ({ label: label!, detail: detail!, type: 'property' }));

const MEMBERS: Readonly<Record<string, readonly Completion[]>> = { ta: TA, session: SESSION, draw: DRAW, bars: BARS };

function completeTessera(ctx: CompletionContext) {
  const member = ctx.matchBefore(/\b(ta|session|draw|bars)\.\w*/);
  if (!member) return null;
  const dot = member.text.indexOf('.');
  return { from: member.from + dot + 1, options: MEMBERS[member.text.slice(0, dot)] ?? [], validFor: /^\w*$/ };
}

const HIGHLIGHT = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--mist)' },
  { tag: [t.string, t.docString], color: 'var(--up)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--t1)' },
  { tag: [t.comment, t.lineComment], color: 'var(--t3)', fontStyle: 'italic' },
  { tag: [t.function(t.definition(t.variableName)), t.definition(t.className)], color: 'var(--t1)', fontWeight: '600' },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: 'var(--t1)' },
  { tag: [t.variableName, t.propertyName], color: 'var(--t2)' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: 'var(--t3)' },
  { tag: t.invalid, color: 'var(--t1)', textDecoration: 'underline' },
]);

const CODE_SIZE = 'var(--fs-body)';
const CODE_FONT = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace";
const CODE_LINE = '20px';
const CODE_PAD = '10px 0';
const LINE_PAD = '0 14px 0 6px';
const GUTTER_PAD = '0 8px 0 14px';
const GUTTER_MIN = '36px';

export function CodeSample({ code }: { code: string }) {
  const lines = code.split('\n');
  return (
    <div
      className="ia-code flex"
      style={{ fontFamily: CODE_FONT, fontSize: CODE_SIZE, lineHeight: CODE_LINE, padding: CODE_PAD }}
    >
      <div className="flex-none text-right">
        {lines.map((_, i) => (
          <div key={i} style={{ padding: GUTTER_PAD, minWidth: GUTTER_MIN }}>
            {i + 1}
          </div>
        ))}
      </div>
      <div className="min-w-0">
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre" style={{ padding: LINE_PAD }}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

const LOOK = {
  '&': { height: '100%', background: 'var(--ink)', color: 'var(--t2)', fontSize: CODE_SIZE },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: CODE_FONT,
    lineHeight: CODE_LINE,
  },
  '.cm-content': { padding: CODE_PAD, caretColor: 'var(--t1)' },
  '.cm-line': { padding: LINE_PAD },
  '.cm-gutters': { background: 'var(--ink)', color: 'var(--t3)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: GUTTER_PAD, minWidth: GUTTER_MIN },
  '.cm-activeLine': { background: 'color-mix(in srgb, var(--color-t1) 3.5%, transparent)' },
  '.cm-activeLineGutter': { background: 'transparent', color: 'var(--t3)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--t1)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    background: 'var(--mist-12) !important',
  },
  '.cm-selectionMatch': { background: 'color-mix(in srgb, var(--color-t1) 7%, transparent)' },
  '.cm-matchingBracket': { background: 'transparent', color: 'var(--t1)', outline: '1px solid var(--line-3)' },
  '.cm-tooltip': { background: 'var(--panel)', border: '1px solid var(--line-2)', color: 'var(--t2)' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 10px', fontSize: '12px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--raise)', color: 'var(--t1)' },
  '.cm-completionDetail': { color: 'var(--t3)', fontStyle: 'normal', marginLeft: '10px' },
  '.cm-diagnostic-error': { borderLeft: '2px solid var(--t1)', background: 'var(--panel)', color: 'var(--t1)' },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--t2)',
    textUnderlineOffset: '3px',
  },
  '.cm-lint-marker-error': { content: 'none' },
  '.cm-gutter-lint': { width: '6px' },
  '.cm-panels': { background: 'var(--panel)', color: 'var(--t2)' },
  '.cm-searchMatch': { background: 'var(--mist-12)', outline: '1px solid var(--line-3)' },
};

const THEMES: Readonly<Record<ThemeMode, ReturnType<typeof EditorView.theme>>> = {
  dark: EditorView.theme(LOOK, { dark: true }),
  light: EditorView.theme(LOOK, { dark: false }),
};

function themeFor(mode: ThemeMode) {
  return THEMES[mode];
}
