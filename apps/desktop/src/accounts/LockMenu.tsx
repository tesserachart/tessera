import type { AccountUpdate } from '@tessera/protocol';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  TextInput,
} from '@tessera/ui';
import { useState } from 'react';
import {
  lockChipWords,
  lockMenu,
  lockTrading,
  refusal,
  unlockAccount,
  unlockTyped,
  useLockState,
  UNLOCK_WORD,
} from './lock.ts';

interface LockMenuProps {
  update: AccountUpdate;
  instrument: string | null;
  onUnlock: () => void;
}

export function LockOptions({ update, instrument, onUnlock }: LockMenuProps) {
  const state = useLockState(update.account.id, instrument);
  const groups = state ? lockMenu(state, state.asOf) : null;
  const rows = groups ? [groups.quick, groups.day, groups.sessions] : [];
  return (
    <>
      <MenuLabel>{lockChipWords(update) ? 'Lock longer' : 'No new entries for'}</MenuLabel>
      {rows.map((group, i) => (
        <div key={i} role="group">
          {i > 0 ? <MenuSeparator /> : null}
          {group.map((r) => (
            <MenuItem
              key={r.key}
              disabled={r.why !== null}
              why={r.why ?? undefined}
              hint={r.until ? `to ${r.until}` : undefined}
              onSelect={() => lockTrading(update.account, r.span, instrument)}
            >
              {r.label}
            </MenuItem>
          ))}
        </div>
      ))}
      {state?.lock?.liftable ? (
        <>
          <MenuSeparator />
          <MenuItem onSelect={onUnlock}>Unlock early…</MenuItem>
        </>
      ) : null}
    </>
  );
}

export function LockTradingMenu(props: LockMenuProps) {
  const chip = lockChipWords(props.update);
  return (
    <MenuSub>
      <MenuSubTrigger icon="lock" hint={chip ?? undefined}>
        {chip ? 'Trading locked' : 'Lock trading'}
      </MenuSubTrigger>
      <MenuSubContent className="lk-pop" aria-label="Lock trading">
        <LockOptions {...props} />
      </MenuSubContent>
    </MenuSub>
  );
}

export function UnlockDialog({
  update,
  open,
  onOpenChange,
}: {
  update: AccountUpdate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [typed, setTyped] = useState('');
  const [why, setWhy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = (next: boolean) => {
    if (!next) {
      setTyped('');
      setWhy(null);
    }
    onOpenChange(next);
  };
  const lift = () => {
    setBusy(true);
    unlockAccount(update.account.id, typed)
      .then(
        () => close(false),
        (err: unknown) => setWhy(refusal(err)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="lk-unlock"
        title={`Unlock ${update.account.displayName} early?`}
        description={update.limits?.lockedWhy ?? undefined}
      >
        <form
          className="ui-dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (unlockTyped(typed) && !busy) lift();
          }}
        >
          <Field label={`Type ${UNLOCK_WORD} to take new entries again`} error={why ?? undefined} htmlFor="lk-word">
            <TextInput
              id="lk-word"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </Field>
          <div className="ui-confirm-actions">
            <DialogClose asChild>
              <Button autoFocus>Keep the lock</Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={!unlockTyped(typed) || busy}>
              Unlock
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
