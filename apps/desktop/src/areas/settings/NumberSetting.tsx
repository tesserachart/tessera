import type { SettingInfo } from '@tessera/protocol';
import { TextInput } from '@tessera/ui';
import { useState, type KeyboardEvent } from 'react';
import { useRuntimeSetting, useSetSetting } from '../../state/runtimeSettings.ts';

export function NumberSetting({ info, unit, label }: { info: SettingInfo; unit?: string; label?: string }) {
  const set = useSetSetting();
  const live = useRuntimeSetting(info.key);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const raw = live ?? info.value;
  const value = typeof raw === 'number' ? raw : Number(raw);
  const commit = async () => {
    if (text === null) return;
    const n = Number(text.replace(/,/g, ''));
    if (!Number.isFinite(n) || n === value) {
      setText(null);
      setErr(null);
      return;
    }
    setErr(await set(info.key, n));
    setText(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setText(null);
      setErr(null);
    }
  };
  return (
    <span className="st-num">
      <TextInput
        inputMode="decimal"
        aria-label={label ?? info.description}
        unit={unit}
        className={err ? 'is-invalid' : undefined}
        value={text ?? (Number.isFinite(value) ? String(value) : '')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void commit()}
      />
      {err ? (
        <span className="st-err" role="alert">
          {err}
        </span>
      ) : null}
    </span>
  );
}
