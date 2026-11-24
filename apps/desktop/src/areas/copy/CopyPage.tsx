import { CopyPanel } from './CopyPanel.tsx';

export function CopyPage() {
  return (
    <section className="ar-page cp-page" aria-label="Trade copier" data-focus-zone="copy">
      <header className="ar-head" data-tauri-drag-region>
        <h1 className="ar-title">Trade copier</h1>
      </header>
      <CopyPanel />
    </section>
  );
}
