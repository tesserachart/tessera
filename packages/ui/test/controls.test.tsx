import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Combobox,
  comboboxRows,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  FormActions,
  FormRow,
  FormSection,
  ScrollArea,
  SearchList,
  Select,
  Sheet,
  SheetContent,
  Switch,
  ToggleGroup,
  Tooltip,
  isContextMenuKey,
  openContextMenuAt,
  type ComboboxOption,
} from '../src/index.ts';

afterEach(cleanup);

const OPTIONS: ComboboxOption[] = [
  { value: 'vwap', label: 'VWAP', group: 'Trend', keywords: ['volume weighted'] },
  { value: 'ema', label: 'EMA', group: 'Trend' },
  { value: 'rsi', label: 'RSI', group: 'Momentum', hint: 'pane' },
  { value: 'big', label: 'Big trades', group: 'Order flow', disabled: true },
  { value: 'svp', label: 'Session volume profile', group: 'Order flow' },
];

const input = () => screen.getByRole('combobox', { name: 'Indicators' });
const activeRow = () => {
  const id = input().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.querySelector('.w')?.textContent : null;
};
const key = (k: string) => fireEvent.keyDown(input(), { key: k });

describe('the searchable list', () => {
  it('draws the rows in their groups, the chosen one checked and active, focus in the search line', () => {
    render(<SearchList label="Indicators" options={OPTIONS} value="ema" onSelect={vi.fn()} autoFocus />);
    expect(document.activeElement).toBe(input());
    const groups = screen.getAllByRole('group');
    expect(groups.map((g) => g.querySelector('.t-menu-label')?.textContent)).toEqual([
      'Trend',
      'Momentum',
      'Order flow',
    ]);
    const ema = screen.getByRole('option', { name: 'EMA' });
    expect(ema.dataset.state).toBe('checked');
    expect(ema.getAttribute('aria-selected')).toBe('true');
    expect(activeRow()).toBe('EMA');
    expect(screen.getByRole('option', { name: 'Big trades' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('narrows as you type, best first, and the best match becomes active', () => {
    render(<SearchList label="Indicators" options={OPTIONS} value="ema" onSelect={vi.fn()} />);
    fireEvent.change(input(), { target: { value: 'vol' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Session volume profile', 'VWAP']);
    expect(activeRow()).toBe('Session volume profile');
  });

  it('moves with the arrows over disabled rows, pages and ends; Enter takes the active row', () => {
    const onSelect = vi.fn();
    render(<SearchList label="Indicators" options={OPTIONS} onSelect={onSelect} />);
    expect(activeRow()).toBe('VWAP');
    key('ArrowDown');
    expect(activeRow()).toBe('EMA');
    key('ArrowDown');
    key('ArrowDown');
    expect(activeRow()).toBe('Session volume profile');
    key('ArrowDown');
    expect(activeRow()).toBe('Session volume profile');
    key('ArrowUp');
    expect(activeRow()).toBe('RSI');
    key('Home');
    expect(activeRow()).toBe('VWAP');
    key('End');
    expect(activeRow()).toBe('Session volume profile');
    key('PageUp');
    expect(activeRow()).toBe('VWAP');
    key('Enter');
    expect(onSelect).toHaveBeenCalledWith('vwap');
  });

  it('loops when asked; the pointer makes a row active and a click takes it, never a disabled one', () => {
    const onSelect = vi.fn();
    render(<SearchList label="Indicators" options={OPTIONS} onSelect={onSelect} loop />);
    key('ArrowUp');
    expect(activeRow()).toBe('Session volume profile');
    fireEvent.pointerMove(screen.getByRole('option', { name: 'RSI pane' }));
    expect(activeRow()).toBe('RSI');
    fireEvent.click(screen.getByRole('option', { name: 'Big trades' }));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'EMA' }));
    expect(onSelect).toHaveBeenCalledWith('ema');
  });

  it('says when nothing matches; Esc clears the query first', () => {
    render(<SearchList label="Indicators" options={OPTIONS} defaultQuery="zz" onSelect={vi.fn()} />);
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toBe('Nothing matches “zz”');
    expect(screen.getByRole('status').closest('[role="listbox"]')).toBeNull();
    expect(screen.getByRole('listbox').children).toHaveLength(0);
    expect(input().getAttribute('aria-activedescendant')).toBeNull();
    key('Enter');
    key('Escape');
    expect((input() as HTMLInputElement).value).toBe('');
    expect(screen.getAllByRole('option')).toHaveLength(5);
  });

  it('takes a controlled query and a custom filter', () => {
    const onQueryChange = vi.fn();
    const onlyTrend = (os: readonly ComboboxOption[]) => os.filter((o) => o.group === 'Trend');
    render(
      <SearchList
        label="Indicators"
        options={OPTIONS}
        query="anything"
        onQueryChange={onQueryChange}
        filter={onlyTrend}
        empty="none"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['VWAP', 'EMA']);
    fireEvent.change(input(), { target: { value: 'x' } });
    expect(onQueryChange).toHaveBeenCalledWith('x');
    expect((input() as HTMLInputElement).value).toBe('anything');
  });
});

describe('the combobox', () => {
  it('names the choice on its box, opens the search in a popover, and a taken row closes it', () => {
    function Harness() {
      const [v, setV] = useState<string | null>('ema');
      return <Combobox label="Indicators" options={OPTIONS} value={v} onValueChange={setV} />;
    }
    render(<Harness />);
    const box = screen.getByRole('button', { name: 'Indicators: EMA' });
    expect(box.textContent).toBe('EMA');
    fireEvent.click(box);
    expect(box.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(input());
    fireEvent.change(input(), { target: { value: 'rs' } });
    key('Enter');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Indicators: RSI' })).toBeTruthy();
  });

  it('lets the first Esc clear a query and the next close the list, focus back on the box', async () => {
    render(<Combobox label="Indicators" options={OPTIONS} />);
    const box = screen.getByRole('button', { name: 'Indicators' });
    fireEvent.click(box);
    fireEvent.change(input(), { target: { value: 'rsi' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    key('Escape');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect((input() as HTMLInputElement).value).toBe('');
    expect(screen.getAllByRole('option')).toHaveLength(5);
    key('Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it('keeps its own value when uncontrolled and shows the placeholder before a choice', () => {
    const onValueChange = vi.fn();
    render(<Combobox label="Indicators" options={OPTIONS} placeholder="Add" onValueChange={onValueChange} />);
    const box = screen.getByRole('button', { name: 'Indicators' });
    expect(box.textContent).toBe('Add');
    expect(box.hasAttribute('data-placeholder')).toBe(true);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('option', { name: 'VWAP' }));
    expect(onValueChange).toHaveBeenCalledWith('vwap');
    expect(screen.getByRole('button', { name: 'Indicators: VWAP' }).hasAttribute('data-placeholder')).toBe(false);
  });
});

describe('select, switch and the scroll area', () => {
  it('a select names its choice in the field box and does not give under a press', () => {
    render(
      <Select
        label="Interval"
        options={[
          { value: '1m', label: '1 minute' },
          { value: '5m', label: '5 minutes', group: 'Intraday' },
        ]}
        defaultValue="5m"
      />,
    );
    const box = screen.getByRole('combobox', { name: 'Interval' });
    expect(box.className).toBe('t-select');
    expect(box.textContent).toBe('5 minutes');
    expect(box.dataset.press).toBe('none');
  });

  it('a select is quiet or small on asking, and disabled stays put', () => {
    render(
      <Select label="Source" variant="quiet" size="s" disabled options={[{ value: 'c', label: 'Close' }]} value="c" />,
    );
    const box = screen.getByRole('combobox', { name: 'Source' });
    expect(box.className).toBe('t-select quiet s');
    expect((box as HTMLButtonElement).disabled).toBe(true);
  });

  it('a switch is a real switch, controlled or not; with its words the row is the target', () => {
    const onChange = vi.fn();
    render(
      <>
        <Switch label="Bands" defaultChecked />
        <Switch checked={false} onCheckedChange={onChange}>
          Size by risk
        </Switch>
      </>,
    );
    const bands = screen.getByRole('switch', { name: 'Bands' });
    expect(bands.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(bands);
    expect(bands.getAttribute('aria-checked')).toBe('false');
    const risk = screen.getByRole('switch', { name: 'Size by risk' });
    expect(risk.className).toBe('t-switch');
    fireEvent.click(screen.getByText('Size by risk'));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(risk.getAttribute('aria-checked')).toBe('false');
  });

  it('a toggle group is several words each on or off, one at a time to its caller', () => {
    const onToggle = vi.fn();
    const options = [
      { value: '1m', label: '1m' },
      { value: '5m', label: '5m' },
      { value: '1h', label: '1h', disabled: true },
    ];
    const { rerender } = render(<ToggleGroup label="Intervals" options={options} value={['5m']} onToggle={onToggle} />);
    const group = screen.getByRole('group', { name: 'Intervals' });
    expect(group.className).toBe('t-toggles');
    const one = screen.getByRole<HTMLButtonElement>('button', { name: '1m' });
    const five = screen.getByRole('button', { name: '5m' });
    expect(one.getAttribute('aria-pressed')).toBe('false');
    expect(five.getAttribute('aria-pressed')).toBe('true');
    expect(five.dataset.press).toBe('none');
    fireEvent.click(one);
    expect(onToggle).toHaveBeenLastCalledWith('1m', true);
    fireEvent.click(five);
    expect(onToggle).toHaveBeenLastCalledWith('5m', false);
    expect(one.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '1h' }).disabled).toBe(true);
    rerender(<ToggleGroup label="Intervals" options={options} value={['1m', '5m']} onToggle={onToggle} disabled />);
    expect(one.getAttribute('aria-pressed')).toBe('true');
    expect(one.disabled).toBe(true);
  });

  it('the scroll area wraps its content in the scrolling view', () => {
    render(
      <ScrollArea className="list" aria-label="Fills">
        <p>Fill 1</p>
      </ScrollArea>,
    );
    const root = screen.getByLabelText('Fills');
    expect(root.className).toBe('t-scrollarea list');
    expect(root.dataset.scroll).toBe('vertical');
    expect(root.querySelector('.t-scrollarea-view')?.textContent).toBe('Fill 1');
  });
});

describe('the right-click menu, the sheet and the popover form', () => {
  it('a right click opens the system menu at the pointer', () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu>
        <ContextMenuTrigger>
          <div>Row</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem shortcut="b" onSelect={onSelect}>
            Buy here
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('Row'), { clientX: 40, clientY: 30 });
    const menu = screen.getByRole('menu');
    expect(menu.className).toContain('t-menu');
    const item = screen.getByRole('menuitem');
    expect(item.className).toBe('t-menu-item');
    expect(item.querySelector('.t-key')).toBeTruthy();
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('the Menu key or ⇧F10 opens the menu of the row the keys reached', () => {
    const onMenu = vi.fn<(row: string) => void>();
    function List() {
      return (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              role="listbox"
              aria-label="Rows"
              tabIndex={0}
              aria-activedescendant="r2"
              onKeyDown={(e) => {
                if (!isContextMenuKey(e)) return;
                e.preventDefault();
                openContextMenuAt(document.getElementById('r2')!);
              }}
            >
              <div id="r1" role="option" aria-selected={false} onContextMenu={() => onMenu('r1')}>
                One
              </div>
              <div id="r2" role="option" aria-selected onContextMenu={() => onMenu('r2')}>
                Two
              </div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Remove</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      );
    }
    expect(isContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
    render(<List />);
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'a' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(list, { key: 'F10', shiftKey: true });
    expect(onMenu).toHaveBeenCalledWith('r2');
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('a trigger focused after a press keeps its tooltip shut; one the keyboard reaches shows it', () => {
    render(
      <Tooltip content="Workspaces">
        <button type="button">Scalp</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Scalp' });
    fireEvent.pointerDown(window);
    act(() => button.focus());
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => button.blur());
    fireEvent.keyDown(window, { key: 'Tab' });
    act(() => button.focus());
    expect(screen.getByRole('tooltip').textContent).toContain('Workspaces');
  });

  it('a sheet is a modal dialog on its edge, with its title, line, close and foot; it needs no tooltip provider', () => {
    const onOpenChange = vi.fn();
    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent title="Account" description="Its rules." side="left" size={480} footer={<button>Save</button>}>
          <p>Body</p>
          <input aria-label="Name" />
        </SheetContent>
      </Sheet>,
    );
    const sheet = screen.getByRole('dialog', { name: 'Account' });
    expect(sheet.className).toBe('t-sheet is-drawer');
    expect(sheet.dataset.side).toBe('left');
    expect(sheet.style.getPropertyValue('--sheet-size')).toBe('480px');
    expect(screen.getByText('Its rules.').className).toBe('t-sheet-note');
    expect(sheet.getAttribute('aria-describedby')).toBe(screen.getByText('Its rules.').id);
    expect(sheet.querySelector('.t-sheet-foot')?.textContent).toBe('Save');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a sheet without a line is described by nothing', () => {
    render(
      <Sheet open>
        <SheetContent title="Account">
          <p>Body</p>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Account' }).hasAttribute('aria-describedby')).toBe(false);
  });

  it('a form row labels its control; a hint or what went wrong sits in its note', () => {
    render(
      <FormSection title="Inputs">
        <FormRow label="Length" htmlFor="len" hint="Bars" layout="fill">
          <input id="len" />
        </FormRow>
        <FormRow label="Bands" error="Too wide.">
          <Switch label="Bands" />
        </FormRow>
        <FormActions start={<button>Reset</button>}>
          <button>Done</button>
        </FormActions>
      </FormSection>,
    );
    expect(screen.getByRole('heading', { name: 'Inputs' }).className).toBe('t-form-title');
    expect(screen.getByLabelText('Length').id).toBe('len');
    const row = screen.getByText('Bars').parentElement!;
    expect(row.dataset.layout).toBe('fill');
    expect(screen.getByRole('alert').textContent).toBe('Too wide.');
    expect(screen.getByRole('alert').parentElement?.className).toBe('t-form-row is-error');
  });
});

describe('a combobox keeps the query to its open', () => {
  it('opens fresh each time', () => {
    render(<Combobox label="Indicators" options={OPTIONS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Indicators' }));
    fireEvent.change(input(), { target: { value: 'rsi' } });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Indicators', hidden: true }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Indicators' }));
    expect((input() as HTMLInputElement).value).toBe('');
  });
});

describe('a combobox in a sheet', () => {
  it('scrolls its list under the wheel: the sheet’s scroll lock does not swallow it', () => {
    render(
      <Sheet open>
        <SheetContent title="Account">
          <Combobox label="Timezone" options={OPTIONS} />
        </SheetContent>
      </Sheet>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Timezone' }));
    const list = screen.getByRole('listbox');
    const viewport = list.closest<HTMLElement>('[data-radix-scroll-area-viewport]') ?? list;
    for (const [k, v] of [
      ['scrollHeight', 464],
      ['clientHeight', 296],
    ] as const)
      Object.defineProperty(viewport, k, { configurable: true, value: v });
    viewport.style.overflowY = 'scroll';
    const wheel = new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true });
    screen.getAllByRole('option')[0]!.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });
});

describe('a combobox that takes typed text', () => {
  const systems: ComboboxOption[] = ['Apex', 'Rithmic Test'].map((v) => ({ value: v, label: v }));
  const typed = (q: string): ComboboxOption => ({ value: q, label: `Use “${q}”` });

  it('offers what is typed after the listed rows, unless a row is named exactly that', () => {
    expect(comboboxRows(systems, '', typed)).toBe(systems);
    expect(comboboxRows(systems, 'apex', typed)).toBe(systems);
    const rows = comboboxRows(systems, 'Apex 2', typed);
    expect(rows.map((r) => r.value)).toEqual(['Apex', 'Rithmic Test', 'Apex 2']);
    expect(comboboxRows(systems, 'Apex 2')).toBe(systems);
  });

  it('takes a typed value with Enter and shows a value no row lists as itself', () => {
    function Harness() {
      const [v, setV] = useState<string | null>(null);
      return <Combobox label="System" options={systems} custom={typed} value={v} onValueChange={setV} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    const search = screen.getByRole('combobox', { name: 'System' });
    fireEvent.change(search, { target: { value: 'My Firm' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'System: My Firm' }).textContent).toBe('My Firm');
  });
});
