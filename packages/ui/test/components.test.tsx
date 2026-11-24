import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Approve,
  Avatar,
  ShownContext,
  Count,
  AuditLine,
  Button,
  Check,
  Choice,
  CommandLine,
  DraftCard,
  EnvWord,
  Field,
  IconButton,
  Key,
  Kv,
  Log,
  LogEntry,
  Mark,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
  NowLine,
  Num,
  NumberCell,
  PlanStrip,
  PlatformProvider,
  PriceInput,
  Radio,
  Readback,
  Segmented,
  Slip,
  Stat,
  StatusLine,
  Table,
  TBody,
  Tr,
  Trust,
  TRUST_MS,
  envKind,
  trustDisarms,
  trustOf,
  useCloseMenu,
  useDocumentEnv,
  useShowKeysOnHold,
  MOTION,
  Splitter,
} from '../src/index.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const noop = () => undefined;

const fake = () =>
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
  });
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe('numbers and tables', () => {
  it('NumberCell sets prices in Figures and colours only P&L and changes', () => {
    render(
      <Table>
        <TBody>
          <Tr selected>
            <NumberCell value={487.85} precision={2} />
            <NumberCell value={665} kind="pnl" />
            <NumberCell value={-210} kind="pnl" />
            <NumberCell value={-2.06} kind="percent" />
          </Tr>
        </TBody>
      </Table>,
    );
    const cells = screen.getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual(['487.85', '+$665.00', '−$210.00', '−2.06%']);
    expect(cells.slice(1).map((c) => c.dataset.tone)).toEqual(['up', 'down', 'down']);
    expect(['up', 'down']).not.toContain(cells[0]!.dataset.tone);
    expect(screen.getByRole('row').getAttribute('aria-selected')).toBe('true');
  });

  it('Num renders Sans tabular numbers with an explicit tone', () => {
    render(<Num value={0.6} precision={2} tone="muted" data-testid="n" />);
    const n = screen.getByTestId('n');
    expect(n.textContent).toBe('0.60');
    expect(n.dataset.tone).toBe('muted');
  });

  it('Kv, the log and a stat render their parts', () => {
    render(
      <>
        <Kv rows={[{ label: 'Balance', value: '$51,240.00' }]} />
        <Log>
          <LogEntry time="14:36" by="analyst" src="Gamma reversion v3">
            Reclaimed the flip on 1.8× volume.
          </LogEntry>
          <LogEntry time="14:40" by="you">
            you · why did the flip hold
          </LogEntry>
        </Log>
        <Stat label="First touches that reverted" figure="61.7%" focal />
      </>,
    );
    expect(document.querySelector('dl dt')?.textContent).toBe('Balance');
    expect(document.querySelector('dl dd')?.textContent).toBe('$51,240.00');
    const [a, y] = [...screen.getByRole('log').children];
    expect(a!.querySelector('time')?.textContent).toBe('14:36');
    expect(a!.querySelector('time + span > span')?.textContent).toBe('Gamma reversion v3');
    expect(y!.querySelector('time')?.textContent).toBe('14:40');
    expect(screen.getByText('61.7%')).toBeTruthy();
  });
});

