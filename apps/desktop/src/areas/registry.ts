import type { IconName } from '@tessera/ui';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { AreaId } from './store.ts';

export interface AreaDef {
  id: AreaId;
  label: string;
  icon: IconName;
  shortcut: string;
  keywords: string[];
  page: LazyExoticComponent<ComponentType> | null;
  tile?: string;
  foot?: boolean;
  accounts?: boolean;
  private?: boolean;
}

export const AREAS: readonly AreaDef[] = [
  {
    id: 'desk',
    label: 'Desk',
    icon: 'desk',
    shortcut: 'alt+1',
    keywords: ['charts', 'trade', 'workspace'],
    page: null,
  },
  {
    id: 'markets',
    label: 'Markets',
    icon: 'markets',
    shortcut: 'alt+2',
    keywords: ['watchlist', 'symbols', 'instruments', 'futures', 'contracts', 'quotes', 'movers'],
    page: lazy(() => import('./markets/MarketsPage.tsx').then((m) => ({ default: m.MarketsPage }))),
  },
  {
    id: 'agents',
    label: 'Analyst',
    icon: 'analyst',
    shortcut: 'alt+3',
    keywords: ['agents', 'claude', 'codex', 'chat', 'ai'],
    page: lazy(() => import('./agents/AgentsPage.tsx').then((m) => ({ default: m.AgentsPage }))),
    tile: 'analyst',
  },
  {
    id: 'indicators',
    label: 'Indicators',
    icon: 'indicators',
    shortcut: 'alt+4',
    keywords: ['studies', 'custom indicator', 'javascript', 'script'],
    page: lazy(() => import('./indicators/IndicatorsPage.tsx').then((m) => ({ default: m.IndicatorsPage }))),
    tile: 'indicators',
  },
  {
    id: 'research',
    label: 'Research',
    icon: 'research',
    shortcut: 'alt+5',
    keywords: ['backtest', 'strategy', 'hypothesis', 'study'],
    page: lazy(() => import('./research/ResearchPage.tsx').then((m) => ({ default: m.ResearchPage }))),
    private: true,
  },
  {
    id: 'journal',
    label: 'Journal',
    icon: 'journal',
    shortcut: 'alt+6',
    keywords: ['trades', 'review', 'log', 'traderlog'],
    page: lazy(() => import('./journal/JournalPage.tsx').then((m) => ({ default: m.JournalPage }))),
    tile: 'journal',
    private: true,
  },
  {
    id: 'copy',
    label: 'Trade copier',
    icon: 'copier',
    shortcut: 'alt+9',
    keywords: ['copy groups', 'copier', 'leader', 'follower', 'mirror', 'sync', 'accounts'],
    page: lazy(() => import('./copy/CopyPage.tsx').then((m) => ({ default: m.CopyPage }))),
    tile: 'copy',
    private: true,
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'settings',
    shortcut: 'alt+7',
    keywords: ['preferences', 'options', 'connections', 'passwords', 'keys', 'shortcuts'],
    page: lazy(() => import('./settings/SettingsPage.tsx').then((m) => ({ default: m.SettingsPage }))),
    foot: true,
  },
  {
    id: 'profile',
    label: 'Profile',
    icon: 'you',
    shortcut: 'alt+8',
    keywords: [
      'account',
      'tessera account',
      'me',
      'sign in',
      'sign out',
      'log in',
      'log out',
      'email',
      'alpha',
      'access',
      'waitlist',
    ],
    page: lazy(() => import('./profile/ProfilePage.tsx').then((m) => ({ default: m.ProfilePage }))),
    foot: true,
    accounts: true,
    private: true,
  },
];

export function areaDef(id: AreaId): AreaDef {
  return AREAS.find((a) => a.id === id) ?? AREAS[0]!;
}

export function preloadAreas(): void {
  void import('./markets/MarketsPage.tsx');
  void import('./agents/AgentsPage.tsx');
  void import('./indicators/IndicatorsPage.tsx');
  void import('./research/ResearchPage.tsx');
  void import('./journal/JournalPage.tsx');
  void import('./copy/CopyPage.tsx');
  void import('./settings/SettingsPage.tsx');
  void import('./profile/ProfilePage.tsx');
}
