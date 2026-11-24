import type { ChartLayer } from '@tessera/protocol';
import {
  FormRow,
  FormSection,
  ICON_BUTTON,
  Icon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Segmented,
  Select,
  Tooltip,
  cx,
} from '@tessera/ui';
import { forwardRef } from 'react';
import {
  PROFILE_ROW_SIZES,
  PROFILE_SHOWS,
  PROFILE_VALUE_AREAS,
  profileQuick,
  removeProfile,
  selectProfile,
  setProfileInputs,
  type PlacedProfileRef,
} from './profileStudy.ts';

function ProfileControl({ target, layer }: { target: PlacedProfileRef; layer: ChartLayer }) {
  const q = profileQuick(layer);
  const vas = [...new Set([...PROFILE_VALUE_AREAS, q.valueArea])].sort((a, b) => a - b);
  return (
    <Popover>
      <Tooltip content="Profile">
        <PopoverTrigger asChild>
          <button type="button" className={cx(ICON_BUTTON, 'w-7 h-7')} aria-label="Profile settings">
            <Icon name="profile-range" className="text-inherit" />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent className="dsb-profile" side="bottom" align="center" aria-label="Profile settings">
        <FormSection>
          <FormRow label="Show">
            <Segmented
              label="Show"
              options={PROFILE_SHOWS}
              value={q.show}
              onChange={(show) => setProfileInputs(target, { show })}
            />
          </FormRow>
          <FormRow label="Value area" htmlFor="psb-va">
            <Select
              id="psb-va"
              size="s"
              value={String(q.valueArea)}
              options={vas.map((v) => ({ value: String(v), label: `${String(v)}%` }))}
              onValueChange={(v) => setProfileInputs(target, { valueArea: Number(v) })}
            />
          </FormRow>
          <FormRow label="Row size" htmlFor="psb-rows">
            <Select
              id="psb-rows"
              size="s"
              value={q.rowTicks}
              options={PROFILE_ROW_SIZES}
              onValueChange={(rowTicks) => setProfileInputs(target, { rowTicks })}
            />
          </FormRow>
        </FormSection>
      </PopoverContent>
    </Popover>
  );
}

export const ProfileStudyBar = forwardRef<HTMLDivElement, { target: PlacedProfileRef; layer: ChartLayer }>(
  function ProfileStudyBar({ target, layer }, ref) {
    return (
      <div
        ref={ref}
        className="dsb"
        role="toolbar"
        aria-label="Volume profile style"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            removeProfile(target);
          } else if (e.key === 'Escape') {
            selectProfile(null);
          }
          e.stopPropagation();
        }}
      >
        <ProfileControl target={target} layer={layer} />
        <Tooltip content="Remove" shortcut="backspace">
          <button
            type="button"
            className={cx(ICON_BUTTON, 'w-7 h-7')}
            aria-label="Remove volume profile"
            onClick={() => removeProfile(target)}
          >
            <Icon name="trash" className="text-inherit" />
          </button>
        </Tooltip>
      </div>
    );
  },
);
