import { Avatar, Tooltip, cx } from '@tessera/ui';
import { useAccount, useAccountsOn } from '../account/account.ts';
import { entryLook } from './profile/model.ts';
import { areaDef } from './registry.ts';
import { showArea, useArea } from './store.ts';

export function ProfileEntry() {
  const on = useAccountsOn() === true;
  const state = useAccount(on);
  const current = useArea((s) => s.area === 'profile');
  if (!on) return null;
  const look = entryLook(state);
  return (
    <Tooltip content={look.words} shortcut={areaDef('profile').shortcut} side="right">
      <button
        type="button"
        className={cx('ar-profile', current && 'is-on', look.initial === null && 'is-empty')}
        aria-label={look.words}
        aria-current={current ? 'page' : undefined}
        data-area="profile"
        onClick={() => showArea('profile')}
      >
        <Avatar initial={look.initial} />
      </button>
    </Tooltip>
  );
}
