import type { AgentProviderInfo, SessionMode } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentComposer } from '../src/areas/agents/AgentComposer.tsx';
import {
  COMPACT_STEPS,
  compactWords,
  endsWithin,
  fitLevel,
  fitRow,
  meterBars,
} from '../src/areas/agents/composerFoot.ts';
import {
  effortRank,
  findModel,
  pickWords,
  providerViews,
  shortModelLabel,
  type ModelPick,
} from '../src/areas/agents/models.ts';
import { queueView } from './support/queue.ts';

afterEach(cleanup);

const claude: AgentProviderInfo = {
  id: 'claude-code',
  name: 'Claude Code',
  enabled: true,
  status: 'ok',
  message: 'Claude · Max',
  models: [
    {
      id: 'claude-sonnet-5-5',
      label: 'Claude Sonnet 5.5',
      description: null,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id, label: id })),
      defaultEffort: 'high',
    },
  ],
  defaultModel: 'claude-sonnet-5-5',
  readsPdfs: true,
};
const codex: AgentProviderInfo = {
  ...claude,
  id: 'codex',
  name: 'Codex',
  models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', description: null, efforts: [], defaultEffort: null }],
  defaultModel: 'gpt-6-astra',
};
const views = providerViews([claude, codex], []);
const sonnet: ModelPick = { provider: 'claude-code', model: 'claude-sonnet-5-5', effort: null };

describe('the composer’s footer words', () => {
  it('names the model without the provider’s word its glyph already says, and keeps the full name for its tooltip', () => {
    expect(shortModelLabel('Claude Sonnet 5.5', 'Claude Code')).toBe('Sonnet 5.5');
    expect(shortModelLabel('claude opus 5.5', 'Claude Code')).toBe('opus 5.5');
    expect(shortModelLabel('GPT-6 Astra', 'Codex')).toBe('GPT-6 Astra');
    expect(shortModelLabel('Claudette 2', 'Claude Code')).toBe('Claudette 2');
    expect(shortModelLabel('Claude', 'Claude Code')).toBe('Claude');
    expect(shortModelLabel('Claude ', 'Claude Code')).toBe('Claude ');
    expect(shortModelLabel('Sonnet 5.5', '')).toBe('Sonnet 5.5');
    expect(pickWords(views, sonnet)).toEqual({ short: 'Sonnet 5.5', full: 'Claude Sonnet 5.5' });
    expect(pickWords(views, { provider: 'codex', model: null, effort: null })).toEqual({
      short: 'GPT-6 Astra',
      full: 'GPT-6 Astra',
    });
    expect(pickWords(views, { provider: 'claude-code', model: 'claude-gone', effort: null }).short).toBe('claude-gone');
    expect(pickWords(providerViews([{ ...claude, models: [] }], []), { ...sonnet, model: null }).short).toBe(
      'Claude Code',
    );
    expect(pickWords([], null).short).toBe('Turn on a model');
  });

  it('ranks an effort among its model’s levels, for the meter', () => {
    const model = findModel(views, sonnet);
    expect(effortRank(model, 'high')).toEqual({ rank: 2, of: 5 });
    expect(effortRank(model, 'low')).toEqual({ rank: 0, of: 5 });
    expect(effortRank(model, 'ultra')).toBeNull();
    expect(effortRank(model, null)).toBeNull();
    expect(effortRank(null, 'high')).toBeNull();
  });
});

describe('the composer’s footer on one row', () => {
  it('gives way in order: chevrons, the mode’s word, the effort’s word, then the model’s name', () => {
    expect(COMPACT_STEPS).toEqual(['chevrons', 'mode', 'effort', 'model']);
    expect(compactWords(0)).toBe('');
    expect(compactWords(2)).toBe('chevrons mode');
    expect(compactWords(4)).toBe('chevrons mode effort model');
    expect(compactWords(-1)).toBe('');
  });

  it('takes the least level that fits, and the last when none does', () => {
    const tried: number[] = [];
    expect(
      fitLevel((l) => {
        tried.push(l);
        return l >= 2;
      }),
    ).toBe(2);
    expect(tried).toEqual([0, 1, 2]);
    expect(fitLevel(() => true)).toBe(0);
    expect(fitLevel(() => false)).toBe(4);
  });

  it('fits when every control ends within the row, to the fraction of a pixel', () => {
    expect(endsWithin(300, [28, 120, 300])).toBe(true);
    expect(endsWithin(300, [28, 300.4])).toBe(true);
    expect(endsWithin(300, [28, 301])).toBe(false);
    expect(endsWithin(300, [])).toBe(true);
  });

  it('lays a row out at its level as the words of data-compact', () => {
    const row = document.createElement('div');
    fitRow(row);
    expect(row.dataset.compact).toBe('');
  });

  it('draws the effort meter as one rising bar per level, lit to the rank, on the 20 px grid', () => {
    const five = meterBars(2, 5);
    expect(five.map((b) => b.lit)).toEqual([true, true, true, false, false]);
    expect(five.map((b) => b.h)).toEqual([4, 7, 10, 13, 16]);
    expect(five.every((b) => b.y + b.h === 17)).toBe(true);
    expect(five.map((b) => b.x)).toEqual([3, 6, 9, 12, 15]);
    const four = meterBars(0, 4);
    expect(four.map((b) => b.x)).toEqual([3, 7, 11, 15]);
    expect(four.filter((b) => b.lit)).toHaveLength(1);
    const eight = meterBars(7, 8);
    expect(eight).toHaveLength(6);
    expect(eight.every((b) => b.lit)).toBe(true);
    expect(meterBars(0, 8).filter((b) => b.lit)).toHaveLength(1);
    expect(eight.every((b) => b.x >= 0 && b.x + 2 <= 20)).toBe(true);
  });
});

describe('the composer’s footer', () => {
  const noop = () => undefined;
  function composer(pick: ModelPick | null, mode: SessionMode | null = 'auto_modify') {
    return render(
      <TooltipProvider>
        <AgentComposer
          narrow
          providers={views}
          pick={pick}
          sessionProvider={null}
          reader={{ name: 'Claude Code', readsPdfs: true }}
          working={false}
          sending={false}
          followUp="steer"
          queue={queueView()}
          onPick={noop}
          mode={mode}
          onMode={noop}
          onSend={noop}
          onStop={noop}
        />
      </TooltipProvider>,
    );
  }

  it('holds Attach, the mode, the model, its effort and Send on one row, in that order', () => {
    const { container } = composer(sonnet);
    const row = container.querySelector<HTMLElement>('.ag-compose-foot')!;
    const names = Array.from(row.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual([
      'Attach files',
      'Mode: Auto-modify',
      'Model: Claude Sonnet 5.5',
      'Reasoning effort: high',
      'Send',
    ]);
    const model = screen.getByRole('button', { name: 'Model: Claude Sonnet 5.5' });
    expect(model.textContent).toBe('Sonnet 5.5');
    expect(row.dataset.compact).toBe('');
  });
});
