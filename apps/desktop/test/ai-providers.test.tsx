import type { AgentProviderInfo } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalystPanel } from '../src/analyst/AnalystPanel.tsx';
import type { RuntimeClock } from '../src/app/clock.ts';
import { ConnectAi } from '../src/areas/agents/ConnectAi.tsx';
import {
  checkedWords,
  connectState,
  connectWord,
  enabledIds,
  formatArgs,
  parseArgs,
  providerChange,
  providerLine,
  readProviderChoices,
} from '../src/areas/agents/connect.ts';
import { ModelPicker } from '../src/areas/agents/ModelPicker.tsx';
import { OFF_WHY, pickLabel, providerViews, resolvePick, unavailableWhy } from '../src/areas/agents/models.ts';
import { modelEntries, searchSettings } from '../src/areas/settings/model.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';
import { answeringClient, seedTools, setTestServices, TestRuntime } from './support/runtime.tsx';

const NOW_MS = Date.UTC(2026, 9, 11, 15, 0, 0);
const clock = { now: () => NOW_MS } as unknown as RuntimeClock;

const claude = (over: Partial<AgentProviderInfo> = {}): AgentProviderInfo => ({
  id: 'claude-code',
  name: 'Claude Code',
  enabled: true,
  status: 'ok',
  message: 'Claude · Max',
  models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', description: null, efforts: [], defaultEffort: null }],
  defaultModel: 'claude-opus-5-5',
  version: '2.1.3',
  configHome: '/home/me/.claude',
  checkedAt: (NOW_MS - 3 * 60_000) * 1e6,
  readsPdfs: true,
  ...over,
});
const off = (id: string, name: string): AgentProviderInfo => ({
  id,
  name,
  enabled: false,
  status: 'disabled',
  message: null,
  models: [],
  defaultModel: null,
  readsPdfs: false,
});
const codex = (over: Partial<AgentProviderInfo> = {}): AgentProviderInfo => ({
  ...claude(),
  id: 'codex',
  name: 'Codex',
  message: 'ChatGPT · Plus',
  models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', description: null, efforts: [], defaultEffort: null }],
  defaultModel: 'gpt-6-astra',
  readsPdfs: false,
  ...over,
});

afterEach(() => {
  cleanup();
});

describe('a provider that is off', () => {
  it('lists with no models, says it is off, and is never picked; the stored pick comes back once it is on', () => {
    const views = providerViews([off('codex', 'Codex'), claude()], []);
    expect(views[0]).toMatchObject({ enabled: false, status: 'disabled', ready: false, models: [] });
    expect(unavailableWhy(views[0]!)).toBe(OFF_WHY);
    const last = { provider: 'codex', model: 'gpt-6-astra', effort: null };
    expect(resolvePick(views, null, last)).toEqual({ provider: 'claude-code', model: 'claude-opus-5-5', effort: null });
    const none = providerViews([off('codex', 'Codex'), off('claude-code', 'Claude Code')], []);
    expect(resolvePick(none, null, last)).toBeNull();
    expect(pickLabel(none, null)).toBe('Turn on a model');
    expect(resolvePick(providerViews([codex(), claude()], []), null, last)).toBe(last);
  });

  it('takes the user’s switch over a list read before it moved', () => {
    const listed = [off('codex', 'Codex'), claude()];
    const on = providerViews(listed, [], enabledIds({ codex: { enabled: true }, 'claude-code': { enabled: true } }));
    expect(on[0]).toMatchObject({ enabled: true, status: 'unknown', ready: false, models: [] });
    expect(connectWord(connectState(on[0]!))).toBe('Checking…');
    const offNow = providerViews(listed, [], enabledIds({ 'claude-code': { enabled: false } }));
    expect(offNow[1]).toMatchObject({ enabled: false, status: 'disabled', ready: false });
  });

  it('says where each stands once on: ready with its account and version, or what to do', () => {
    const [ready] = providerViews([claude()], []);
    expect(connectState(ready!)).toEqual({ kind: 'ready', account: 'Claude · Max' });
    expect(providerLine(ready!, '2.1.3')).toBe('Claude · Max · v2.1.3');
    const [missing] = providerViews([claude({ status: 'down', message: 'Claude Code is not installed' })], []);
    expect(connectWord(connectState(missing!))).toBe('Not installed');
    expect(connectState(missing!)).toEqual({
      kind: 'missing',
      installs: true,
      page: 'https://docs.anthropic.com/en/docs/claude-code/setup',
    });
    expect(providerLine(missing!, null)).toBe('Not installed.');
    const [codexMissing] = providerViews([codex({ status: 'down', message: 'Codex is not installed' })], []);
    expect(connectState(codexMissing!)).toEqual({
      kind: 'missing',
      installs: false,
      page: 'https://github.com/openai/codex/releases/latest',
    });
    expect(providerLine(codexMissing!, null)).toBe('Not installed. Download it, then Check again.');
    const [signedOut] = providerViews([codex({ status: 'disconnected', message: 'Not signed in' })], []);
    expect(connectWord(connectState(signedOut!))).toBe('Not signed in');
    expect(providerLine(signedOut!, null)).toBe('Not signed in.');
    const [offView] = providerViews([off('codex', 'Codex')], []);
    expect(providerLine(offView!, '0.1.0')).toBe('Off');
  });
});

