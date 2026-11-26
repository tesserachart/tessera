import { normalizeQuery, rankOptions, scoreOption, type IconName } from '@tessera/ui';
import { NOTICES_SETTING } from '../../accounts/rithmicAttribution.ts';

export const SETTINGS_CATEGORIES = [
  'connections',
  'trading',
  'chart',
  'levels',
  'alerts',
  'analyst',
  'data',
  'appearance',
  'app',
] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

function isSettingsCategory(v: unknown): v is SettingsCategory {
  return typeof v === 'string' && (SETTINGS_CATEGORIES as readonly string[]).includes(v);
}

export interface CategoryDef {
  id: SettingsCategory;
  label: string;
  icon: IconName;
  about: string;
  keywords: readonly string[];
}

export const CATEGORIES: readonly CategoryDef[] = [
  {
    id: 'connections',
    label: 'Connections',
    icon: 'accounts',
    about: 'Your broker and data logins, your levels providers, and where each exchange’s data and orders go.',
    keywords: [
      'rithmic',
      'tradovate',
      'projectx',
      'topstepx',
      'broker',
      'data feed',
      'login',
      'password',
      'api key',
      'keys',
      'credentials',
      'secrets',
      'prop firm',
      'apex',
      'connect',
      'disconnect',
    ],
  },
  {
    id: 'trading',
    label: 'Trading and risk',
    icon: 'risk',
    about: 'Your accounts, your limits, order hotkeys, brackets, drafts and paper trading.',
    keywords: [
      'orders',
      'risk',
      'limits',
      'dll',
      'daily loss limit',
      'oco',
      'bracket',
      'hotkeys',
      'commission',
      'paper',
      'drafts',
      'approvals',
    ],
  },
  {
    id: 'chart',
    label: 'Chart',
    icon: 'chart',
    about: 'What new charts start with, colours and text, drawing tools, templates and indicators.',
    keywords: ['defaults', 'symbol', 'interval', 'theme', 'colours', 'colors', 'drawings', 'templates', 'indicators'],
  },
  {
    id: 'levels',
    label: 'Levels',
    icon: 'levels',
    about: 'The levels every chart draws, by provider, and their history.',
    keywords: ['gamma', 'walls', 'level settings', 'prior day', 'initial balance', 'history', 'import'],
  },
  {
    id: 'alerts',
    label: 'Alerts and sounds',
    icon: 'alert',
    about: 'The voice and sounds Tessera plays, and where your alerts go.',
    keywords: ['sounds', 'voice', 'audio', 'beep', 'notifications', 'alerts', 'discord', 'push'],
  },
  {
    id: 'analyst',
    label: 'Analyst',
    icon: 'analyst',
    about: 'The analyst’s models, defaults, instructions and trading sessions, and your own agents.',
    keywords: ['ai', 'agent', 'agents', 'codex', 'claude', 'model', 'prompt', 'instructions', 'mcp'],
  },
  {
    id: 'data',
    label: 'Data',
    icon: 'data',
    about: 'Saved trades, pulls of past days, what Tessera keeps and a backup.',
    keywords: ['storage', 'database', 'backup', 'export', 'disk', 'directory', 'ticks', 'trades', 'csv'],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'appearance',
    about: 'The theme of the whole app and its charts, the themes you saved, and every app colour.',
    keywords: [
      'theme',
      'dark',
      'light',
      'mode',
      'colours',
      'colors',
      'solarized',
      'night owl',
      'nord',
      'gruvbox',
      'tessera',
      'import',
      'export',
    ],
  },
  {
    id: 'app',
    label: 'App',
    icon: 'settings',
    about:
      'Time zone, startup, density, motion, privacy, reporting a problem, your shared links, this build and its keys.',
    keywords: ['general', 'time zone', 'workspace', 'density', 'motion', 'privacy', 'version', 'about', 'shortcuts'],
  },
];

export function categoryDef(id: SettingsCategory): CategoryDef {
  return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[0]!;
}

export interface RowDef {
  id: string;
  title: string;
  help?: string;
  keywords?: readonly string[];
}

