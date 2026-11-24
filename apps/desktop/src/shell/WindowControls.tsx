import { IconButton, cx } from '@tessera/ui';
import { runControl, useWindowControls } from '../app/host.ts';

export function WindowControls({ className }: { className?: string }) {
  const controls = useWindowControls();
  if (!controls || controls.trafficLights) return null;
  return (
    <div className={cx('window-controls', className)}>
      <IconButton
        label="Minimise"
        icon="minimise"
        className="w-hit h-tab *:[--icon:16px]"
        onClick={() => runControl(controls.minimize)}
      />
      <IconButton
        label="Maximise"
        icon="maximise"
        className="w-hit h-tab *:[--icon:16px]"
        onClick={() => runControl(controls.toggleMaximize)}
      />
      <IconButton
        label="Close"
        icon="close"
        className="w-hit h-tab *:[--icon:16px]"
        onClick={() => runControl(controls.close)}
      />
    </div>
  );
}
