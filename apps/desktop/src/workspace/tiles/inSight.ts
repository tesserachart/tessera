import type { DockviewPanelApi } from 'dockview-react';
import { useEffect, useEffectEvent } from 'react';
import { useSight } from '../../app/inSight.ts';

export function useTileSight(
  api: Pick<DockviewPanelApi, 'onDidVisibilityChange' | 'isVisible'>,
  apply: (inSight: boolean) => void,
): void {
  const sight = useSight();
  const run = useEffectEvent(apply);
  useEffect(() => {
    const update = () => run(sight.get() && api.isVisible);
    update();
    const offSight = sight.subscribe(update);
    const sub = api.onDidVisibilityChange(update);
    return () => {
      offSight();
      sub.dispose();
    };
  }, [api, sight]);
}