describe('words, keys and the environment', () => {
  it('Key prints the platform chord, and marks it held', () => {
    const { rerender } = render(
      <PlatformProvider value="mac">
        <Key shortcut="mod+k" />
      </PlatformProvider>,
    );
    expect(screen.getByText('⌘K').tagName).toBe('KBD');
    rerender(
      <PlatformProvider value="other">
        <Key shortcut="mod+k" held />
      </PlatformProvider>,
    );
    expect(screen.getByText('Ctrl+K').tagName).toBe('KBD');
  });

  it('holding ⌘ for 400 ms prints the keys; a chord or letting go hides them', () => {
    fake();
    function Host() {
      useShowKeysOnHold('mac');
      return null;
    }
    render(<Host />);
    const html = document.documentElement;
    fireEvent.keyDown(window, { key: 'Meta' });
    advance(399);
    expect(html.classList.contains('show-keys')).toBe(false);
    advance(1);
    expect(html.classList.contains('show-keys')).toBe(true);
    fireEvent.keyUp(window, { key: 'Meta' });
    expect(html.classList.contains('show-keys')).toBe(false);
    fireEvent.keyDown(window, { key: 'Meta' });
    fireEvent.keyDown(window, { key: 'k' });
    advance(500);
    expect(html.classList.contains('show-keys')).toBe(false);
  });

  it('the environment word is sentence case and carries its own environment in a list', () => {
    render(
      <>
        <EnvWord env="paper" />
        <EnvWord env="funded" account="Rithmic 4410" data-testid="live" />
        <EnvWord env="eval" account="Eval 50K" left="$690 left today" inherit data-testid="eval" />
      </>,
    );
    expect(screen.getByLabelText('Environment Paper').textContent).toBe('Paper');
    expect(screen.getByLabelText('Environment Paper').dataset.env).toBe('paper');
    expect(screen.getByTestId('live').dataset.env).toBe('live');
    expect(screen.getByTestId('live').textContent).toBe('FundedRithmic 4410');
    expect(screen.getByTestId('eval').dataset.env).toBeUndefined();
    expect(screen.getByTestId('eval').lastElementChild?.textContent).toBe('$690 left today');
    expect([envKind('sim'), envKind('paper'), envKind('eval'), envKind('funded'), envKind('live')]).toEqual([
      'paper',
      'paper',
      'eval',
      'live',
      'live',
    ]);
  });

  it('useDocumentEnv puts the one environment on <html>', () => {
    function Host({ env }: { env: 'paper' | 'live' | null }) {
      useDocumentEnv(env);
      return null;
    }
    const { rerender, unmount } = render(<Host env="paper" />);
    expect(document.documentElement.dataset.env).toBe('paper');
    rerender(<Host env="live" />);
    expect(document.documentElement.dataset.env).toBe('live');
    rerender(<Host env={null} />);
    expect(document.documentElement.dataset.env).toBeUndefined();
    unmount();
  });
});

describe('icons and the keyed T', () => {
  it('draws the mark at the identity sizes, the analyst half low while a draft waits', () => {
    const { container, rerender } = render(<Mark size={24} state="draft" />);
    const i = container.querySelector('i[data-size]')!;
    expect(i.getAttribute('data-size')).toBe('24');
    expect(i.getAttribute('aria-hidden')).toBe('true');
    const halves = () =>
      [...container.querySelectorAll('svg > g')].map((g) => g.querySelector('rect')?.getAttribute('y'));
    const low = halves();
    rerender(<Mark size={24} state="level" />);
    const level = halves();
    expect(Number(low[1])).toBeGreaterThan(Number(level[1]));
    rerender(<Mark size={48} state="rest" label="Tessera" />);
    expect(container.querySelector('i')!.getAttribute('role')).toBe('img');
    expect(container.querySelector('svg')!.getAttribute('height')).toBe('48');
    rerender(<Mark size={16} state="lit" p={1} />);
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('16');
  });

  it('counts what needs the user in a static square, and draws nothing at zero', () => {
    const { container, rerender } = render(<Count n={2} label="2 need you" />);
    const i = container.querySelector('i[role="img"]')!;
    expect(i.textContent).toBe('2');
    expect(i.getAttribute('aria-label')).toBe('2 need you');
    rerender(<Count n={140} />);
    expect(container.querySelector('i[role="img"]')!.textContent).toBe('99+');
    rerender(<Count n={0} />);
    expect(container.querySelector('i[role="img"]')).toBeNull();
  });

  it('draws a person as their tile with their initial, or the account glyph alone, and never says who', () => {
    const { container, rerender } = render(<Avatar initial="R" size="l" />);
    const tile = container.querySelector('[data-size]')!;
    expect(tile.getAttribute('aria-hidden')).toBe('true');
    expect(tile.getAttribute('data-size')).toBe('l');
    expect(tile.textContent).toBe('R');
    expect(tile.hasAttribute('data-empty')).toBe(false);
    rerender(<Avatar initial={null} />);
    const empty = container.querySelector('[data-size]')!;
    expect(empty.getAttribute('data-size')).toBe('s');
    expect(empty.hasAttribute('data-empty')).toBe(true);
    expect(empty.querySelector('svg')?.getAttribute('data-icon')).toBe('you');
    expect(empty.textContent).toBe('');
  });
});

