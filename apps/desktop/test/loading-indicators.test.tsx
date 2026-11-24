import type { CustomIndicator } from '@tessera/protocol';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patch } from '../src/app/store.ts';
import type { ToolOutput } from '../src/app/tools.ts';
import { IndicatorsPanel } from '../src/areas/indicators/IndicatorsPanel.tsx';
import { pageStore } from '../src/areas/indicators/model.ts';
import { studySummary } from '../src/areas/indicators/summaries.ts';
import { customStore } from '../src/indicators/custom.ts';
import {
  expectLoadsInOneGo,
  heldReads,
  mountSurface,
  settle,
  SIM,
  unmountSurface,
  type HeldReads,
  type SimReads,
} from './support/loading.tsx';

vi.mock('../src/areas/indicators/PreviewChart.tsx', () => ({ PreviewChart: () => null }));

const listed = (SIM.tools['indicators.list']![0]!.output as ToolOutput<'indicators.list'>).builtins.find(
  (b) => b.kind === 'sma',
)!;
const sample = (SIM.tools['indicators.list']![0]!.output as ToolOutput<'indicators.list'>).builtins[0]!;

const mine: CustomIndicator = {
  id: 'ci-1',
  version: 2,
  latest: 2,
  spec: { ...sample.spec, kind: 'custom', title: 'Range pressure', inputs: [] },
  description: null,
  createdAt: 1_790_000_000_000_000_000,
  updatedAt: 1_790_000_000_000_000_000,
  createdBy: 'user',
};

const WITH_MINE: SimReads = { ...SIM, topics: { ...SIM.topics, 'indicators.catalog': [{ custom: [mine] }] } };

const withoutSandbox = (): ToolOutput<'indicators.list'> => ({
  ...(SIM.tools['indicators.list']![0]!.output as ToolOutput<'indicators.list'>),
  sandbox: { available: false, engine: '', reason: 'Custom indicators cannot run here.', walls: [] },
});

const detail = (): ToolOutput<'indicators.get'> => ({
  builtin: null,
  custom: mine,
  code: 'export const indicator = { title: "Range pressure" };',
  versions: [],
});

beforeEach(() => {
  patch(customStore, { byId: {}, list: [], loaded: false, problems: {} });
  patch(pageStore, { selection: null, drafts: {}, runs: {}, inputs: {}, busy: {}, saveProblems: {}, saved: {} });
});

afterEach(unmountSurface);

function mount(held: HeldReads) {
  return mountSurface(held.client, <IndicatorsPanel />, { tools: Object.keys(SIM.tools), shell: null });
}

describe('Indicators load as one unit', () => {
  it('a built-in shows its name, description and inputs together', async () => {
    const held = heldReads(SIM);
    const { container } = mount(held);
    const { loading, loaded } = await expectLoadsInOneGo(held, () => container);
    expect(loading).not.toContain(listed.description.split(' ')[0]);
    expect(loaded).toContain(listed.spec.title);
    expect(loaded).toContain('Add to chart');
    expect(loaded).toContain(studySummary('sma')!);
    expect(loaded).not.toContain(listed.description.slice(0, 40));
    expect(screen.queryByRole('status', { name: 'Loading indicators' })).toBeNull();
  });

  it('draws its skeleton from the panel itself: the catalog beside an indicator and its preview chart', async () => {
    mount(heldReads(SIM));
    await settle();
    const skeleton = screen.getByRole('status', { name: 'Loading indicators' });
    expect(skeleton.querySelectorAll('.ia-cat .ia-cat-row').length).toBeGreaterThan(10);
    expect(skeleton.querySelector('.ia-bi-head h2')?.textContent).toBeTruthy();
    expect(skeleton.querySelector('.ia-preview canvas')).toBeTruthy();
  });

  it('a custom indicator shows the catalog group and its code together, with no reading words, when nothing runs it', async () => {
    const held = heldReads(WITH_MINE, { 'indicators.get': detail, 'indicators.list': withoutSandbox });
    const { container } = mount(held);
    const { loading, loaded } = await expectLoadsInOneGo(held, () => container);
    expect(loading).not.toMatch(/Range pressure|Yours|Reading/);
    expect(loaded).toContain('Yours');
    expect(loaded).toContain('Range pressure');
    expect(loaded).toContain('Add to chart');
    expect(screen.queryByRole('status', { name: 'Loading the indicator' })).toBeNull();
  });
});
