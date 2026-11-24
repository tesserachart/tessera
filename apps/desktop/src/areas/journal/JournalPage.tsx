import type { ReactNode } from 'react';
import type { JournalAccount } from '@tessera/protocol';
import { Button, IconButton, Loaded, Segmented, Select, Tooltip } from '@tessera/ui';
import { useHasTool, useTools, valueOf } from '../../app/tools.ts';
import { askAboutPeriod } from './actions.ts';
import { useCatalog, useJournalLive, useScopedFilter, useStats } from './data.ts';
import { RANGES, type RangeKey } from './model/scope.ts';
import { Analytics, AnalyticsSample } from './sections/Analytics.tsx';
import { Dashboard, DashboardSample } from './sections/Dashboard.tsx';
import { Days, DaysSample } from './sections/Days.tsx';
import { Import } from './sections/Import.tsx';
import { Playbooks, PlaybooksSample } from './sections/Playbooks.tsx';
import { Settings } from './sections/Settings.tsx';
import { Trades, TradesSample } from './sections/Trades.tsx';
import { setAccount, setJournal, setRange, useJournalUi, type JournalSection } from './store.ts';
import './journal.css';
import './kit/kit.css';

const SECTIONS: readonly { value: JournalSection; label: string }[] = [
  { value: 'overview', label: 'Dashboard' },
  { value: 'trades', label: 'Trades' },
  { value: 'days', label: 'Days' },
  { value: 'reports', label: 'Analytics' },
  { value: 'playbooks', label: 'Playbooks' },
  { value: 'import', label: 'Import' },
];

export function JournalPage() {
  useJournalLive();
  const section = useJournalUi((s) => s.section);
  return (
    <section className="ar-page jr-page" aria-label="Journal">
      <header className="ar-head jr-pagehead" data-tauri-drag-region>
        <h1 className="ar-title">Journal</h1>
        <Segmented<JournalSection>
          label="Section"
          className="jr-nav"
          value={section === 'settings' ? null : section}
          onChange={(v) => setJournal(v === 'trades' ? { section: v, trade: null } : { section: v })}
          options={SECTIONS}
        />
        <ScopeControls />
      </header>
      <div className="jr-body">
        <Loaded label="Loading the journal" sample={SECTION_SAMPLES[section]}>
          <JournalSectionPage section={section} />
        </Loaded>
      </div>
    </section>
  );
}

const SECTION_SAMPLES: Partial<Record<JournalSection, ReactNode>> = {
  overview: <DashboardSample />,
  trades: <TradesSample />,
  days: <DaysSample />,
  reports: <AnalyticsSample />,
  playbooks: <PlaybooksSample />,
};

function JournalSectionPage({ section }: { section: JournalSection }) {
  const has = useHasTool('journal.get_catalog');
  if (!has)
    return (
      <div className="t-blank">
        <p>This runtime has no journal yet.</p>
      </div>
    );
  switch (section) {
    case 'overview':
      return <Dashboard />;
    case 'trades':
      return <Trades />;
    case 'days':
      return <Days />;
    case 'reports':
      return <Analytics />;
    case 'playbooks':
      return <Playbooks />;
    case 'import':
      return <Import />;
    case 'settings':
      return <Settings />;
  }
}

function AccountPicker({ accounts, scope }: { accounts: readonly JournalAccount[]; scope: string }) {
  return (
    <Select
      size="s"
      variant="quiet"
      label="Account"
      value={accounts.some((a) => a.id === scope) ? scope : 'all'}
      onValueChange={setAccount}
      options={[
        { value: 'all', label: 'Every account' },
        ...accounts.map((a) => ({ value: a.id, label: a.name, hint: String(a.trades) })),
      ]}
    />
  );
}

export function ScopeControls() {
  const scope = useJournalUi((s) => s.scope);
  const section = useJournalUi((s) => s.section);
  const tools = useTools();
  const catalog = useCatalog();
  const cat = valueOf(catalog);
  const withFilter = section === 'trades' || section === 'reports';
  const filter = useScopedFilter(withFilter);
  const statsRead = useStats(filter, true);
  const stats = valueOf(statsRead);
  const accounts = cat?.accounts ?? [];
  const range = RANGES.find((r) => r.value === scope.range)?.label ?? '';
  const account = accounts.find((a) => a.id === scope.account)?.name;
  const scoped = section !== 'days' && section !== 'import' && section !== 'settings';
  return (
    <div className="jr-scope">
      {scoped ? (
        <>
          <Loaded
            label="Loading the journal accounts"
            sample={<AccountPicker accounts={[]} scope="all" />}
            pending={
              !tools ||
              (tools.has('journal.get_catalog') && catalog.isPending) ||
              (tools.has('journal.get_stats') && statsRead.isPending)
            }
          >
            <AccountPicker accounts={accounts} scope={scope.account} />
          </Loaded>
          {section !== 'overview' ? (
            <Segmented<RangeKey> label="Range" value={scope.range} onChange={setRange} options={RANGES} />
          ) : null}
          <Button
            size="s"
            className="text-aqua"
            onClick={() =>
              askAboutPeriod(`${account ?? 'every account'}, ${range.toLowerCase()}`, filter, stats ?? null)
            }
          >
            Ask the analyst
          </Button>
        </>
      ) : null}
      <Tooltip content="Tags, checklist, sessions">
        <IconButton
          label="Journal settings"
          icon="settings"
          active={section === 'settings'}
          onClick={() => setJournal({ section: section === 'settings' ? 'overview' : 'settings' })}
        />
      </Tooltip>
    </div>
  );
}