describe('controls', () => {
  it('buttons: words, square, one mist block; a tool is an icon with its word as its name', () => {
    render(
      <PlatformProvider value="mac">
        <Button variant="primary" shortcut="mod+enter">
          Keep
        </Button>
        <Button variant="destructive" what="key">
          Remove
        </Button>
        <IconButton label="Crosshair" icon="crosshair" active />
      </PlatformProvider>,
    );
    const keep = screen.getByRole('button', { name: 'Keep ⌘⏎' });
    expect(keep.querySelector('kbd')?.textContent).toBe('⌘⏎');
    expect(screen.getByRole('button', { name: 'Remove key' }).lastElementChild?.textContent).toBe('key');
    const tool = screen.getByRole('button', { name: 'Crosshair' });
    expect(tool.getAttribute('aria-pressed')).toBe('true');
  });

  it('a destructive button runs on one click', () => {
    const onClick = vi.fn();
    render(
      <Button variant="destructive" what="NQ" onClick={onClick}>
        Flatten
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Flatten NQ' });
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('Segmented marks the current word with the underline and reports changes', () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="Interval"
        value="5m"
        onChange={onChange}
        options={[
          { value: '1m', label: '1m' },
          { value: '5m', label: '5m' },
        ]}
      />,
    );
    expect(screen.getByRole('group', { name: 'Interval' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '5m' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '1m' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '1m' }));
    expect(onChange).toHaveBeenCalledWith('1m');
  });

  it('a toggle is two words; locked, nothing changes', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Choice
        label="Alerts"
        value="on"
        onChange={onChange}
        options={[
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ]}
      />,
    );
    expect(screen.getByRole('radio', { name: 'On' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    expect(onChange).toHaveBeenCalledWith('off');
    rerender(
      <Choice
        label="Alerts"
        value="on"
        locked
        onChange={onChange}
        options={[
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radio', { name: 'On' }).getAttribute('aria-checked')).toBe('true');
  });

  it('checkbox and radio are square, with real inputs behind the row', () => {
    const onCheck = vi.fn();
    const onPick = vi.fn();
    render(
      <>
        <Check checked="mixed" onChange={onCheck}>
          Some
        </Check>
        <Radio name="unit" checked onChange={onPick}>
          Ticks
        </Radio>
      </>,
    );
    const box = screen.getByRole('checkbox', { name: 'Some' });
    expect(box.getAttribute('aria-checked')).toBe('mixed');
    fireEvent.click(box);
    expect(onCheck).toHaveBeenCalledWith(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Ticks' }).checked).toBe(true);
  });

  it('a field says what went wrong in t1 with the alert, never red; a price steps by the tick', () => {
    const onStep = vi.fn();
    render(
      <>
        <Field label="Password" error="Rithmic refused: password." htmlFor="pw">
          <input id="pw" />
        </Field>
        <PriceInput aria-label="Limit price" value="20,615.00" onChange={noop} onStep={onStep} />
      </>,
    );
    expect(screen.getByRole('alert').textContent).toBe('Rithmic refused: password.');
    const price = screen.getByRole('textbox', { name: 'Limit price' });
    expect(price.getAttribute('placeholder')).toBeNull();
    fireEvent.keyDown(price, { key: 'ArrowUp' });
    fireEvent.keyDown(price, { key: 'ArrowDown', shiftKey: true });
    expect(onStep.mock.calls).toEqual([[1], [-4]]);
    fireEvent.click(screen.getByRole('button', { name: 'Up a tick' }));
    expect(onStep).toHaveBeenLastCalledWith(1);
  });

  it('the command line: no placeholder, the prompt colour by addressee, a named Enter', () => {
    function Line() {
      const [v, setV] = useState('');
      return (
        <PlatformProvider value="mac">
          <Readback rule="$690 left today · max 1 at this stop">
            <span className="v">Buy 4</span> NQ Z6
          </Readback>
          <CommandLine
            aria-label="Command"
            value={v}
            onChange={setV}
            to={v.endsWith('?') ? 'analyst' : 'you'}
            enter={v ? [{ shortcut: 'enter', label: 'ask' }] : { inert: 'no analyst' }}
          />
        </PlatformProvider>
      );
    }
    render(<Line />);
    const input = screen.getByRole('textbox', { name: 'Command' });
    const line = input.closest('.t-cmd')!;
    expect(input.getAttribute('placeholder')).toBeNull();
    expect(line.getAttribute('data-to')).toBeNull();
    expect(line.textContent).toContain('no analyst');
    fireEvent.change(input, { target: { value: 'why did the flip hold?' } });
    expect(line.getAttribute('data-to')).toBe('analyst');
    expect(line.textContent).toContain('⏎ask');
    expect(line.textContent).not.toContain('no analyst');
    expect(screen.getByText('$690 left today · max 1 at this stop')).toBeTruthy();
  });

  // Radix gives the focus back a task after the menu unmounts
  const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

  it('a menu closed after a press gives its trigger the focus without the keyboard’s ring; after a key, with it', async () => {
    function Picker({ open }: { open: boolean }) {
      return (
        <Menu open={open}>
          <MenuTrigger>Account</MenuTrigger>
          <MenuContent>
            <MenuItem>Paper</MenuItem>
          </MenuContent>
        </Menu>
      );
    }
    const { rerender } = render(<Picker open />);
    const trigger = screen.getByRole('button', { name: 'Account', hidden: true });
    const focus = vi.spyOn(trigger, 'focus');
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Paper' }));
    rerender(<Picker open={false} />);
    await waitFor(() => expect(focus).toHaveBeenLastCalledWith({ preventScroll: true, focusVisible: false }));
    rerender(<Picker open />);
    await waitFor(() => expect(screen.getByRole('menu').contains(document.activeElement)).toBe(true));
    focus.mockClear();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    rerender(<Picker open={false} />);
    await waitFor(() => expect(focus).toHaveBeenCalled());
    expect(focus).not.toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
  });

  it('a part of a menu can close it, the caller hearing it as from a pick', async () => {
    const heard: boolean[] = [];
    function Done() {
      const close = useCloseMenu();
      return <MenuItem onSelect={(e) => (e.preventDefault(), close())}>Save</MenuItem>;
    }
    render(
      <Menu defaultOpen onOpenChange={(o) => heard.push(o)}>
        <MenuTrigger>Templates</MenuTrigger>
        <MenuContent>
          <Done />
        </MenuContent>
      </Menu>,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(heard).toEqual([false]);
  });

  it('a menu leaves the focus where a pick moved it on purpose', async () => {
    function Picker({ open }: { open: boolean }) {
      return (
        <>
          <input aria-label="Revealed" />
          <Menu open={open}>
            <MenuTrigger>Account</MenuTrigger>
            <MenuContent>
              <MenuItem>Accounts & connections</MenuItem>
            </MenuContent>
          </Menu>
        </>
      );
    }
    const { rerender } = render(<Picker open />);
    const revealed = screen.getByRole('textbox', { name: 'Revealed', hidden: true });
    fireEvent.pointerDown(screen.getByRole('menuitem'));
    rerender(<Picker open={false} />);
    revealed.focus();
    await settle();
    expect(document.activeElement).toBe(revealed);
  });

  it('menus are the system menu: rows, keys at the end, the chosen row by the mist rule', () => {
    render(
      <PlatformProvider value="mac">
        <Menu open>
          <MenuTrigger>Lens</MenuTrigger>
          <MenuContent>
            <MenuItem shortcut="l">Ladder</MenuItem>
            <MenuItem hint="Research" disabled>
              Study touches
            </MenuItem>
            <MenuRadioGroup value="5m">
              <MenuRadioItem value="1m">1m</MenuRadioItem>
              <MenuRadioItem value="5m">5m</MenuRadioItem>
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </PlatformProvider>,
    );
    const menu = screen.getByRole('menu');
    expect(screen.getByRole('menuitem', { name: 'Ladder L' }).textContent).toMatch(/^Ladder.*L$/);
    expect(screen.getByRole('menuitem', { name: 'Study touches Research' }).getAttribute('data-disabled')).toBe('');
    expect(screen.getByRole('menuitemradio', { name: '5m' }).getAttribute('data-state')).toBe('checked');
    expect(menu.textContent).not.toContain('✓');
  });

  it('a disabled row with a reason stays reachable and tells the tooltip and a screen reader why', async () => {
    render(
      <Menu open>
        <MenuTrigger>Trade</MenuTrigger>
        <MenuContent>
          <MenuItem disabled why="From the connection">
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>,
    );
    const remove = screen.getByRole('menuitem', { name: 'Delete' });
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    expect(remove.getAttribute('data-disabled')).toBe('');
    const id = remove.getAttribute('aria-describedby')!;
    expect(document.getElementById(id)?.textContent).toBe('From the connection');
    fireEvent.keyDown(window, { key: 'Tab' });
    act(() => remove.focus());
    expect(document.activeElement).toBe(remove);
    expect((await screen.findByRole('tooltip')).textContent).toBe('From the connection');
    fireEvent.click(remove);
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('a menu row takes a glyph before its words, a tick for on, a chevron for a submenu, and a destructive tone', () => {
    render(
      <PlatformProvider value="mac">
        <Menu open>
          <MenuTrigger>Tile</MenuTrigger>
          <MenuContent>
            <MenuLabel>Lines</MenuLabel>
            <MenuItem icon="trend-line" shortcut="alt+t">
              Trend line
            </MenuItem>
            <MenuCheckboxItem checked>Grid</MenuCheckboxItem>
            <MenuCheckboxItem checked={false}>Volume</MenuCheckboxItem>
            <MenuSub>
              <MenuSubTrigger hint="Candles">Chart type</MenuSubTrigger>
            </MenuSub>
            <MenuItem destructive>Close</MenuItem>
          </MenuContent>
        </Menu>
      </PlatformProvider>,
    );
    const trend = screen.getByRole('menuitem', { name: 'Trend line ⌥T' });
    expect(trend.firstElementChild?.querySelector('[data-icon="trend-line"]')).toBeTruthy();
    const grid = screen.getByRole('menuitemcheckbox', { name: 'Grid' });
    const volume = screen.getByRole('menuitemcheckbox', { name: 'Volume' });
    expect([grid.getAttribute('data-state'), volume.getAttribute('data-state')]).toEqual(['checked', 'unchecked']);
    const sub = screen.getByRole('menuitem', { name: 'Chart type Candles' });
    expect(sub.lastElementChild?.getAttribute('data-icon')).toBe('chevron-right');
    expect(sub.textContent).not.toContain('›');
    expect(screen.getByRole('menuitem', { name: 'Close' })).toBeTruthy();
    expect(screen.getByText('Lines')).toBeTruthy();
  });
});

describe('the approve control', () => {
  beforeEach(() => {
    fake();
  });

  it('is never in the tab order or focused, arms after 600 ms, and paper commits once on a click', () => {
    const onApprove = vi.fn();
    render(
      <div data-env="paper">
        <Approve env="paper" envLabel="on paper" onApprove={onApprove} />
      </div>,
    );
    const b = screen.getByRole('button', { name: 'Approve on paper' });
    expect(b.tabIndex).toBe(-1);
    expect(document.activeElement).not.toBe(b);
    expect(b.dataset.state).toBe('arming');
    expect(b.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(b);
    advance(MOTION.armMs - 1);
    fireEvent.click(b);
    expect(onApprove).not.toHaveBeenCalled();
    advance(1);
    expect(b.dataset.state).toBe('armed');
    expect(b.getAttribute('aria-disabled')).toBeNull();
    fireEvent.keyDown(b, { key: ' ' });
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.click(b);
    fireEvent.click(b);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('eval and live approve on one click or ⏎ too, after the same arming', () => {
    const onApprove = vi.fn();
    const { unmount } = render(
      <div data-env="eval">
        <Approve env="eval" envLabel="on Eval 50K" onApprove={onApprove} />
      </div>,
    );
    const b = screen.getByRole('button', { name: 'Approve on Eval 50K' });
    fireEvent.click(b);
    expect(onApprove).not.toHaveBeenCalled();
    advance(MOTION.armMs);
    fireEvent.click(b);
    expect(onApprove).toHaveBeenCalledTimes(1);
    unmount();
    const onLive = vi.fn();
    render(<Approve env="live" envLabel="live · Rithmic 4410" onApprove={onLive} />);
    advance(MOTION.armMs);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Approve live · Rithmic 4410' }), { key: 'Enter' });
    expect(onLive).toHaveBeenCalledTimes(1);
  });

  it('disarms at once with the reason as its label, and re-arms 600 ms after it clears', () => {
    const onApprove = vi.fn();
    const { rerender } = render(<Approve env="paper" envLabel="on paper" onApprove={onApprove} />);
    advance(MOTION.armMs);
    rerender(
      <Approve
        env="paper"
        envLabel="on paper"
        onApprove={onApprove}
        disarmed={{ l1: 'Price 2.4 s behind', l2: 'Rithmic · paused' }}
      />,
    );
    const b = screen.getByRole('button', { name: 'Price 2.4 s behind Rithmic · paused' });
    expect(b.dataset.state).toBe('disabled');
    expect(b.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(b);
    rerender(<Approve env="paper" envLabel="on paper" onApprove={onApprove} />);
    expect(b.dataset.state).toBe('arming');
    fireEvent.click(b);
    expect(onApprove).not.toHaveBeenCalled();
    advance(MOTION.armMs);
    fireEvent.click(b);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('mounted out of sight it never arms, and arms 600 ms after it is shown', () => {
    const onApprove = vi.fn();
    const at = (shown: boolean) => (
      <ShownContext.Provider value={shown}>
        <Approve env="eval" envLabel="on Eval 50K" onApprove={onApprove} />
      </ShownContext.Provider>
    );
    const { rerender } = render(at(false));
    const b = screen.getByRole('button', { name: 'Approve on Eval 50K' });
    advance(MOTION.armMs * 10);
    expect(b.dataset.state).toBe('arming');
    fireEvent.click(b);
    expect(onApprove).not.toHaveBeenCalled();
    rerender(at(true));
    advance(MOTION.armMs - 1);
    fireEvent.click(b);
    expect(onApprove).not.toHaveBeenCalled();
    advance(1);
    expect(b.dataset.state).toBe('armed');
    rerender(at(false));
    expect(b.dataset.state).toBe('arming');
    fireEvent.click(b);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('a still (the reference page) draws a state and never commits', () => {
    const onApprove = vi.fn();
    render(<Approve env="eval" envLabel="on Eval 50K" onApprove={onApprove} still={{ state: 'arming', p: 0.5 }} />);
    const b = screen.getByRole('button');
    expect(b.dataset.state).toBe('arming');
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.style.getPropertyValue('--p')).toBe('0.5');
    advance(MOTION.armMs * 2);
    fireEvent.click(b);
    fireEvent.keyDown(b, { key: 'Enter' });
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('re-arms from zero when a field changes or the window comes back', () => {
    const onApprove = vi.fn();
    const { rerender } = render(<Approve env="paper" envLabel="on paper" armKey={1} onApprove={onApprove} />);
    const b = screen.getByRole('button');
    advance(MOTION.armMs);
    expect(b.dataset.state).toBe('armed');
    rerender(<Approve env="paper" envLabel="on paper" armKey={2} onApprove={onApprove} />);
    expect(b.dataset.state).toBe('arming');
    advance(MOTION.armMs);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(b.dataset.state).toBe('arming');
  });
});

const markOf = (card: Element) => card.querySelector('i[data-size]');

describe('the draft card', () => {
  beforeEach(() => {
    fake();
  });

  const card = (extra: Partial<Parameters<typeof DraftCard>[0]> = {}) => (
    <DraftCard
      env="paper"
      account="paper-main"
      plan="Plan A · 14:36"
      left="10:30 left"
      order="Buy 2 NQ Z6"
      price="20,615.00"
      post="limit"
      distance="26.25 below last"
      distanceWide=" · 105 ticks"
      rows={[
        { label: 'Stop', price: '20,598.00', value: '−$680' },
        { label: 'Target', price: '20,700.00', value: '+$3,400' },
        { label: 'After fill', text: 'Long 2', value: '5.0R', wide: true },
      ]}
      sum="−$680 · +$3,400 · 5.0R"
      envLabel="on paper"
      onApprove={noop}
      onEdit={noop}
      onReject={noop}
      {...extra}
    />
  );

  it('shown again after being out of sight, its Approve arms from zero', () => {
    const onApprove = vi.fn();
    const at = (shown: boolean) => <ShownContext.Provider value={shown}>{card({ onApprove })}</ShownContext.Provider>;
    const { rerender } = render(at(true));
    advance(MOTION.armMs);
    const approve = () => screen.getByRole('button', { name: 'Approve on paper' });
    expect(approve().dataset.state).toBe('armed');
    rerender(at(false));
    advance(MOTION.armMs * 10);
    rerender(at(true));
    expect(approve().dataset.state).toBe('arming');
    advance(MOTION.armMs - 1);
    fireEvent.click(approve());
    expect(onApprove).not.toHaveBeenCalled();
    advance(1);
    fireEvent.click(approve());
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('is headed by the keyed T; focus lands on the card, ↓ reaches Approve, then Edit and Reject', () => {
    render(card());
    const draft = screen.getByRole('group', { name: 'Draft' });
    expect(markOf(draft)?.getAttribute('data-state')).toBe('draft');
    expect(draft.textContent).toMatch(/^DraftPlan A · 14:36paper-main·10:30 left/);
    expect(draft.textContent).not.toMatch(/⌘|⏎/);
    act(() => draft.focus());
    expect(document.activeElement).toBe(draft);
    const approve = screen.getByRole('button', { name: 'Approve on paper' });
    fireEvent.keyDown(draft, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(approve);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Edit');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Reject');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(approve);
  });

  it('paper: one click, then the approve moment runs and settles', () => {
    const onApprove = vi.fn();
    const onSettled = vi.fn();
    render(card({ onApprove, onSettled }));
    const b = screen.getByRole('button', { name: 'Approve on paper' });
    advance(MOTION.armMs);
    fireEvent.click(b);
    expect(onApprove).toHaveBeenCalledTimes(1);
    const mark = () => markOf(screen.getByRole('group', { name: 'Draft' }))?.getAttribute('data-state');
    advance(20);
    expect(mark()).toBe('rise');
    advance(MOTION.riseMs);
    expect(onSettled).not.toHaveBeenCalled();
    advance(MOTION.seamMs + MOTION.litMs + MOTION.drainMs + 100);
    expect(mark()).toBe('rest');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('approved: the head says so, Edit and Reject leave, the broker’s first answer takes their place', () => {
    render(card({ approved: { at: '14:42:31', sending: 'Sending to paper' } }));
    const draft = screen.getByRole('group', { name: 'Draft' });
    expect(draft.getAttribute('data-state')).toBe('approved');
    expect(draft.textContent).toMatch(/^Approved by you14:42:31/);
    expect(markOf(draft)?.getAttribute('data-state')).toBe('lit');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(within(draft).getByText('Sending to paper')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approved on paper' }).dataset.state).toBe('approved');
  });

  it('expired: quiet, the mark rests, Redraft and Dismiss; a typed ticket has no T and says Send', () => {
    const { unmount } = render(
      card({ expired: { l1: 'Expired 14:53', l2: 'Not sent' }, left: undefined, distance: undefined, onRedraft: noop }),
    );
    const draft = screen.getByRole('group', { name: 'Draft' });
    expect(draft.getAttribute('data-state')).toBe('expired');
    expect(markOf(draft)?.getAttribute('data-state')).toBe('rest');
    expect(screen.getByRole('button', { name: 'Expired 14:53 Not sent' }).dataset.state).toBe('disabled');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Expired 14:53Not sent',
      'Redraft',
      'Dismiss',
    ]);
    unmount();
    render(card({ typed: true, typedBy: 'you · typed', plan: undefined }));
    const t = screen.getByRole('group', { name: 'Ticket' });
    expect(markOf(t)).toBeNull();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy();
  });

  it('the audit line: your act, then the broker’s answer', () => {
    const { container } = render(
      <AuditLine
        act="Approved on paper"
        at="14:42:31 · you"
        answer={{ state: 'sending', text: 'Sending · Buy 2 NQ Z6', progress: 0.45 }}
      />,
    );
    const a = container.firstElementChild!;
    expect(a.getAttribute('data-state')).toBe('sending');
    expect(a.textContent).toMatch(/^Approved on paper14:42:31 · you/);
    expect((a as HTMLElement).style.getPropertyValue('--p')).toBe('0.45');
  });
});

describe('orders, plans, trust and status', () => {
  it('the slip says one order as one sentence, the state in its column', () => {
    render(
      <Slip
        state="staged"
        verb="Buy 2 NQ Z6"
        parts={[
          { w: 'limit', price: '20,615.00' },
          { w: 'stop', price: '20,598.00' },
          { w: 'risk', text: '$680' },
        ]}
        env="Eval 50K"
        status="staged · blocked"
        rule={{ text: '$680 risk + $10 slip = $690: all of today’s $690.', block: true, act: 'Size to fit → 1' }}
      />,
    );
    const slip = document.querySelector('[data-state="staged"]')!;
    const [say, state, rule] = [...slip.children];
    expect(say!.textContent).toBe('Buy 2 NQ Z6limit20,615.00·stop20,598.00·risk$680·Eval 50K');
    expect([...say!.children].filter((part) => part.textContent === '·')).toHaveLength(3);
    expect(state!.textContent).toBe('staged · blocked');
    expect(rule!.textContent).toBe('$680 risk + $10 slip = $690: all of today’s $690.Size to fit → 1');
  });

  it('plan strips and the now line', () => {
    const go = vi.fn();
    render(
      <>
        <PlanStrip
          name="Plan A"
          side="long"
          trigger="reclaim 20,610"
          state="triggered"
          status="triggered 14:36"
          go={{ label: 'draft ›', onClick: go }}
        />
        <NowLine price="20,641.25" away="Plan B 81.25 away" />
        <PlanStrip name="Plan B" side="short" trigger="under 20,560" state="armed" status="armed" away="81.25 away" />
      </>,
    );
    const [a, now, b] = [...document.body.firstElementChild!.children];
    expect(a!.getAttribute('data-state')).toBe('triggered');
    fireEvent.click(screen.getByRole('button', { name: 'draft ›' }));
    expect(go).toHaveBeenCalled();
    expect(b!.getAttribute('data-state')).toBe('armed');
    expect(b!.lastElementChild!.textContent).toBe('armed · 81.25 away');
    expect(now!.textContent).toBe('now 20,641.25Plan B 81.25 away');
  });

  it('trust lives on the number: behind dims at 1 s and disarms at 2 s, stale at 3 s of silence', () => {
    expect(trustOf({ lagMs: 400 })).toBe('live');
    expect(trustOf({ quiet: true })).toBe('quiet');
    expect(trustOf({ lagMs: TRUST_MS.behind })).toBe('behind');
    expect(trustOf({ silentMs: TRUST_MS.stale, lagMs: 1500 })).toBe('stale');
    expect(trustOf({ sourceDown: true, silentMs: 9000 })).toBe('invalid');
    expect(trustDisarms('behind', 1800)).toBe(false);
    expect(trustDisarms('behind', 2400)).toBe(true);
    expect(trustDisarms('stale')).toBe(true);
    expect(trustDisarms('invalid')).toBe(true);
    expect(trustDisarms('quiet')).toBe(false);
    const { rerender } = render(
      <Trust trust="live" age="1.8 s behind" data-testid="trust">
        <span>20,641.25</span>
      </Trust>,
    );
    expect(screen.queryByText('1.8 s behind')).toBeNull();
    rerender(
      <Trust trust="stale" age="No ticks 4 s · approval paused" data-testid="trust">
        <span>20,641.25</span>
      </Trust>,
    );
    expect(screen.getByTestId('trust').getAttribute('data-trust')).toBe('stale');
    expect(screen.getByTestId('trust').lastElementChild!.textContent).toBe('No ticks 4 s · approval paused');
  });

  it('a status line: fact, consequence, next; the door is the key before the verb', () => {
    const open = vi.fn();
    render(
      <PlatformProvider value="mac">
        <StatusLine
          kind="exposure"
          src="Tradovate"
          fact="dropped."
          exposure="Long 2 held at Tradovate."
          next="2nd try."
          action={{ label: 'Tradovate', shortcut: 'mod+o', onClick: open }}
        />
      </PlatformProvider>,
    );
    const line = screen.getByRole('status');
    expect(line.dataset.kind).toBe('exposure');
    expect(screen.getByText('Long 2 held at Tradovate.')).toBeTruthy();
    const door = screen.getByRole('button', { name: '⌘O Tradovate' });
    expect(door.firstElementChild!.tagName).toBe('KBD');
    fireEvent.click(door);
    expect(open).toHaveBeenCalled();
  });
});

describe('the resize handle (Splitter)', () => {
  afterEach(cleanup);

  it('reports the travel since the drag began, resets on double-click and steps with the arrows', () => {
    const travel: number[] = [];
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const onReset = vi.fn();
    const steps: number[] = [];
    render(
      <Splitter
        label="Resize the nav"
        onDrag={(t) => travel.push(t)}
        onDragStart={onStart}
        onDragEnd={onEnd}
        onReset={onReset}
        onStep={(d) => steps.push(d)}
      />,
    );
    const handle = screen.getByRole('separator', { name: 'Resize the nav' });
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
    expect(onStart).toHaveBeenCalledOnce();
    expect(handle.hasAttribute('data-dragging')).toBe(true);
    fireEvent.pointerMove(handle, { clientX: 340, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 120, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 120, pointerId: 1 });
    expect(travel).toEqual([40, -180]);
    expect(onEnd).toHaveBeenCalledOnce();
    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 });
    expect(travel).toHaveLength(2);
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledOnce();
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(steps).toEqual([-16, 64]);
  });
});
