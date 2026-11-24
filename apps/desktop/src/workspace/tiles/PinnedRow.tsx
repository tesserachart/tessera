import { Button, FormRow, FormSection } from '@tessera/ui';
import { displaySymbol } from '../../market/instruments.ts';

export function PinnedRow({ instrument, onFollow }: { instrument: string | null; onFollow: () => void }) {
  if (!instrument) return null;
  return (
    <FormSection aria-label="Symbol">
      <FormRow label={`Pinned to ${displaySymbol(instrument)}`} hint="A chart’s symbol change leaves it">
        <Button variant="quiet" size="s" onClick={onFollow}>
          Follow the chart
        </Button>
      </FormRow>
    </FormSection>
  );
}
