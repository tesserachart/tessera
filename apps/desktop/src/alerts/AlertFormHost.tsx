import { Popover, PopoverAnchor, PopoverContent } from '@tessera/ui';
import { useState } from 'react';
import { deleteAlert, pauseAlert, saveAlert } from './actions.ts';
import { AlertFormView } from './AlertForm.tsx';
import { VALUE_KEY } from './form.ts';
import { closeAlertForm, setAlertForm, useAlertForm } from './formStore.ts';
import { useAlerts } from './store.ts';

export function AlertFormHost() {
  const open = useAlertForm();
  const discord = useAlerts((s) => s.discord);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = open?.form.id ?? null;
  const live = useAlerts((s) => (id ? s.alerts?.get(id) : undefined));
  if (!open) return null;
  const at = open.at ?? { x: window.innerWidth / 2, y: 96 };
  const close = () => {
    setError(null);
    closeAlertForm();
  };
  const act = (go: Promise<string | null>, closing: boolean) => {
    setBusy(true);
    setError(null);
    void go.then((why) => {
      setBusy(false);
      if (why) setError(why);
      else if (closing) close();
    });
  };
  const paused = live?.status === 'paused';
  const saved =
    live && (live.status === 'active' || paused)
      ? {
          paused,
          onPause: () => act(pauseAlert(live.id, !paused), false),
          onDelete: () => act(deleteAlert(live.id), true),
        }
      : null;
  return (
    <Popover open onOpenChange={(o) => !o && close()}>
      <PopoverAnchor asChild>
        <span className="al-anchor" style={{ left: at.x, top: at.y }} aria-hidden="true" />
      </PopoverAnchor>
      <PopoverContent
        className="al-pop"
        side="bottom"
        align={open.at ? 'start' : 'center'}
        sideOffset={4}
        onFocusOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => {
          if (open.form.id === null && open.form.target === VALUE_KEY) e.preventDefault();
        }}
      >
        <AlertFormView
          form={open.form}
          price={open.price}
          discord={discord}
          busy={busy}
          error={error}
          saved={saved}
          onChange={(f) => {
            setError(null);
            setAlertForm(() => f);
          }}
          onCancel={close}
          onSubmit={() => {
            setBusy(true);
            void saveAlert(open.form, Date.now()).then((why) => {
              setBusy(false);
              if (why) setError(why);
              else close();
            });
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
