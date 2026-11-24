import type { SessionMode } from '@tessera/protocol';
import { Icon, Menu, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger, Tooltip } from '@tessera/ui';
import { useModeChange } from '../../analyst/modeChange.tsx';
import { MODES, isMode, modeInfo } from '../../analyst/modes.ts';

export function ModePicker({
  mode,
  onMode,
  disabled = false,
}: {
  mode: SessionMode;
  onMode: (mode: SessionMode) => void;
  disabled?: boolean;
}) {
  const { request, dialog } = useModeChange(mode, onMode);
  const info = modeInfo(mode);
  const word = info.label;
  return (
    <>
      <Menu>
        <Tooltip
          content={
            <>
              {word} <span className="w">{info.hint}</span>
            </>
          }
          side="top"
        >
          <MenuTrigger asChild disabled={disabled}>
            <button type="button" className="ag-ctl ag-mode" aria-label={`Mode: ${word}`}>
              <Icon name={info.icon} className="alt" />
              <span className="tt">{word}</span>
              <Icon name="chevron-down" className="cv" />
            </button>
          </MenuTrigger>
        </Tooltip>
        <MenuContent side="top" align="start" sideOffset={8} style={{ minWidth: 300 }}>
          <MenuLabel>Mode</MenuLabel>
          <MenuRadioGroup
            value={mode}
            onValueChange={(v) => {
              if (isMode(v)) request(v);
            }}
          >
            {MODES.map((m) => (
              <MenuRadioItem key={m.value} value={m.value} detail={m.hint}>
                {m.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      {dialog}
    </>
  );
}
