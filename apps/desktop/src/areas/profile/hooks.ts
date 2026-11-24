import { useEffect, useState } from 'react';
import { useAccountsOn } from '../../account/account.ts';
import { failureText } from '../../app/tools.ts';
import { areaCommand } from '../../commands/builtin.ts';
import { commands } from '../../commands/registry.ts';
import { areaDef } from '../registry.ts';
import { showArea, useArea } from '../store.ts';

export function useProfileCommand(): void {
  const on = useAccountsOn() === true;
  useEffect(() => (on ? commands.register(areaCommand(areaDef('profile'))) : undefined), [on]);
}

export function useNoProfileWithoutAccounts(): void {
  const on = useAccountsOn();
  const shown = useArea((s) => s.area === 'profile');
  useEffect(() => {
    if (on === false && shown) showArea('desk');
  }, [on, shown]);
}

export type AccountAction = 'sign-in' | 'check' | 'sign-out';

export function useAccountAction(): {
  busy: boolean;
  failed: { action: AccountAction; text: string } | null;
  run: (action: AccountAction, act: () => Promise<void>) => void;
} {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ action: AccountAction; text: string } | null>(null);
  const run = (action: AccountAction, act: () => Promise<void>) => {
    setBusy(true);
    setFailed(null);
    void act()
      .catch((e: unknown) => setFailed({ action, text: failureText(e) }))
      .finally(() => setBusy(false));
  };
  return { busy, failed, run };
}
