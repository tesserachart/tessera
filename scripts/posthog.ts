import { FLAGS } from '../apps/desktop/src/app/flagKeys.ts';

const HOST = 'https://eu.posthog.com';
const TAG = 'tessera-setup';

const key = process.env.POSTHOG_PERSONAL_API_KEY;
const project = process.env.POSTHOG_PROJECT_ID ?? '324323';
if (!key) {
  console.error('POSTHOG_PERSONAL_API_KEY is not set (a personal API key with write access to the Tessera project).');
  process.exit(2);
}

type Json = Record<string, unknown>;

async function api<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: { authorization: `Bearer ${key!}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${String(res.status)} ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function all(path: string): Promise<Json[]> {
  const out: Json[] = [];
  let next: string | null = `${path}${path.includes('?') ? '&' : '?'}limit=200`;
  while (next) {
    const page: { results: Json[]; next: string | null } = await api('GET', next.replace(HOST, ''));
    out.push(...page.results);
    next = page.next;
  }
  return out;
}

const base = `/api/projects/${project}`;

async function upsert(kind: string, match: (row: Json) => boolean, body: Json): Promise<Json> {
  const found = (await all(`${base}/${kind}/`)).find(match);
  return found ? api('PATCH', `${base}/${kind}/${String(found.id)}/`, body) : api('POST', `${base}/${kind}/`, body);
}

const events = (...names: string[]) => names.map((event) => ({ kind: 'EventsNode', event, name: event }));

const LAST_30 = { date_from: '-30d' };

function trends(series: Json[], extra: Json = {}): Json {
  return {
    kind: 'InsightVizNode',
    source: { kind: 'TrendsQuery', series, interval: 'day', dateRange: LAST_30, filterTestAccounts: true, ...extra },
  };
}

function breakdown(property: string, display = 'ActionsBarValue'): Json {
  return { breakdownFilter: { breakdown: property, breakdown_type: 'event' }, trendsFilter: { display } };
}

interface Insight {
  name: string;
  description: string;
  query: Json;
}

interface Board {
  name: string;
  description: string;
  insights: Insight[];
}

const ACTIVATION: Insight = {
  name: 'Activation: sign-in to first order',
  description:
    'Traders who signed in, then connected data or a broker, loaded a chart, started an analyst session and placed an order, within 14 days.',
  query: {
    kind: 'InsightVizNode',
    source: {
      kind: 'FunnelsQuery',
      series: events('signed in', 'connection added', 'chart loaded', 'analyst session started', 'order placed'),
      funnelsFilter: { funnelWindowInterval: 14, funnelWindowIntervalUnit: 'day', funnelVizType: 'steps' },
      dateRange: { date_from: '-90d' },
      filterTestAccounts: true,
    },
  },
};

function boards(surveyKey: string | null): Board[] {
  return [
    {
      name: 'Tessera alpha: activation',
      description: `Who gets from sign-in to a first order, and who comes back. Replays: ${HOST}/project/${project}/replay/home`,
      insights: [
        ACTIVATION,
        {
          name: 'Weekly active traders',
          description: 'People who opened the app each week.',
          query: trends([{ ...events('app opened')[0], math: 'dau' }], {
            interval: 'week',
            dateRange: { date_from: '-90d' },
          }),
        },
        {
          name: 'Retention: back the weeks after',
          description: 'Of those who first opened the app in a week, how many opened it again in each following week.',
          query: {
            kind: 'InsightVizNode',
            source: {
              kind: 'RetentionQuery',
              retentionFilter: {
                targetEntity: { id: 'app opened', name: 'app opened', type: 'events' },
                returningEntity: { id: 'app opened', name: 'app opened', type: 'events' },
                retentionType: 'retention_first_time',
                totalIntervals: 8,
                period: 'Week',
              },
              filterTestAccounts: true,
            },
          },
        },
        {
          name: 'First steps, by day',
          description: 'Sign-ins, connections added, charts loaded, analyst sessions and orders each day.',
          query: trends(
            events('signed in', 'connection added', 'chart loaded', 'analyst session started', 'order placed'),
          ),
        },
        {
          name: 'Connections added, by kind',
          description: 'Broker and data (Rithmic) against levels sources.',
          query: trends(events('connection added'), breakdown('kind')),
        },
        ...(surveyKey
          ? [
              {
                name: 'Survey: how would you feel without Tessera',
                description: 'Answers to the in-app survey (Settings › App › A question from the team).',
                query: trends(events('survey sent'), breakdown(surveyKey, 'ActionsPie')),
              },
            ]
          : []),
      ],
    },
    {
      name: 'Tessera alpha: areas',
      description: 'Where traders spend their time, and the moments that matter in each area.',
      insights: [
        {
          name: 'Areas opened',
          description: 'Each area of the app, by how often it is opened.',
          query: trends(events('area opened'), breakdown('area')),
        },
        {
          name: 'Panels opened',
          description: 'Each panel added to the desk.',
          query: trends(events('panel opened'), breakdown('panel')),
        },
        {
          name: 'Orders, by who placed them',
          description: 'Orders placed by the trader, the analyst or a connected app, and their outcome.',
          query: trends(events('order placed'), breakdown('origin', 'ActionsLineGraph')),
        },
        {
          name: 'Trade copier',
          description: 'Copy groups created, switched on and off, flattened and resynced.',
          query: trends(
            events(
              'copy group created',
              'copy group enabled',
              'copy group disabled',
              'copy group flattened',
              'copy group resynced',
            ),
          ),
        },
        {
          name: 'Multi-account',
          description:
            'Account switches in the ticket, flattens and cancels across accounts, and how many followers each copy group gets.',
          query: trends([
            ...events('account switched', 'position flattened'),
            { ...events('copy group created')[0], math: 'avg', math_property: 'followers' },
          ]),
        },
        {
          name: 'Journal',
          description: 'Imports, trades logged and reviewed, days reviewed and exports.',
          query: trends(
            events(
              'journal imported',
              'journal trade logged',
              'journal trade reviewed',
              'journal day reviewed',
              'journal exported',
            ),
          ),
        },
        {
          name: 'Research, alerts and replay',
          description: 'Studies run, alerts created and market replays opened.',
          query: trends(events('research run', 'alert created', 'replay opened', 'custom indicator created')),
        },
      ],
    },
    {
      name: 'Tessera alpha: analyst and health',
      description: `The analyst's models, tools, time and failures; crashes and errors. Traces: ${HOST}/project/${project}/llm-analytics/traces`,
      insights: [
        {
          name: 'Analyst turns, by model',
          description: 'Each analyst turn (one model call), by model.',
          query: trends(events('$ai_generation'), breakdown('$ai_model', 'ActionsLineGraph')),
        },
        {
          name: 'Analyst turn time',
          description: 'Median seconds per analyst turn.',
          query: trends([{ ...events('$ai_trace')[0], math: 'median', math_property: '$ai_latency' }]),
        },
        {
          name: 'Analyst turns that failed',
          description: 'Failed turns, by provider.',
          query: trends(
            [
              {
                ...events('$ai_trace')[0],
                properties: [{ key: '$ai_is_error', value: ['true'], operator: 'exact', type: 'event' }],
              },
            ],
            breakdown('agent_provider', 'ActionsLineGraph'),
          ),
        },
        {
          name: 'Tools the analyst calls',
          description: 'Tool calls inside analyst turns, by tool.',
          query: trends(events('$ai_span'), breakdown('$ai_span_name')),
        },
        {
          name: 'Errors and crashes',
          description: 'Runtime panics and window errors.',
          query: trends(events('$exception'), breakdown('kind', 'ActionsLineGraph')),
        },
      ],
    },
  ];
}

