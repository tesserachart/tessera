import { Button, STRONG_TEXT, cx } from '@tessera/ui';
import { openPalette } from '../../state/ui.ts';

export function NoChartOpen() {
  return (
    <section
      className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-ink px-pad text-center"
      aria-label="No chart open"
    >
      <h2 className={cx(STRONG_TEXT, 'm-0')}>No chart open</h2>
      <Button size="s" variant="secondary" className="mt-3" onClick={() => openPalette('')}>
        Open a chart
      </Button>
    </section>
  );
}
