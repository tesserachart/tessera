import { Button, SettingsRow, Switch, TextInput, formatShortcut, usePlatform } from '@tessera/ui';
import { useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { takenKeys, useOrderHotkeys } from '../../../chart/ticket/commands.ts';
import { commands } from '../../../commands/registry.ts';
import {
  ORDER_HOTKEYS,
  ORDER_KEYS,
  canonical,
  keyConflicts,
  orderHotkeysValue,
  shortcutOfEvent,
  type OrderKeyAction,
} from '../../../shell/orderHotkeys.ts';
import { useSettingSave } from '../../../state/runtimeSettings.ts';
import { Row, Section } from '../parts.tsx';

export function OrderHotkeys() {
  const h = useOrderHotkeys();
  const platform = usePlatform();
  useSyncExternalStore(commands.subscribe, commands.getVersion);
  const taken = takenKeys(commands.all());
  const stored = keyConflicts(h.keys, taken, platform);
  const { save, error: failed, clear } = useSettingSave(ORDER_HOTKEYS);
  const [refused, setRefused] = useState<{ action: OrderKeyAction; why: string } | null>(null);
  const record = (action: OrderKeyAction, key: string) => {
    const keys = { ...h.keys, [action]: key };
    const why = keyConflicts(keys, taken, platform)[action];
    if (why) {
      setRefused({ action, why: `${formatShortcut(key, platform)}: ${why}` });
      return;
    }
    setRefused(null);
    clear();
    if (canonical(key, platform) !== canonical(h.keys[action], platform)) void save(orderHotkeysValue({ ...h, keys }));
  };
  return (
    <Section id="trading.orderHotkeys">
      <Row id="trading.orderHotkeysOn" error={failed}>
        <Switch label="Order hotkeys" checked={h.enabled} onCheckedChange={(on) => void save({ enabled: on })} />
      </Row>
      {ORDER_KEYS.map((d) => {
        const key = h.keys[d.action];
        const moved = canonical(key, platform) !== canonical(d.key, platform);
        return (
          <SettingsRow
            key={d.action}
            className="st-order-key"
            data-setting={`trading.orderKey.${d.action}`}
            label={d.label}
            help={d.help}
            error={refused?.action === d.action ? refused.why : (stored[d.action] ?? null)}
          >
            {moved ? (
              <Button variant="quiet" size="s" onClick={() => record(d.action, d.key)}>
                Default
              </Button>
            ) : null}
            <KeyBox
              label={`${d.label} key`}
              shortcut={key}
              onKey={(k) => record(d.action, k)}
              onLeave={() => setRefused((r) => (r?.action === d.action ? null : r))}
            />
          </SettingsRow>
        );
      })}
    </Section>
  );
}

function KeyBox({
  label,
  shortcut,
  onKey,
  onLeave,
}: {
  label: string;
  shortcut: string;
  onKey: (shortcut: string) => void;
  onLeave: () => void;
}) {
  const platform = usePlatform();
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey;
    if (e.key === 'Tab' && plain) return;
    e.preventDefault();
    if (e.key === 'Escape' && plain && !e.shiftKey) {
      e.currentTarget.blur();
      return;
    }
    const k = shortcutOfEvent(e, platform);
    if (k) onKey(k);
  };
  return (
    <TextInput
      size="s"
      className="st-key-box"
      readOnly
      aria-label={label}
      value={formatShortcut(shortcut, platform)}
      onKeyDown={onKeyDown}
      onBlur={onLeave}
    />
  );
}
