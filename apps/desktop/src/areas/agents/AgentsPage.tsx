import { ShownContext } from '@tessera/ui';
import { AnalystWithSessions } from '../../workspace/tiles/AnalystTile.tsx';
import { useArea } from '../store.ts';

export function AgentsPage() {
  const shown = useArea((s) => s.area === 'agents');
  return (
    <div className="ar-page an-page">
      <header className="ar-head" data-tauri-drag-region>
        <h1 className="ar-title">Analyst</h1>
      </header>
      <ShownContext.Provider value={shown}>
        <AnalystWithSessions />
      </ShownContext.Provider>
    </div>
  );
}
