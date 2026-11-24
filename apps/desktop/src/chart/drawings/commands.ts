import type { Command } from '../../commands/registry.ts';
import { activeChartTarget } from '../../workspace/controller.ts';
import { layoutsStore } from '../../state/layouts.ts';
import { canRedoDrawings, canUndoDrawings, redoDrawings, removeAllDrawings, undoDrawings } from './actions.ts';
import { TOOLS } from './model.ts';
import { drawingStore, setTool } from './store.ts';
import { read } from '../../app/store.ts';

export function drawingCommands(): Command[] {
  const target = () => activeChartTarget();
  const hasChart = () => target() !== null;
  return [
    ...TOOLS.map((t): Command => ({
      id: `chart.draw.${t.kind}`,
      title: `Draw: ${t.label}`,
      group: 'Chart',
      keywords: ['drawing', 'draw', 'tool', t.label.toLowerCase()],
      ...(t.shortcut ? { shortcut: t.shortcut } : {}),
      zone: 'chart',
      when: hasChart,
      run: () => {
        setTool(read(drawingStore).tool === t.kind ? null : t.kind);
      },
    })),
    {
      id: 'chart.drawings.undo',
      title: 'Undo drawing edit',
      group: 'Chart',
      keywords: ['drawing', 'undo'],
      shortcut: 'mod+z',
      zone: 'chart',
      when: () => {
        const r = target();
        return r !== null && canUndoDrawings(r);
      },
      run: () => {
        const r = target();
        if (r) undoDrawings(r);
      },
    },
    {
      id: 'chart.drawings.redo',
      title: 'Redo drawing edit',
      group: 'Chart',
      keywords: ['drawing', 'redo'],
      shortcut: 'mod+shift+z',
      zone: 'chart',
      when: () => {
        const r = target();
        return r !== null && canRedoDrawings(r);
      },
      run: () => {
        const r = target();
        if (r) redoDrawings(r);
      },
    },
    {
      id: 'chart.drawings.removeAll',
      title: 'Remove all drawings',
      group: 'Chart',
      keywords: ['drawing', 'clear', 'delete', 'lines'],
      when: hasChart,
      run: () => {
        const r = target();
        const chart = r ? read(layoutsStore).layouts[r.layoutId]?.charts[r.tileId] : undefined;
        if (r && chart) removeAllDrawings(r, chart.instrument);
      },
    },
  ];
}
