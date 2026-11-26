import { cx } from '@tessera/ui';
import { scaleLinear } from '@visx/scale';
import { LinePath } from '@visx/shape';
import { cumsum } from '@visx/vendor/d3-array';

export function Spark({
  values,
  width = 96,
  height = 24,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const path = [0, ...cumsum(values)];
  const end = path[path.length - 1] ?? 0;
  const lo = Math.min(...path);
  const hi = Math.max(...path);
  const x = scaleLinear<number>({ domain: [0, path.length - 1], range: [1, width - 1] });
  const y = scaleLinear<number>({ domain: [lo, hi === lo ? lo + 1 : hi], range: [height - 2, 2] });
  return (
    <svg width={width} height={height} aria-hidden="true" className="gr-spark">
      <line x1={0} x2={width} y1={y(0)} y2={y(0)} className="gr-zero" />
      <LinePath data={path} x={(_, i) => x(i)} y={(v) => y(v)} className={cx('gr-line', end >= 0 ? 'up' : 'down')} />
    </svg>
  );
}
