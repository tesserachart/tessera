import type { ChartApi } from '@tessera/chart';
import type { ChartLayer } from '@tessera/protocol';
import { useMemo } from 'react';
import { AddIndicatorDialog } from './AddIndicatorDialog.tsx';
import { IndicatorLegend } from './IndicatorLegend.tsx';

export function ChartIndicators(props: {
  chart: ChartApi | null;
  layoutId: string;
  tileId: string;
  layers: readonly ChartLayer[];
  precision: number;
}) {
  const { layoutId, tileId } = props;
  const ref = useMemo(() => ({ layoutId, tileId }), [layoutId, tileId]);
  return (
    <>
      <IndicatorLegend {...props} />
      <AddIndicatorDialog chart={ref} layers={props.layers} />
    </>
  );
}