const SURVEY = {
  name: 'Alpha: how would you feel without Tessera',
  description: 'One question, asked once, ten minutes into a launch (Settings › App › A question from the team).',
  type: 'api',
  questions: [
    {
      type: 'single_choice',
      question: 'How would you feel if you could no longer use Tessera?',
      choices: ['Very disappointed', 'Somewhat disappointed', 'Not disappointed'],
    },
    {
      type: 'open',
      question: 'What is the one thing Tessera should do better?',
      optional: true,
    },
  ],
};

const SETTINGS: Json = {
  session_recording_opt_in: true,
  capture_console_log_opt_in: false,
  capture_performance_opt_in: false,
  session_recording_minimum_duration_milliseconds: 2000,
  session_recording_masking_config: { maskAllInputs: true, maskTextSelector: '*' },
  surveys_opt_in: true,
  anonymize_ips: true,
  autocapture_opt_out: true,
  heatmaps_opt_in: false,
  test_account_filters: [{ key: 'build', value: ['dev'], operator: 'is_not', type: 'event' }],
  test_account_filters_default_checked: true,
};

async function main() {
  await api('PATCH', `${base}/`, SETTINGS);
  console.info('project: replay on, IPs discarded, dev builds filtered as test traffic');

  for (const [flag, def] of Object.entries(FLAGS) as [string, { fallback: boolean | string; about: string }][]) {
    await upsert('feature_flags', (f) => f.key === flag, {
      key: flag,
      name: def.about,
      active: true,
      tags: [TAG],
      filters: { groups: [{ properties: [], rollout_percentage: def.fallback === true ? 100 : 0 }] },
    });
    console.info(`flag ${flag}`);
  }

  const existing = (await all(`${base}/surveys/`)).find((s) => s.name === SURVEY.name);
  const survey: Json =
    existing ?? (await api('POST', `${base}/surveys/`, { ...SURVEY, start_date: new Date().toISOString() }));
  const firstQuestion = (survey.questions as { id?: string }[] | undefined)?.[0]?.id ?? null;
  console.info(`survey ${String(survey.id)}`);

  const links: string[] = [];
  for (const board of boards(firstQuestion ? `$survey_response_${firstQuestion}` : null)) {
    const dash = await upsert('dashboards', (d) => d.name === board.name && !d.deleted, {
      name: board.name,
      description: board.description,
      tags: [TAG],
    });
    for (const insight of board.insights) {
      await upsert('insights', (i) => i.name === insight.name && !i.deleted, {
        ...insight,
        saved: true,
        tags: [TAG],
        dashboards: [dash.id],
      });
    }
    links.push(`${HOST}/project/${project}/dashboard/${String(dash.id)}  ${board.name}`);
  }
  console.info(links.join('\n'));
}

await main();
