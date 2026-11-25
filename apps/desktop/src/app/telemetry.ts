import type {
  TelemetryConfigOutput,
  TelemetryReplay,
  TelemetryStatusOutput,
  TelemetryWindowEvent,
} from '@tessera/protocol';
import type { DockviewApi } from 'dockview-react';
import type { CaptureResult, PostHog, PostHogConfig } from 'posthog-js/no-external';
import { useEffect } from 'react';
import { useAccount } from '../account/account.ts';
import { areaStore } from '../areas/store.ts';
import { setRuntimeSetting, useRuntimeSetting } from '../state/runtimeSettings.ts';
import { maskAttribute, maskInput, maskText } from './replayMask.ts';
import { watch } from './store.ts';
import { peekTool, refreshTools, runToolResult, useTool, useTools } from './tools.ts';

const CONSENT_SETTING = 'telemetry.consent';

export interface Consent {
  crashes: boolean;
  usage: boolean | null;
}

const FRESH_CONSENT: Consent = { crashes: true, usage: null };

export type Sharing = { kind: 'unknown' } | { kind: 'unavailable' } | { kind: 'known'; consent: Consent };

function consentOf(value: unknown): Consent {
  const v = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    crashes: typeof v.crashes === 'boolean' ? v.crashes : FRESH_CONSENT.crashes,
    usage: typeof v.usage === 'boolean' ? v.usage : null,
  };
}

function sharingOf(status: TelemetryStatusOutput | null | undefined, consent: unknown): Sharing {
  if (status === undefined) return { kind: 'unknown' };
  if (!status?.available) return { kind: 'unavailable' };
  if (consent === undefined) return { kind: 'unknown' };
  return { kind: 'known', consent: consentOf(consent) };
}

export function useSharing(): Sharing {
  const tools = useTools();
  const has = tools?.has('telemetry.status') === true;
  const status = useTool('telemetry.status', has ? {} : null, { keepFor: Infinity });
  const consent = useRuntimeSetting(CONSENT_SETTING);
  return sharingOf(tools === null ? undefined : !has || status.isError ? null : status.data, consent);
}

export function usageAsked(sharing: Sharing): boolean {
  return sharing.kind === 'known' && sharing.consent.usage === null;
}

export function setConsent(now: Consent, change: Partial<Consent>): Promise<string | null> {
  return setRuntimeSetting(CONSENT_SETTING, { ...now, ...change });
}

const CONFIG_EVERY = 30 * 60_000;

const NOTHING_REMOTE: TelemetryConfigOutput = { asked: false, flags: {}, replay: null, surveys: [] };

const ASK_AGAIN_MS = 1_000;

export function useTelemetryConfig(): TelemetryConfigOutput | undefined {
  const sharing = useSharing();
  const on = sharing.kind === 'known' && sharing.consent.usage === true;
  const ahead = on && peekTool('telemetry.config', {})?.asked === false;
  const config = useTool('telemetry.config', on ? {} : null, {
    keepFor: Infinity,
    refreshEvery: ahead ? ASK_AGAIN_MS : CONFIG_EVERY,
  });
  if (!on) return undefined;
  if (config.isError) return NOTHING_REMOTE;
  return config.data?.asked ? config.data : undefined;
}

export function useTelemetry(): void {
  const sharing = useSharing();
  const config = useTelemetryConfig() ?? null;
  const user = useAccount()?.user?.email ?? null;
  const consent = sharing.kind === 'known' ? sharing.consent : null;
  const crashes = sharing.kind === 'unknown' ? null : consent?.crashes === true;
  const usage = sharing.kind === 'unknown' ? null : sharing.kind === 'unavailable' ? false : consent!.usage;
  useEffect(() => {
    if (usage) void refreshTools('telemetry.config');
  }, [usage, user]);
  useEffect(() => {
    if (crashes !== null) setTelemetry({ crashes, usage, config: usage ? config : null });
  }, [crashes, usage, config]);
}

interface Held {
  event: string;
  properties: Record<string, unknown>;
  at: Date;
}

interface Plan {
  crashes: boolean;
  usage: boolean | null;
  config: TelemetryConfigOutput | null;
}

interface Instance {
  replay: boolean;
  posthog: PostHog | null;
}

interface Allowed {
  crashes: boolean;
  usage: boolean;
}

const MOST_HELD = 200;

const TOKEN = 'tessera';

