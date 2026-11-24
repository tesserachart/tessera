import { area, settingsPage, type Screen } from './screen.ts';

const SETTINGS = ['Connections', 'Trading and risk', 'Chart', 'Levels', 'Alerts and sounds', 'Analyst', 'App'];

export const screens: Screen[] = [
  { name: 'desk', open: async () => {} },
  { name: 'chart-nq', open: async () => {}, target: (page) => page.getByRole('region', { name: 'NQ Z6 5m' }) },
  { name: 'chart-es', open: async () => {}, target: (page) => page.getByRole('region', { name: 'ES Z6 1m' }) },
  ...SETTINGS.map((label) => ({ name: `settings-${label.toLowerCase().replaceAll(' ', '-')}`, open: settingsPage(label) })),
  { name: 'settings-data', open: settingsPage('Data'), live: /^[\d.,]+( (B|KB|MB|GB)( in all)?)?$/ },
  { name: 'markets', open: area('Markets') },
  { name: 'analyst', open: area('Analyst') },
  { name: 'indicators', open: area('Indicators') },
  { name: 'research', open: area('Research') },
  { name: 'journal', open: area('Journal') },
  { name: 'trade-copier', open: area('Trade copier') },
];
