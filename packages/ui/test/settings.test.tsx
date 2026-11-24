import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfirmButton,
  RailItem,
  SearchField,
  SecretMask,
  SettingsNavItem,
  SettingsRow,
  SettingsSection,
} from '../src/index.ts';

afterEach(cleanup);

describe('the settings grammar', () => {
  it('a section is its title and line over a card of rows; with no rows, its head alone', () => {
    const { container, rerender } = render(
      <SettingsSection title="New charts" description="What a new chart starts with." data-setting="s">
        <SettingsRow label="Interval" help="Of new charts">
          <button type="button">5m</button>
        </SettingsRow>
      </SettingsSection>,
    );
    expect(screen.getByRole('heading', { name: 'New charts' })).toBeTruthy();
    const row = container.querySelector('.t-set-card > .t-set-row')!;
    expect(row.querySelector('.lab .t')?.textContent).toBe('Interval');
    expect(row.querySelector('.lab .help')?.textContent).toBe('Of new charts');
    expect(row.querySelector('.val button')?.textContent).toBe('5m');
    rerender(<SettingsSection title="Stored">{[]}</SettingsSection>);
    expect(container.querySelector('.t-set-card')).toBeNull();
    rerender(
      <SettingsRow label="Symbol" help="Typed, then Enter" error="No symbol ZZZ">
        <input aria-label="Symbol" />
      </SettingsRow>,
    );
    expect(screen.getByRole('alert').textContent).toBe('No symbol ZZZ');
    expect(container.querySelector('.help')).toBeNull();
  });

  it('a rail item and a category say their name, and the one shown is the current page', () => {
    render(
      <>
        <RailItem icon="settings" label="Settings" current />
        <SettingsNavItem icon="accounts" label="Connections" />
      </>,
    );
    const rail = screen.getByRole('button', { name: 'Settings' });
    expect(rail.getAttribute('aria-current')).toBe('page');
    expect(rail.classList.contains('is-on')).toBe(true);
    expect(screen.getByRole('button', { name: 'Connections' }).getAttribute('aria-current')).toBeNull();
  });

  it('the search line clears on its first Esc and leaves on the next', () => {
    function Harness() {
      const [q, setQ] = useState('density');
      return <SearchField label="Search settings" value={q} onValueChange={setQ} />;
    }
    render(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search settings' });
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(document.activeElement).not.toBe(input);
  });

  it('a destructive action asks once, inline: Keep puts it back, the verb does it', () => {
    const remove = vi.fn();
    render(
      <ConfirmButton what="Apex · Rithmic" question="Log it out and delete its saved login?" onConfirm={remove}>
        Remove
      </ConfirmButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('group', { name: 'Confirm' }).textContent).toContain('Log it out');
    expect(document.activeElement?.textContent).toBe('Keep');
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.keyDown(screen.getByRole('group', { name: 'Confirm' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Confirm' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: /Remove.*Apex/ }));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('a blocked action stays focusable, says why, and does not ask', () => {
    const remove = vi.fn();
    render(
      <>
        <ConfirmButton question="Delete 2 trades?" describedBy="why" blocked onConfirm={remove}>
          Delete
        </ConfirmButton>
        <span id="why">From the connection. Synced trades can’t be deleted.</span>
      </>,
    );
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Delete' });
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-describedby')).toBe('why');
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(screen.queryByRole('group', { name: 'Confirm' })).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it('a stored secret is never its value', () => {
    render(<SecretMask />);
    expect(screen.getByRole('img', { name: 'Hidden' }).textContent).toBe('••••••••');
  });
});