const SEND_NOTHING_ITSELF: Partial<PostHogConfig> = {
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  disable_session_recording: true,
  disable_surveys: true,
  disable_product_tours: true,
  disable_conversations: true,
  disable_web_experiments: true,
  capture_heatmaps: false,
  capture_dead_clicks: false,
  rageclick: false,
  capture_performance: false,
  capture_exceptions: false,
  disable_external_dependency_loading: true,
  advanced_disable_flags: true,
  advanced_disable_decide: true,
  persistence: 'memory',
  mask_all_text: true,
  mask_all_element_attributes: true,
  opt_out_useragent_filter: true,
  disable_capture_url_hashes: true,
  enable_recording_console_log: false,
};

const RECORD_MASKED: Partial<PostHogConfig> = {
  disable_session_recording: false,
  session_recording: {
    maskAllInputs: true,
    maskInputFn: maskInput,
    maskTextSelector: '*',
    maskTextFn: maskText,
    maskAttributeFn: maskAttribute,
    recordHeaders: false,
    recordBody: false,
    captureCanvas: { recordCanvas: false },
    compress_events: false,
  },
};

declare global {
  interface Window {
    _POSTHOG_REMOTE_CONFIG?: Record<string, { config: Record<string, unknown> }>;
  }
}

let allowed: Allowed = { crashes: false, usage: false };
let holding = true;
let held: Held[] = [];
let holdingErrors = true;
let heldErrors: HeldError[] = [];
let instance: Instance | null = null;
let opened = false;
let lastPlan: Plan | null = null;
let loadAgain: ReturnType<typeof setTimeout> | null = null;

export const TELEMETRY_AGAIN_MS = 30_000;

function setTelemetry(plan: Plan): void {
  lastPlan = plan;
  if (loadAgain) clearTimeout(loadAgain);
  loadAgain = null;
  const usage = plan.usage === true && plan.config !== null;
  allowed = { crashes: plan.crashes, usage };
  holding = plan.usage !== false;
  if (!holding) held = [];
  holdingErrors = plan.crashes;
  if (!holdingErrors) heldErrors = [];
  if (!plan.crashes && !usage) {
    stop();
    return;
  }
  const replay = usage ? (plan.config?.replay ?? null) : null;
  if (instance?.replay !== (replay !== null)) start(replay);
  else if (instance.posthog) begin(instance.posthog);
}

function start(replay: TelemetryReplay | null): void {
  instance?.posthog?.stopSessionRecording();
  const mine: Instance = { replay: replay !== null, posthog: null };
  instance = mine;
  loadPostHog(replay, (event) => (instance === mine ? forward(event) : null)).then(
    (posthog) => {
      if (instance !== mine) {
        posthog.stopSessionRecording();
        return;
      }
      if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing({ captureEventName: false });
      mine.posthog = posthog;
      begin(posthog);
    },
    () => {
      if (instance !== mine) return;
      instance = null;
      loadAgain = setTimeout(() => {
        loadAgain = null;
        if (instance === null && lastPlan) setTelemetry(lastPlan);
      }, TELEMETRY_AGAIN_MS);
    },
  );
}

function begin(posthog: PostHog): void {
  if (allowed.crashes) {
    const errors = heldErrors;
    heldErrors = [];
    for (const h of errors) sendError(posthog, h);
  }
  if (!allowed.usage) return;
  if (!opened) {
    opened = true;
    posthog.capture('app opened');
  }
  const flushing = held;
  held = [];
  for (const h of flushing) posthog.capture(h.event, h.properties, { timestamp: h.at });
}

function stop(): void {
  if (instance?.posthog) {
    instance.posthog.stopSessionRecording();
    instance.posthog.opt_out_capturing();
  }
  instance = null;
  dropOutbox();
}

function live(): PostHog | null {
  return instance?.posthog ?? null;
}

async function loadPostHog(
  replay: TelemetryReplay | null,
  beforeSend: (event: CaptureResult | null) => null,
): Promise<PostHog> {
  const { PostHog } = await import('posthog-js/no-external');
  if (replay) {
    await import('posthog-js/dist/posthog-recorder.js');
    // posthog-js takes a remote config preloaded on `window._POSTHOG_REMOTE_CONFIG[token]` instead of fetching one.
    window._POSTHOG_REMOTE_CONFIG = {
      [TOKEN]: {
        config: {
          sessionRecording: {
            endpoint: '/s/',
            ...(replay.sampleRate === null ? {} : { sampleRate: String(replay.sampleRate) }),
            ...(replay.minimumDurationMs === null ? {} : { minimumDurationMilliseconds: replay.minimumDurationMs }),
          },
          supportedCompression: [],
        },
      },
    };
  }
  const posthog = new PostHog();
  posthog.init(TOKEN, { ...SEND_NOTHING_ITSELF, ...(replay ? RECORD_MASKED : {}), before_send: beforeSend });
  return posthog;
}

