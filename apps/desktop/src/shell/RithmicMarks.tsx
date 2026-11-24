import { cx, Tooltip } from '@tessera/ui';
import { NOTICES_SETTING } from '../accounts/rithmicAttribution.ts';
import { rithmicLive } from '../accounts/connections.ts';
import { useConnections } from '../accounts/useConnections.ts';
import { openSettings } from '../areas/settings/store.ts';
import omneMark from '../assets/rithmic/pbo-grey.svg';
import rithmicMark from '../assets/rithmic/TradingPlatformByRithmic-Gray-HiRes.png';

const RITHMIC_MARKS = [
  { src: rithmicMark, alt: 'Trading Platform by Rithmic', height: 'h-5' },
  { src: omneMark, alt: 'Powered by OMNE', height: 'h-3.5' },
] as const;

const MARKS = 'flex flex-none items-center gap-4 border-l border-line px-3';

function Marks() {
  return RITHMIC_MARKS.map((m) => <img key={m.alt} src={m.src} alt={m.alt} className={cx('block w-auto', m.height)} />);
}

export function RithmicMarks({ opensNotices }: { opensNotices: boolean }) {
  const { rows } = useConnections();
  if (!rithmicLive(rows)) return null;
  if (!opensNotices)
    return (
      <div className={cx(MARKS, 'ml-auto')} role="group" aria-label="Rithmic attribution">
        <Marks />
      </div>
    );
  return (
    <Tooltip content="Rithmic and OMNE notices" side="top">
      <button
        type="button"
        className={cx(MARKS, 'transition-colors duration-(--dur-press) hover:bg-raise focus-visible:bg-raise')}
        onClick={() => openSettings(NOTICES_SETTING)}
      >
        <Marks />
      </button>
    </Tooltip>
  );
}
