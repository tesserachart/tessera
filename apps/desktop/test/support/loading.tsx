import type { ToolName } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { RuntimeClock } from '../../src/app/clock.ts';
import { queryClient } from '../../src/app/queries.ts';
import type { ToolInput, ToolOutput } from '../../src/app/tools.ts';
import { useTopicEffect } from '../../src/app/useTopic.ts';
import { EMPTY_SHELL_DATA, ShellDataContext, type ShellData } from '../../src/shell/shellData.ts';
import { putRuntimeSettings } from '../../src/state/runtimeSettings.ts';
import simReads from '../fixtures/sim-reads.json';
import { seedTools, setTestServices, TestRuntime, type FakeClient } from './runtime.tsx';

type Answers = { readonly [N in ToolName]?: (input: ToolInput<N>) => ToolOutput<N> };

export interface SimReads {
  readonly tools: { readonly [tool: string]: readonly { readonly input: unknown; readonly output: unknown }[] };
  readonly topics: { readonly [topic: string]: readonly unknown[] };
}

export const SIM = simReads as SimReads;

const BRIDGE = { kind: 'browser' } as const;

const sameInput = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function simAnswer(reads: SimReads, tool: string, input: unknown): unknown {
  const seen = reads.tools[tool];
  if (!seen?.length) throw new Error(`the surface read ${tool}, which the sim recording has no answer for`);
  return (seen.find((s) => sameInput(s.input, input)) ?? seen[0]!).output;
}

interface Held {
  readonly what: string;
  answer(): void;
}

export interface HeldReads {
  readonly client: FakeClient;
  readonly waiting: number;
  readonly answered: readonly string[];
  answerNext(): string;
}

export function heldReads(reads: SimReads, answers: Answers = {}): HeldReads {
  const queue: Held[] = [];
  const answered: string[] = [];
  let seq = 0;
  const client: FakeClient = {
    request: (method: string, params?: { name?: string; input?: unknown }) => {
      if (method !== 'tools.invoke' || !params?.name) return new Promise(() => undefined);
      const name = params.name;
      return new Promise((resolve) => {
        queue.push({
          what: name,
          answer: () => {
            const answer = (answers as Record<string, ((input: unknown) => unknown) | undefined>)[name];
            const output = answer ? answer(params.input) : simAnswer(reads, name, params.input);
            resolve({ ok: true, status: 'ok', output });
          },
        });
      });
    },
    subscribe: (topic, _params, handler) => {
      let open = true;
      queue.push({
        what: `topic ${topic}`,
        answer: () => {
          for (const data of reads.topics[topic] ?? [])
            if (open) handler(data, { topic, seq: ++seq, subscriptionId: null });
        },
      });
      return () => {
        open = false;
      };
    },
  };
  return {
    client,
    get waiting() {
      return queue.length;
    },
    answered,
    answerNext: () => {
      const next = queue.shift();
      if (!next) throw new Error('no read is waiting');
      next.answer();
      answered.push(next.what);
      return next.what;
    },
  };
}

export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

export function visibleText(root: Element): string {
  const words: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent?.trim();
      if (t) words.push(t);
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.hasAttribute('hidden') || node.classList.contains('hidden') || node.getAttribute('aria-hidden') === 'true')
      return;
    if (node.tagName === 'STYLE' || node.tagName === 'SCRIPT') return;
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return words.join(' ').replace(/\s+/g, ' ');
}

export async function expectLoadsInOneGo(
  held: HeldReads,
  surface: () => Element,
): Promise<{ loading: string; loaded: string }> {
  await settle();
  const loading = visibleText(surface());
  if (held.waiting > 0 && !surface().querySelector('[aria-busy="true"]'))
    throw new Error(
      `the surface shows no loading state while ${String(held.waiting)} reads are out\n  shown: ${loading}`,
    );
  for (let i = 0; held.waiting > 0; i++) {
    if (i > 200) throw new Error(`the surface keeps reading: ${held.answered.slice(-5).join(', ')}`);
    let last = '';
    await act(async () => {
      last = held.answerNext();
      await Promise.resolve();
    });
    await settle();
    const now = visibleText(surface());
    if (held.waiting > 0 && now !== loading)
      throw new Error(
        `the surface showed part of its content once ${last} answered, with ${String(held.waiting)} more reads out` +
          `\n  loading: ${loading}\n  shown:   ${now}`,
      );
  }
  return { loading, loaded: visibleText(surface()) };
}

export function unmountSurface(): void {
  cleanup();
  queryClient.clear();
}

export function RuntimeSettingsFeed({ children }: { children: ReactNode }) {
  useTopicEffect('settings', {}, (ev) => {
    if (ev.type === 'snapshot') putRuntimeSettings(ev.values, true);
  });
  return children;
}

export interface SurfaceSetup {
  readonly tools: readonly string[] | null;
  readonly shell?: ShellData | null;
  readonly clock?: RuntimeClock;
}

export function mountSurface(
  client: FakeClient,
  surface: ReactNode,
  { tools, shell = EMPTY_SHELL_DATA, clock }: SurfaceSetup,
) {
  setTestServices(client, BRIDGE);
  if (tools) seedTools(tools);
  return render(
    <TestRuntime client={client} bridge={BRIDGE} clock={clock}>
      <TooltipProvider>
        {shell ? <ShellDataContext.Provider value={shell}>{surface}</ShellDataContext.Provider> : surface}
      </TooltipProvider>
    </TestRuntime>,
  );
}