function forward(event: CaptureResult | null): null {
  if (event && (event.event === '$exception' ? allowed.crashes : allowed.usage)) {
    const properties = event.$set ? { ...event.properties, $set: event.$set } : event.properties;
    post({ event: event.event, properties, timestamp: event.timestamp?.toISOString() ?? null });
  }
  return null;
}

const FLUSH_MS = 1_000;
const MOST_A_CALL = 50;

let outbox: TelemetryWindowEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function post(event: TelemetryWindowEvent): void {
  outbox.push(event);
  flushTimer ??= setTimeout(flush, FLUSH_MS);
}

function flush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const events = outbox.splice(0, MOST_A_CALL);
  if (events.length > 0) void runToolResult('telemetry.capture', { events }).catch(() => undefined);
  if (outbox.length > 0) flushTimer = setTimeout(flush, FLUSH_MS);
}

function dropOutbox(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  outbox = [];
}

type ErrorKind = 'render' | 'error' | 'unhandled_rejection';

interface ErrorWhere {
  kind: ErrorKind;
  place?: string | null | undefined;
  componentStack?: string | null | undefined;
}

interface HeldError {
  key: string;
  error: unknown;
  where: ErrorWhere;
}

const MOST_ERRORS = 20;
const reported = new Set<string>();

export function reportError(error: unknown, where: ErrorWhere): void {
  const key = [where.kind, where.place ?? '', errorText(error)].join('\n');
  const seen = reported.has(key) || heldErrors.some((h) => h.key === key);
  if (seen || reported.size + heldErrors.length >= MOST_ERRORS) return;
  const posthog = live();
  if (posthog && allowed.crashes) sendError(posthog, { key, error, where });
  else if (holdingErrors) heldErrors.push({ key, error, where });
}

function sendError(posthog: PostHog, { key, error, where }: HeldError): void {
  reported.add(key);
  posthog.captureException(error, {
    kind: where.kind,
    ...(where.place ? { place: where.place } : {}),
    ...(where.componentStack ? { component_stack: where.componentStack } : {}),
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export type ProductEvent =
  | { event: 'area opened'; area: string }
  | { event: 'panel opened'; panel: string }
  | { event: 'chart loaded'; instrument: string; timeframe: string }
  | { event: 'account switched'; accounts: number }
  | { event: '$feature_flag_called'; $feature_flag: string; $feature_flag_response: boolean | string }
  | { event: 'survey shown'; $survey_id: string; $survey_name: string }
  | { event: 'survey dismissed'; $survey_id: string; $survey_name: string }
  | ({
      event: 'survey sent';
      $survey_id: string;
      $survey_name: string;
      $survey_questions: { id: string; question: string }[];
    } & Record<`$survey_response_${string}`, string>);

export function track({ event, ...properties }: ProductEvent): void {
  const posthog = live();
  if (posthog && allowed.usage) posthog.capture(event, properties);
  else if (holding && held.length < MOST_HELD) held.push({ event, properties, at: new Date() });
}

export function watchPanelOpens(api: Pick<DockviewApi, 'onDidAddPanel'>, loadingLayout: () => boolean): () => void {
  const sub = api.onDidAddPanel((panel) => {
    if (!loadingLayout()) track({ event: 'panel opened', panel: panel.api.component });
  });
  return () => sub.dispose();
}

export function installTelemetry(target: Window = window): () => void {
  const onError = (e: ErrorEvent) =>
    reportError(e.error ?? e.message, {
      kind: 'error',
      place: e.filename ? `${e.filename}:${String(e.lineno)}:${String(e.colno)}` : null,
    });
  const onRejection = (e: PromiseRejectionEvent) => reportError(e.reason, { kind: 'unhandled_rejection' });
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  target.addEventListener('pagehide', flush);
  const unwatch = watch(areaStore, (now, before) => {
    if (now.area !== before.area) track({ event: 'area opened', area: now.area });
  });
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
    target.removeEventListener('pagehide', flush);
    unwatch();
  };
}
