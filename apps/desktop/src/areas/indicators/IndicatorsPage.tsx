import { IndicatorsPanel } from './IndicatorsPanel.tsx';

export function IndicatorsPage() {
  return (
    <div className="ar-page">
      <header className="ar-head" data-tauri-drag-region>
        <h1 className="ar-title">Indicators</h1>
      </header>
      <IndicatorsPanel />
    </div>
  );
}