export interface SectionDef {
  id: string;
  title: string;
  description?: string;
  keywords?: readonly string[];
  rows?: readonly RowDef[];
}

export const SECTIONS: Readonly<Record<SettingsCategory, readonly SectionDef[]>> = {
  connections: [
    {
      id: 'connections.list',
      title: 'Your connections',
      keywords: [
        'rithmic',
        'levels provider',
        'paper trading',
        'add connection',
        'test',
        'edit',
        'disconnect',
        'remove',
        'status',
        'latency',
        'password',
        'api key',
        'keychain',
        'keyring',
      ],
    },
    {
      id: 'connections.exchanges',
      title: 'Market data by exchange',
      keywords: ['data source', 'data from', 'routes', 'data and execution', 'feed', 'prices', 'depth', 'cme', 'comex'],
    },
    {
      id: 'connections.orders',
      title: 'Orders by exchange',
      keywords: ['execute with', 'default account', 'routes', 'data and execution', 'trade account', 'cme', 'comex'],
    },
  ],
  trading: [
    {
      id: 'trading.accounts',
      title: 'Accounts',
      description: 'One on a broker’s or prop firm’s login takes orders only while its switch is on.',
      keywords: [
        'evaluation',
        'eval',
        'funded',
        'live',
        'paper',
        'account type',
        'prop firm',
        'enable orders',
        'order entry',
        'read only',
      ],
    },
    {
      id: 'trading.limits',
      title: 'Risk limits',
      description: 'Held on every account, each on its own day.',
      rows: [
        {
          id: 'trading.dailyLoss',
          title: 'Daily loss limit',
          help: 'Reached, the account is flattened and takes no entries until 18:00 New York. Exits still work',
          keywords: ['dll', 'max daily loss', 'loss limit', 'stop trading', 'lockout', 'flatten', 'lock'],
        },
        {
          id: 'trading.perTrade',
          title: 'Max risk per trade',
          help: 'At its stop. An entry without a stop is refused',
          keywords: ['risk per trade', 'stop loss', 'max loss per trade', 'position risk'],
        },
        {
          id: 'trading.orderQty',
          title: 'Max contracts an order',
          keywords: ['order size', 'max size', 'quantity', 'fat finger'],
        },
        {
          id: 'trading.positionQty',
          title: 'Max position',
          keywords: ['position size', 'max contracts', 'exposure'],
        },
        {
          id: 'trading.trades',
          title: 'Max trades a day',
          help: 'Counted when a position opens from flat',
          keywords: ['overtrading', 'trades per day', 'round turns'],
        },
      ],
    },
    {
      id: 'trading.accountLimits',
      title: 'Limits by account',
      keywords: ['per account', 'override', 'left today', 'own limits', 'trades today'],
    },
    {
      id: 'trading.firm',
      title: 'Prop firm rules',
      rows: [
        {
          id: 'trading.useFirm',
          title: 'Use my firm’s limits',
          help: 'Refuses entries that would break its daily loss or drawdown',
          keywords: ['prop firm', 'drawdown', 'trailing', 'end of day', 'evaluation', 'rithmic', 'rules'],
        },
      ],
    },
    {
      id: 'trading.lock',
      title: 'Trading lock',
      description: 'Lock an account from its chip in the order ticket or from Accounts.',
      rows: [
        {
          id: 'trading.earlyUnlock',
          title: 'Allow unlocking early',
          help: 'Lift a lock you set before its time by typing UNLOCK. A daily loss limit’s lock never lifts early',
          keywords: ['lockout', 'lock', 'unlock', 'revenge trading', 'tilt', 'cool down', 'break', 'pause trading'],
        },
      ],
    },
    {
      id: 'trading.positionBracket',
      title: 'Position bracket',
      rows: [
        {
          id: 'trading.bracketMode',
          title: 'A position’s stop and target',
          keywords: ['bracket', 'oco', 'add', 'scale in', 'grow', 'each entry', 'stop loss', 'take profit', 'merge'],
        },
      ],
    },
    {
      id: 'trading.orderHotkeys',
      title: 'Order hotkeys',
      keywords: ['hotkeys', 'keyboard', 'shortcuts', 'buy', 'sell', 'flatten', 'reverse', 'cancel all', 'remap'],
      rows: [
        {
          id: 'trading.orderHotkeysOn',
          title: 'Order hotkeys',
          help: 'A key sends at once, with no confirm',
          keywords: ['hotkeys', 'keyboard', 'one key', 'scalping', 'enable', 'disable'],
        },
      ],
    },
    {
      id: 'trading.drafts',
      title: 'Drafts',
      description: 'A draft goes stale at whichever comes first.',
      rows: [
        {
          id: 'trading.staleSeconds',
          title: 'Stale after',
          help: '5–600 s',
          keywords: ['approval', 'expiry', 'timeout'],
        },
        {
          id: 'trading.staleTicks',
          title: 'Or after this many trades',
          help: '0 goes by age only',
          keywords: ['approval', 'ticks', 'expiry'],
        },
      ],
    },
    {
      id: 'trading.brackets',
      title: 'Brackets',
      description: 'Each ticket’s last stop and target, kept with this workspace.',
      keywords: ['oco', 'stop loss', 'take profit', 'target', 'remembered'],
    },
    {
      id: 'trading.paper',
      title: 'Paper trading',
      rows: [
        {
          id: 'trading.commission',
          title: 'Commission, standard contracts',
          help: 'Per contract, per side',
          keywords: ['fees', 'costs', 'paper broker'],
        },
        {
          id: 'trading.commissionMicro',
          title: 'Commission, micro contracts',
          help: 'Per contract, per side',
          keywords: ['fees', 'costs', 'paper broker', 'micros'],
        },
      ],
    },
  ],
  chart: [
    {
      id: 'chart.newCharts',
      title: 'New charts',
      rows: [
        {
          id: 'chart.instrument',
          title: 'Symbol',
          help: 'Blank follows the last symbol you charted · a futures root follows the front month',
          keywords: ['default instrument', 'ticker', 'last charted'],
        },
        { id: 'chart.timeframe', title: 'Interval', keywords: ['default timeframe', 'period'] },
        {
          id: 'chart.chartType',
          title: 'Chart type',
          keywords: ['candles', 'bars', 'line', 'default chart type'],
        },
        {
          id: 'chart.intervals',
          title: 'Intervals in the toolbar',
          keywords: ['favourite intervals', 'favorite', 'timeframes', 'toolbar'],
        },
      ],
    },
    {
      id: 'chart.look',
      title: 'Colours and text',
      rows: [
        {
          id: 'chart.updown',
          title: 'Up and down colours',
          keywords: ['green red', 'profit loss', 'bullish bearish'],
        },
        {
          id: 'chart.theme',
          title: 'Chart look',
          help: 'Over the app’s theme',
          keywords: ['chart theme', 'preset', 'classic', 'terminal', 'graphite'],
        },
        {
          id: 'chart.positionZones',
          title: 'Position zones',
          keywords: ['background', 'shading', 'tint', 'in a trade', 'bracket', 'stop loss', 'take profit'],
        },
        {
          id: 'chart.font.size',
          title: 'Text size',
          help: '10–16 px',
          keywords: ['font size', 'labels', 'chart text'],
        },
        {
          id: 'chart.font.priceSize',
          title: 'Price size',
          help: '11–18 px',
          keywords: ['font size', 'last price', 'axis tag'],
        },
      ],
    },
    {
      id: 'chart.drawing',
      title: 'Drawing tools',
      keywords: ['new drawing', 'default style'],
      rows: [
        {
          id: 'chart.magnet',
          title: 'Magnet',
          keywords: ['snap', 'anchor', 'ohlc'],
        },
        {
          id: 'chart.railFolded',
          title: 'Fold the drawing rail',
          keywords: ['toolbar', 'collapse', 'hide'],
        },
        {
          id: 'chart.drawingStyles',
          title: 'Each tool’s colour and line',
          keywords: ['trend line', 'ray', 'rectangle', 'fibonacci', 'fib', 'horizontal line', 'width', 'dash', 'reset'],
        },
      ],
    },
    {
      id: 'chart.drawingTemplates',
      title: 'Drawing templates',
      description: 'Save one from a drawing’s Template menu.',
      keywords: ['drawing template', 'label', 'text', 'new drawings', 'rename', 'delete', 'style'],
    },
    {
      id: 'chart.templates',
      title: 'Templates',
      description: 'Save one from a chart’s Template menu.',
      keywords: ['chart template', 'default template', 'rename', 'delete'],
    },
    {
      id: 'chart.indicatorPresets',
      title: 'Indicator presets',
      keywords: ['preset', 'indicator default', 'save as default', 'reset settings', 'rename', 'delete'],
    },
    {
      id: 'chart.indicators',
      title: 'Indicators',
      rows: [
        {
          id: 'chart.indicatorsLink',
          title: 'Indicators',
          keywords: ['custom indicator', 'script', 'studies', 'javascript', 'catalog'],
        },
      ],
    },
    {
      id: 'chart.colours',
      title: 'Chart colours',
      keywords: ['palette', 'background', 'grid', 'candles', 'wicks', 'crosshair', 'footprint', 'profile'],
    },
  ],
  appearance: [
    {
      id: 'appearance.theme',
      title: 'Theme',
      rows: [
        {
          id: 'appearance.scheme',
          title: 'Appearance',
          help: 'System follows your computer’s light or dark mode',
          keywords: [
            'dark mode',
            'light mode',
            'system',
            'follow system',
            'automatic',
            'auto',
            'colour scheme',
            'color scheme',
            'macos',
            'windows',
          ],
        },
        {
          id: 'appearance.dark',
          title: 'Dark theme',
          keywords: ['dark mode', 'tessera', 'solarized', 'night owl', 'nord', 'gruvbox', 'save as', 'reset'],
        },
        {
          id: 'appearance.light',
          title: 'Light theme',
          keywords: ['light mode', 'tessera light', 'solarized', 'gruvbox', 'save as', 'reset'],
        },
        {
          id: 'appearance.import',
          title: 'Import a theme',
          help: 'A theme someone exported, as a .json file',
          keywords: ['share', 'file', 'json', 'load'],
        },
      ],
    },
    {
      id: 'appearance.saved',
      title: 'Saved themes',
      keywords: ['my themes', 'rename', 'duplicate', 'delete', 'export', 'share'],
    },
    {
      id: 'appearance.colours',
      title: 'App colours',
      keywords: [
        'surfaces',
        'ground',
        'panels',
        'menus',
        'dialogs',
        'text',
        'hairlines',
        'selection',
        'focus',
        'accent',
        'order card',
        'link groups',
        'tags',
      ],
    },
  ],
  levels: [
    {
      id: 'levels.providers',
      title: 'Providers',
      description: 'Keys and requests are in Connections.',
      keywords: ['provider', 'call wall', 'put wall', 'zero gamma', 'gamma flip', 'labels', 'distance'],
    },
    {
      id: 'levels.sources',
      title: 'Other levels',
      keywords: ['prior day', 'initial balance', 'labels', 'distance'],
    },
    {
      id: 'levels.history',
      title: 'Level history',
      description: 'Studies read levels from here.',
      keywords: ['history', 'import', 'backfill', 'recorded', 'coverage', 'research', 'study'],
      rows: [
        {
          id: 'levels.historyImport',
          title: 'Import history',
          help: 'CSV or JSON',
          keywords: ['import', 'file', 'csv', 'json', 'mapping'],
        },
        {
          id: 'levels.historyAnalyst',
          title: 'A file from another vendor',
          help: 'The analyst proposes how to read it and shows what it would store first',
          keywords: ['mapping', 'vendor', 'analyst'],
        },
      ],
    },
    {
      id: 'levels.historyImports',
      title: 'Imports',
      description: 'Each can be undone.',
      keywords: ['undo', 'import'],
    },
  ],
  alerts: [
    {
      id: 'alerts.sounds',
      title: 'Sounds',
      keywords: ['sound', 'audio', 'beep', 'chime', 'ding', 'voice'],
      rows: [
        {
          id: 'alerts.mute',
          title: 'Mute',
          keywords: ['silence', 'quiet', 'sound off', 'beep'],
        },
        { id: 'alerts.volume', title: 'Volume', keywords: ['loudness', 'sound level', 'louder', 'quieter'] },
        {
          id: 'alerts.voice',
          title: 'Voice',
          help: 'Off plays tones',
          keywords: ['voice', 'spoken', 'speech', 'announcer', 'order filled', 'tones', 'elevenlabs'],
        },
        {
          id: 'alerts.sound.fill',
          title: 'Fill',
          help: 'Also part fills, closes and reversals',
          keywords: ['fill sound', 'execution', 'filled', 'beep', 'limit filled', 'market filled', 'position closed'],
        },
        {
          id: 'alerts.sound.stop',
          title: 'Stop hit',
          keywords: ['stop sound', 'stop loss', 'stopped out'],
        },
        {
          id: 'alerts.sound.target',
          title: 'Target hit',
          keywords: ['target sound', 'take profit'],
        },
        {
          id: 'alerts.sound.rejected',
          title: 'Order rejected',
          help: 'Also when your loss limit is reached',
          keywords: ['reject sound', 'refused', 'rejection', 'loss limit'],
        },
        {
          id: 'alerts.sound.cancelled',
          title: 'Order cancelled',
          keywords: ['cancel sound', 'cancelled', 'canceled'],
        },
        {
          id: 'alerts.sound.connection',
          title: 'Connection lost',
          help: 'Also when it is back',
          keywords: ['connection sound', 'disconnected', 'reconnected', 'connection restored'],
        },
        {
          id: 'alerts.sound.alert',
          title: 'Alert fired',
          help: 'When the alert plays a sound',
          keywords: ['alert sound', 'price alert', 'chime'],
        },
      ],
    },
    {
      id: 'alerts.delivery',
      title: 'New alerts deliver to',
      description: 'Unless the alert names its own.',
      keywords: ['alert delivery', 'default delivery', 'notify'],
      rows: [
        { id: 'alerts.delivery.sound', title: 'Sound', keywords: ['alert sound'] },
        {
          id: 'alerts.delivery.desktop',
          title: 'Desktop notification',
          help: 'While Tessera runs',
          keywords: ['notification', 'notifications', 'os notification', 'banner'],
        },
        {
          id: 'alerts.delivery.discord',
          title: 'Discord',
          keywords: ['discord', 'webhook', 'phone push', 'mobile'],
        },
      ],
    },
    {
      id: 'alerts.discord',
      title: 'Discord',
      description: 'Discord’s phone app turns each post into a push.',
      keywords: ['discord', 'webhook', 'phone push', 'push notification', 'mobile', 'phone'],
      rows: [
        {
          id: 'alerts.discord.webhook',
          title: 'Webhook',
          keywords: ['discord webhook', 'webhook url', 'send test', 'remove', 'phone push'],
        },
      ],
    },
  ],
  analyst: [
    {
      id: 'analyst.providers',
      title: 'Models',
      description: 'Your own subscription, through its CLI.',
      keywords: [
        'codex',
        'claude code',
        'sign in',
        'login',
        'chatgpt',
        'version',
        'install',
        'turn on',
        'enable',
        'binary path',
        'config directory',
        'codex_home',
        'claude_config_dir',
        'launch arguments',
        'check again',
      ],
    },
    {
      id: 'analyst.external',
      title: 'Use Tessera from your agent',
      description: 'Claude Desktop, Claude Code, Codex or Cursor, while Tessera is open.',
      keywords: [
        'mcp',
        'mcp server',
        'claude desktop',
        'cursor',
        'connect an agent',
        'token',
        'revoke',
        'read only',
        'supervised',
      ],
    },
    {
      id: 'analyst.defaults',
      title: 'Conversations',
      description: 'The composer can change each for one conversation.',
      rows: [
        { id: 'analyst.model', title: 'Model', keywords: ['default model', 'provider', 'gpt', 'opus', 'sonnet'] },
        { id: 'analyst.effort', title: 'Reasoning effort', keywords: ['thinking', 'effort'] },
        {
          id: 'analyst.mode',
          title: 'Permissions',
          keywords: ['supervised', 'auto modify', 'read only', 'full access', 'mode', 'approval'],
        },
        {
          id: 'analyst.followUp',
          title: 'While the analyst works',
          keywords: ['steer', 'queue', 'follow-up', 'follow up', 'send while running', 'interrupt', 'message queue'],
        },
      ],
    },
    {
      id: 'analyst.instructions',
      title: 'Custom instructions',
      description: 'Added to every new conversation.',
      rows: [
        {
          id: 'analyst.customInstructions',
          title: 'Instructions',
          keywords: ['prompt', 'system prompt', 'brief', 'style', 'tone'],
        },
      ],
    },
    {
      id: 'analyst.sessions',
      title: 'Trading sessions',
      description:
        'The analyst trades each CME session on its own, in full access under the account’s limits, and closes out before each break.',
      rows: [
        {
          id: 'analyst.sessions.on',
          title: 'Trade every session',
          keywords: [
            'autopilot',
            'auto trade',
            'session runner',
            'evaluation',
            'globex',
            'market hours',
            'open',
            'start now',
          ],
        },
        { id: 'analyst.sessions.account', title: 'Account', keywords: ['eval', 'funded', 'prop account'] },
        { id: 'analyst.sessions.model', title: 'Model', keywords: ['codex', 'claude code', 'provider'] },
        {
          id: 'analyst.sessions.study',
          title: 'Study it trades',
          help: 'Its signal wakes the analyst',
          keywords: ['research', 'strategy', 'backtest', 'signal', 'setup', 'playbook'],
        },
        {
          id: 'analyst.sessions.instructions',
          title: 'Instructions file',
          keywords: ['standing instructions', 'plan', 'brief', 'markdown', 'file'],
        },
        {
          id: 'analyst.sessions.issues',
          title: 'Issues repository',
          help: 'Each failed session files an issue there. Empty: none',
          keywords: ['github', 'gh', 'bugs', 'friction', 'report'],
        },
      ],
    },
    {
      id: 'analyst.guards',
      title: 'Loop guards',
      description: 'Only you can change them.',
      rows: [
        { id: 'analyst.maxSteps', title: 'Steps in one turn, at most', keywords: ['loop', 'limit'] },
        { id: 'analyst.maxToolCalls', title: 'Tool calls in one turn, at most', keywords: ['loop', 'limit'] },
        {
          id: 'analyst.dedup',
          title: 'Repeat window',
          help: 'A repeat call within it reads the last answer',
          keywords: ['dedup', 'duplicate', 'cache'],
        },
      ],
    },
  ],
  data: [
    {
      id: 'data.saved',
      title: 'Saved trades',
      description: 'A day on disk is never asked for again.',
      keywords: ['ticks', 'prints', 'tape', 'history', 'disk', 'csv', 'export'],
      rows: [
        {
          id: 'data.savedRecord',
          title: 'Record your watchlists',
          help: 'While Tessera is open, charted or not',
          keywords: ['record', 'watchlist', 'live', 'background', 'prints'],
        },
        {
          id: 'data.savedAuto',
          title: 'Download missing data automatically',
          help: 'Days your feed keeps, when anything needs them. Turn off on a metered feed',
          keywords: ['download', 'auto', 'backfill', 'missing', 'history', 'metered', 'databento'],
        },
        { id: 'data.savedDisk', title: 'On disk', keywords: ['size', 'ticks.db'] },
        {
          id: 'data.savedKeep',
          title: 'Sessions kept per contract',
          help: 'Older days are deleted, except a pull’s until you release it',
          keywords: ['limit', 'prune', 'retention', 'delete'],
        },
        {
          id: 'data.exportDir',
          title: 'Export to',
          help: 'One CSV per trading day: ts_ns, price, size, side (1 buyer, -1 seller)',
          keywords: ['csv', 'folder', 'export', 'backtest'],
        },
      ],
    },
    {
      id: 'data.pulls',
      title: 'Pull a date range',
      description: 'Newest day first. Days already saved are not asked for.',
      keywords: ['download', 'backfill', 'history', 'range', 'ticks', 'rth'],
      rows: [
        {
          id: 'data.pullWeek',
          title: 'The last week',
          help: 'Every session of the last week for the markets you pick, saved on this computer.',
          keywords: ['download', 'history', 'backfill', 'week', 'replay'],
        },
        {
          id: 'data.pullNew',
          title: 'New pull',
          help: 'A root (NQ) follows the roll',
          keywords: ['download', 'backfill'],
        },
      ],
    },
    {
      id: 'data.where',
      title: 'Where',
      description: 'On this computer only.',
      keywords: ['directory', 'folder', 'size', 'disk', 'database'],
    },
    {
      id: 'data.stored',
      title: 'What it keeps',
      keywords: ['journal', 'research', 'workspaces', 'sessions', 'layouts'],
    },
    {
      id: 'data.backup',
      title: 'Backup',
      rows: [
        {
          id: 'data.backupNow',
          title: 'Back up the database',
          help: 'Into the data directory’s backups',
          keywords: ['export', 'copy', 'snapshot'],
        },
      ],
    },
  ],
  app: [
    {
      id: 'app.general',
      title: 'General',
      rows: [
        {
          id: 'app.timeZone',
          title: 'Time zone',
          help: 'Exchange hours keep the exchange’s clock',
          keywords: ['timezone', 'clock', 'utc', 'gmt', 'dst', 'daylight saving', 'local time', 'hours', 'axis'],
        },
        {
          id: 'app.workspace',
          title: 'Workspace on open',
          help: 'The analyst’s chart tools act on it',
          keywords: ['default workspace', 'layout', 'startup'],
        },
        {
          id: 'app.density',
          title: 'Row density',
          help: '24, 28 or 32 px',
          keywords: ['compact', 'comfortable', 'spacing'],
        },
        {
          id: 'app.reducedMotion',
          title: 'Reduce motion',
          help: 'Panels and menus only fade. Your system’s setting does the same',
          keywords: ['animation', 'accessibility', 'transitions'],
        },
      ],
    },
    {
      id: 'app.privacy',
      title: 'Privacy',
      keywords: ['analytics', 'telemetry', 'tracking', 'account', 'crash', 'usage', 'posthog'],
      rows: [
        {
          id: 'app.crashes',
          title: 'Send crash reports',
          help: 'Anonymous: what failed and where in Tessera’s code, sent to the Tessera team through PostHog. Never who you are, account ids, credentials or orders',
          keywords: ['crash', 'error', 'bug', 'telemetry', 'posthog', 'anonymous', 'report'],
        },
        {
          id: 'app.usage',
          title: 'Share usage analytics',
          help: 'Logs, the parts of Tessera you use, a recording of the screen with every number and private text hidden, and the analyst’s model and timing, sent to the Tessera team through PostHog. Never credentials, account ids, prices, sizes, P&L or prompts',
          keywords: ['analytics', 'telemetry', 'usage', 'posthog', 'consent', 'share', 'tracking', 'replay'],
        },
      ],
    },
    {
      id: 'app.survey',
      title: 'A question from the team',
      keywords: ['survey', 'feedback', 'question', 'opinion'],
    },
    {
      id: 'app.report',
      title: 'Report a problem',
      description: 'A bug, an idea or anything else, with what happened attached, to the Tessera team.',
      keywords: [
        'feedback',
        'send feedback',
        'bug',
        'problem',
        'report',
        'crash',
        'support',
        'help',
        'logs',
        'email',
        'contact',
      ],
    },
    {
      id: 'app.shares',
      title: 'Shares',
      description:
        'Links to what you shared. Each opens for anyone who has it and is listed nowhere. Delete one and it stops opening.',
      keywords: [
        'share',
        'shared',
        'link',
        'links',
        'unlisted',
        'screenshot',
        'picture',
        'conversation',
        'indicator',
        'template',
        'workspace',
        'delete',
        'public',
      ],
    },
    {
      id: 'app.keyboard',
      title: 'Keyboard shortcuts',
      keywords: ['keys', 'hotkeys', 'shortcuts', 'keyboard'],
    },
    {
      id: 'app.build',
      title: 'This build',
      keywords: ['version', 'release', 'debug', 'about'],
    },
    {
      id: NOTICES_SETTING,
      title: 'Notices',
      keywords: ['legal', 'copyright', 'trademark', 'attribution', 'about'],
      rows: [
        {
          id: 'app.rithmicNotices',
          title: 'Copyright and trademarks',
          keywords: ['omne', 'omnesys', 'r | protocol', 'legal'],
        },
      ],
    },
    {
      id: 'app.runtime',
      title: 'Runtime',
      keywords: ['endpoint', 'connection', 'tools', 'protocol', 'developer'],
    },
  ],
};