describe('the choices behind a provider', () => {
  it('reads absent as off, and changes one field at a time (blank goes back to the default)', () => {
    expect(readProviderChoices(undefined, 'codex')).toEqual({
      enabled: false,
      binaryPath: '',
      configDir: '',
      args: [],
    });
    expect(
      readProviderChoices({ codex: { enabled: true, configDir: '~/.codex-work', args: ['-c', 'x=1'] } }, 'codex'),
    ).toEqual({ enabled: true, binaryPath: '', configDir: '~/.codex-work', args: ['-c', 'x=1'] });
    expect(enabledIds({ codex: { enabled: true }, 'claude-code': {} })).toEqual(new Set(['codex']));
    expect(providerChange('codex', { enabled: true })).toEqual({ codex: { enabled: true } });
    expect(providerChange('codex', { binaryPath: '  ', configDir: ' ~/c ', args: [] })).toEqual({
      codex: { binaryPath: null, configDir: '~/c', args: null },
    });
  });

  it('reads launch arguments as a shell would split them, and shows them so they read back', () => {
    expect(parseArgs('  --add-dir "/tmp/my notes"  -c model=x ')).toEqual([
      '--add-dir',
      '/tmp/my notes',
      '-c',
      'model=x',
    ]);
    expect(parseArgs(`--name 'it "works"' ""`)).toEqual(['--name', 'it "works"', '']);
    for (const args of [['--add-dir', '/tmp/my notes'], ['-c', 'say="hi"'], ['plain']])
      expect(parseArgs(formatArgs(args))).toEqual(args);
  });

  it('says when the providers that are on were last checked', () => {
    expect(checkedWords([claude(), off('codex', 'Codex')], NOW_MS)).toBe('Checked 3m ago');
    expect(checkedWords([off('codex', 'Codex')], NOW_MS)).toBeNull();
    expect(checkedWords(undefined, NOW_MS)).toBeNull();
  });

  it('is found by the words a user would search for', () => {
    const entries = modelEntries();
    for (const q of ['binary path', 'launch arguments', 'claude_config_dir', 'codex_home'])
      expect(searchSettings(entries, q)[0]?.id, q).toBe('analyst.providers');
  });
});

describe('Turn on the analyst', () => {
  it('offers each CLI off with Turn on, runs nothing before, and turns one on with the setting alone', async () => {
    putRuntimeSettings({ 'agent.providers': {} }, true);
    const { client, calls } = answeringClient({
      'agent.list_providers': () => ({ providers: [off('codex', 'Codex'), off('claude-code', 'Claude Code')] }),
      'settings.set': ({ key, value }) => ({ key, value, previous: {} }),
    });
    const bridge = {};
    setTestServices(client, bridge);
    seedTools(['agent.list_providers', 'settings.set']);
    render(
      <TestRuntime client={client} bridge={bridge} clock={clock}>
        <ConnectAi onSkip={() => undefined} />
      </TestRuntime>,
    );
    const turnOn = await screen.findByRole('button', { name: 'Turn on Claude Code' });
    expect(screen.getByRole('button', { name: 'Turn on Codex' })).toBeTruthy();
    expect(screen.getAllByText('Off')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy();
    expect(calls.every((c) => c.name !== 'agent.list_providers' || !(c.input as { recheck?: boolean }).recheck)).toBe(
      true,
    );
    fireEvent.click(turnOn);
    await vi.waitFor(() =>
      expect(calls).toContainEqual({
        name: 'settings.set',
        input: { key: 'agent.providers', value: { 'claude-code': { enabled: true } } },
      }),
    );
    act(() => putRuntimeSettings({ 'agent.providers': { 'claude-code': { enabled: true } } }, false));
    await vi.waitFor(() => expect(screen.getByText('Checking…')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Turn on Claude Code' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Turn on Codex' })).toBeTruthy();
  });
});

describe('a model that is on but not installed', () => {
  it('installs Claude Code from its row, offers Codex’s download page, and never shows an npm command', async () => {
    putRuntimeSettings({ 'agent.providers': { codex: { enabled: true }, 'claude-code': { enabled: true } } }, true);
    let installed = false;
    const { client, calls } = answeringClient({
      'agent.list_providers': () => ({
        providers: [
          codex({ status: 'down', message: 'Codex is not installed' }),
          installed ? claude() : claude({ status: 'down', message: 'Claude Code is not installed' }),
        ],
      }),
      'agent.install': ({ provider }) => {
        installed = true;
        return { provider };
      },
    });
    const opened: string[] = [];
    const bridge = {
      openExternal: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    };
    setTestServices(client, bridge);
    seedTools(['agent.list_providers', 'agent.install', 'settings.set']);
    render(
      <TestRuntime client={client} bridge={bridge} clock={clock}>
        <ConnectAi />
      </TestRuntime>,
    );
    const install = await screen.findByRole('button', { name: 'Install Claude Code' });
    expect(document.body.textContent).not.toMatch(/npm/);
    fireEvent.click(screen.getByRole('button', { name: 'Download Codex' }));
    expect(opened).toEqual(['https://github.com/openai/codex/releases/latest']);
    fireEvent.click(install);
    await vi.waitFor(() => expect(calls).toContainEqual({ name: 'agent.install', input: { provider: 'claude-code' } }));
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Install Claude Code' })).toBeNull());
  });
});