const SECTION_OF = new Map<string, { category: SettingsCategory; section: SectionDef }>();
const ROW_OF = new Map<string, { category: SettingsCategory; section: SectionDef; row: RowDef }>();
for (const category of SETTINGS_CATEGORIES)
  for (const section of SECTIONS[category]) {
    SECTION_OF.set(section.id, { category, section });
    for (const row of section.rows ?? []) ROW_OF.set(row.id, { category, section, row });
  }

export function sectionWords(id: string): SectionDef {
  const s = SECTION_OF.get(id)?.section;
  if (!s) throw new Error(`settings: no section ${id}`);
  return s;
}

export function rowWords(id: string): RowDef {
  const r = ROW_OF.get(id)?.row;
  if (!r) throw new Error(`settings: no row ${id}`);
  return r;
}

export function categoryOf(id: string): SettingsCategory | null {
  return ROW_OF.get(id)?.category ?? SECTION_OF.get(id)?.category ?? null;
}

export interface SearchEntry {
  id: string;
  category: SettingsCategory;
  label: string;
  path: string;
  help?: string;
  keywords: readonly string[];
}

export function modelEntries(): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const category of SETTINGS_CATEGORIES) {
    const c = categoryDef(category);
    for (const s of SECTIONS[category]) {
      const path = `${c.label} · ${s.title}`;
      out.push({
        id: s.id,
        category,
        label: s.title,
        path: c.label,
        ...(s.description ? { help: s.description } : {}),
        keywords: [...(s.keywords ?? []), ...(s.description ? [s.description] : []), c.label],
      });
      for (const r of s.rows ?? [])
        out.push({
          id: r.id,
          category,
          label: r.title,
          path,
          ...(r.help ? { help: r.help } : {}),
          keywords: [...(r.keywords ?? []), ...(r.help ? [r.help] : []), s.title, c.label],
        });
    }
  }
  return out;
}

export function searchSettings(entries: readonly SearchEntry[], query: string, limit = 40): SearchEntry[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const least = 20 * q.split(' ').length;
  return rankOptions(entries, q)
    .filter((e) => scoreOption(e, q) >= least)
    .slice(0, limit);
}

const SYNONYMS: Readonly<Record<string, SettingsCategory>> = {
  settings: 'connections',
  credentials: 'connections',
  passwords: 'connections',
  secrets: 'connections',
  connectors: 'connections',
  risk: 'trading',
  templates: 'chart',
  sounds: 'alerts',
  notifications: 'alerts',
  ai: 'analyst',
  agents: 'analyst',
  general: 'app',
  about: 'app',
  keyboard: 'app',
  shortcuts: 'app',
  keys: 'app',
};

export function isPageWord(where: string): boolean {
  return isSettingsCategory(where) || where in SYNONYMS;
}

export function landingOf(section: unknown): SettingsCategory | null {
  if (isSettingsCategory(section)) return section;
  if (typeof section !== 'string') return null;
  const synonym = SYNONYMS[section];
  if (synonym) return synonym;
  if (section.startsWith('connections.')) return 'connections';
  return categoryOf(section);
}