describe('the desk’s analyst with no model on', () => {
  it('offers Turn on in the panel, and a question asked first waits there above the rows', async () => {
    putRuntimeSettings({ 'agent.providers': {} }, true);
    const { client } = answeringClient({
      'agent.list_providers': () => ({ providers: [off('codex', 'Codex'), off('claude-code', 'Claude Code')] }),
    });
    const bridge = {};
    setTestServices(client, bridge);
    seedTools(['agent.list_providers', 'settings.set']);
    render(
      <TestRuntime client={client} bridge={bridge} clock={clock}>
        <TooltipProvider>
          <AnalystPanel />
        </TooltipProvider>
      </TestRuntime>,
    );
    const panel = screen.getByRole('region', { name: 'Analyst' });
    expect(await within(panel).findByRole('button', { name: 'Turn on Claude Code' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Turn on Codex' })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Connect a model' })).toBeNull();
    const box = within(panel).getByRole('textbox', { name: 'Ask the analyst' });
    fireEvent.change(box, { target: { value: 'What is NQ doing?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect((await within(panel).findByRole('status')).textContent).toBe(
      'Your question waits here. Turn one on, then send it.',
    );
    expect(within(panel).getByRole('button', { name: 'Turn on Claude Code' })).toBeTruthy();
    expect(panel.textContent).not.toContain('Settings');
    expect(within(panel).getByRole<HTMLTextAreaElement>('textbox', { name: 'Ask the analyst' }).value).toBe(
      'What is NQ doing?',
    );
  });
});

describe('a question asked before the models are listed', () => {
  it('waits with the rows once they come, instead of saying no model is connected', async () => {
    putRuntimeSettings({ 'agent.providers': {} }, true);
    const { client } = answeringClient({
      'agent.list_providers': () => ({ providers: [off('codex', 'Codex'), off('claude-code', 'Claude Code')] }),
    });
    const bridge = {};
    setTestServices(client, bridge);
    seedTools(['agent.list_providers', 'settings.set']);
    render(
      <TestRuntime client={client} bridge={bridge} clock={clock}>
        <TooltipProvider>
          <AnalystPanel />
        </TooltipProvider>
      </TestRuntime>,
    );
    const panel = screen.getByRole('region', { name: 'Analyst' });
    expect(within(panel).queryByRole('button', { name: 'Turn on Codex' })).toBeNull();
    const box = within(panel).getByRole('textbox', { name: 'Ask the analyst' });
    fireEvent.change(box, { target: { value: 'What is NQ doing?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await within(panel).findByRole('button', { name: 'Turn on Codex' })).toBeTruthy();
    expect(within(panel).getByRole('status').textContent).toBe('Your question waits here. Turn one on, then send it.');
    expect(panel.textContent).not.toContain('No model is connected');
  });
});

describe('signing a provider in', () => {
  it('starts the CLI’s sign-in, opens its page, and takes the code a page opened again ends on', async () => {
    putRuntimeSettings({ 'agent.providers': { 'claude-code': { enabled: true } } }, true);
    const page = { url: 'https://claude.invalid/oauth?code=true', opened: true, takesCode: true };
    const { client, calls } = answeringClient({
      'agent.list_providers': () => ({ providers: [claude({ status: 'disconnected', message: 'Not signed in' })] }),
      'agent.sign_in': ({ provider, code }) => ({ provider, page: code ? null : page }),
    });
    const opened: string[] = [];
    const bridge = {
      openExternal: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    };
    setTestServices(client, bridge);
    seedTools(['agent.list_providers', 'agent.sign_in']);
    render(
      <TestRuntime client={client} bridge={bridge} clock={clock}>
        <ConnectAi />
      </TestRuntime>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Claude Code' }));
    await screen.findByText('Finish signing in in your browser; it connects here by itself.');
    expect(calls).toContainEqual({ name: 'agent.sign_in', input: { provider: 'claude-code' } });
    expect(opened).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Open the page again' }));
    expect(opened).toEqual([page.url]);
    const field = screen.getByRole('textbox', { name: 'Claude Code sign-in code' });
    fireEvent.change(field, { target: { value: ' abc-123 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() =>
      expect(calls).toContainEqual({ name: 'agent.sign_in', input: { provider: 'claude-code', code: 'abc-123' } }),
    );
    await screen.findByRole('button', { name: 'Sign in to Claude Code' });
  });

  it('opens the page itself when the CLI did not (Codex’s)', async () => {
    putRuntimeSettings({ 'agent.providers': { codex: { enabled: true } } }, true);
    const url = 'https://auth.openai.invalid/oauth/authorize';
    const { client } = answeringClient({
      'agent.list_providers': () => ({ providers: [codex({ status: 'disconnected', message: 'Not signed in' })] }),
      'agent.sign_in': ({ provider }) => ({ provider, page: { url, opened: false, takesCode: false } }),
    });
    const opened: string[] = [];
    const bridge = {
      openExternal: (u: string) => {
        opened.push(u);
        return Promise.resolve();
      },
    };
    setTestServices(client, bridge);
    seedTools(['agent.list_providers', 'agent.sign_in']);
    render(
      <TestRuntime client={client} bridge={bridge} clock={clock}>
        <ConnectAi />
      </TestRuntime>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    await vi.waitFor(() => expect(opened).toEqual([url]));
    fireEvent.click(screen.getByRole('button', { name: 'Open the page again' }));
    expect(opened).toEqual([url, url]);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('the model selector with a provider off', () => {
  it('says it is off and turns it on from there', () => {
    const views = providerViews([codex(), off('claude-code', 'Claude Code')], []);
    const turnedOn: string[] = [];
    render(
      <TooltipProvider>
        <ModelPicker
          providers={views}
          pick={{ provider: 'codex', model: 'gpt-6-astra', effort: null }}
          sessionProvider={null}
          onPick={() => undefined}
          onTurnOn={(id) => turnedOn.push(id)}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Model: GPT-6 Astra' }));
    expect(screen.queryByRole('button', { name: 'Turn on Codex' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    expect(screen.getByText(OFF_WHY)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Claude Code' }));
    expect(turnedOn).toEqual(['claude-code']);
  });
});
