import type { HostUpdates, UpdateEvent, UpdateFound } from '@tessera/bridge';
import { useEffect, useReducer } from 'react';
import { z } from 'zod';
import { createStore } from 'zustand/vanilla';
import { zonedFormat } from '../state/timeZone.ts';
import { appHost } from './services.ts';
import { defaultStorage, read, useStore, write } from './store.ts';

export const FIRST_CHECK = 60_000;
export const CHECK_EVERY = 30 * 60_000;
export const SNOOZE = 24 * 60 * 60_000;

type UpdateFailure = 'check' | 'download' | 'install';

interface HeldUpdate {
  readonly update: UpdateFound;
  readonly until: number | null;
}

export type UpdateState =
  | { readonly kind: 'idle'; readonly checkedAt: number | null; readonly asked: boolean }
  | { readonly kind: 'checking'; readonly asked: boolean; readonly held?: HeldUpdate }
  | { readonly kind: 'available'; readonly update: UpdateFound }
  | { readonly kind: 'later'; readonly update: UpdateFound; readonly until: number }
  | { readonly kind: 'confirm'; readonly update: UpdateFound }
  | {
      readonly kind: 'downloading';
      readonly update: UpdateFound;
      readonly fraction: number | null;
      readonly shown: boolean;
    }
  | { readonly kind: 'ready'; readonly update: UpdateFound; readonly shown: boolean }
  | { readonly kind: 'installing'; readonly update: UpdateFound }
  | {
      readonly kind: 'error';
      readonly failed: UpdateFailure;
      readonly reason: string;
      readonly update: UpdateFound | null;
      readonly asked: boolean;
      readonly shown: boolean;
    };

type UpdateStep =
  | { readonly kind: 'check'; readonly by: 'timer' | 'person' }
  | { readonly kind: 'found'; readonly update: UpdateFound }
  | { readonly kind: 'none' }
  | { readonly kind: 'check_failed'; readonly reason: string }
  | { readonly kind: 'later' }
  | { readonly kind: 'ask' }
  | { readonly kind: 'not_now' }
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'resume'; readonly update: UpdateFound }
  | { readonly kind: 'superseded'; readonly update: UpdateFound | null }
  | { readonly kind: 'progress'; readonly version: string; readonly downloaded: number; readonly total: number | null }
  | { readonly kind: 'downloaded' }
  | { readonly kind: 'failed'; readonly failed: 'download' | 'install'; readonly reason: string }
  | { readonly kind: 'retry' }
  | { readonly kind: 'dismiss' };

export const IDLE: UpdateState = { kind: 'idle', checkedAt: null, asked: false };

function downloadFraction(downloaded: number, total: number | null): number | null {
  return total === null || total <= 0 ? null : Math.min(1, Math.max(0, downloaded / total));
}

function reopened(state: UpdateState): UpdateState | null {
  switch (state.kind) {
    case 'downloading':
    case 'ready':
      return state.shown ? state : { ...state, shown: true };
    case 'error':
      if (state.failed === 'check' || !state.update) return null;
      return state.shown ? state : { ...state, shown: true };
    default:
      return null;
  }
}

function mayCheck(state: UpdateState, by: 'timer' | 'person'): boolean {
  switch (state.kind) {
    case 'idle':
      return true;
    case 'error':
      return by === 'person' || state.failed === 'check';
    case 'available':
    case 'later':
      return true;
    default:
      return false;
  }
}

function heldFrom(state: UpdateState): HeldUpdate | undefined {
  if (state.kind === 'available') return { update: state.update, until: null };
  if (state.kind === 'later') return { update: state.update, until: state.until };
  return undefined;
}

function restore(held: HeldUpdate): UpdateState {
  return held.until === null
    ? { kind: 'available', update: held.update }
    : { kind: 'later', update: held.update, until: held.until };
}

function settled(held: HeldUpdate, now: number): UpdateState {
  return held.until !== null && held.until > now ? restore(held) : { kind: 'available', update: held.update };
}

type ParsedVersion = { readonly core: readonly number[]; readonly pre: readonly (number | string)[] };

function parseVersion(version: string): ParsedVersion {
  const beforeBuild = version.split('+')[0] ?? '';
  const dash = beforeBuild.indexOf('-');
  const core = (dash < 0 ? beforeBuild : beforeBuild.slice(0, dash)).split('.').map((part) => {
    const number = Number.parseInt(part, 10);
    return Number.isFinite(number) ? number : 0;
  });
  const pre =
    dash < 0
      ? []
      : beforeBuild
          .slice(dash + 1)
          .split('.')
          .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return { core, pre };
}

function compareIdentifier(left: number | string, right: number | string): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isNewerVersion(candidate: string, held: string): boolean {
  const newer = parseVersion(candidate);
  const older = parseVersion(held);
  for (let index = 0; index < Math.max(newer.core.length, older.core.length); index += 1) {
    const difference = (newer.core[index] ?? 0) - (older.core[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  if (newer.pre.length === 0 || older.pre.length === 0) return newer.pre.length === 0 && older.pre.length > 0;
  for (let index = 0; index < Math.max(newer.pre.length, older.pre.length); index += 1) {
    const left = newer.pre[index];
    const right = older.pre[index];
    if (left === undefined) return false;
    if (right === undefined) return true;
    const difference = compareIdentifier(left, right);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function next(state: UpdateState, step: UpdateStep, now: number): UpdateState {
  switch (step.kind) {
    case 'check': {
      if (state.kind === 'checking' && step.by === 'person' && !state.asked) return { ...state, asked: true };
      const shown = step.by === 'person' ? reopened(state) : null;
      if (shown) return shown;
      if (!mayCheck(state, step.by)) return state;
      const held = heldFrom(state);
      return { kind: 'checking', asked: step.by === 'person', ...(held ? { held } : {}) };
    }
    case 'found':
      if (state.kind !== 'checking') return state;
      if (!state.held) return { kind: 'available', update: step.update };
      if (isNewerVersion(step.update.version, state.held.update.version))
        return { kind: 'available', update: step.update };
      return state.asked ? { kind: 'available', update: state.held.update } : settled(state.held, now);
    case 'none':
      return state.kind === 'checking' ? { kind: 'idle', checkedAt: now, asked: state.asked } : state;
    case 'check_failed':
      if (state.kind !== 'checking') return state;
      if (!state.asked && state.held) return restore(state.held);
      return { kind: 'error', failed: 'check', reason: step.reason, update: null, asked: state.asked, shown: false };
    case 'later':
      return state.kind === 'available' ? { kind: 'later', update: state.update, until: now + SNOOZE } : state;
    case 'ask':
      return state.kind === 'available' ? { kind: 'confirm', update: state.update } : state;
    case 'not_now':
      if (state.kind === 'confirm') return { kind: 'available', update: state.update };
      return state.kind === 'downloading' || state.kind === 'ready' ? { ...state, shown: false } : state;
    case 'confirmed':
      if (state.kind === 'confirm') return { kind: 'downloading', update: state.update, fraction: null, shown: true };
      return state.kind === 'ready' ? { kind: 'installing', update: state.update } : state;
    case 'resume':
      return state.kind === 'idle' && state.checkedAt === null
        ? { kind: 'downloading', update: step.update, fraction: null, shown: false }
        : state;
    case 'superseded':
      if (state.kind !== 'downloading') return state;
      return step.update ? { kind: 'available', update: step.update } : { kind: 'idle', checkedAt: now, asked: false };
    case 'progress':
      return state.kind === 'downloading' && state.update.version === step.version
        ? { ...state, fraction: downloadFraction(step.downloaded, step.total) }
        : state;
    case 'downloaded':
      if (state.kind !== 'downloading') return state;
      return state.shown
        ? { kind: 'installing', update: state.update }
        : { kind: 'ready', update: state.update, shown: false };
    case 'failed':
      if (state.kind === 'downloading' && step.failed === 'download')
        return {
          kind: 'error',
          failed: 'download',
          reason: step.reason,
          update: state.update,
          asked: true,
          shown: state.shown,
        };
      if (state.kind === 'installing' && step.failed === 'install')
        return {
          kind: 'error',
          failed: 'install',
          reason: step.reason,
          update: state.update,
          asked: true,
          shown: true,
        };
      return state;
    case 'retry':
      if (state.kind !== 'error') return state;
      if (state.failed === 'check') return { kind: 'checking', asked: true };
      return state.update ? { kind: 'downloading', update: state.update, fraction: null, shown: true } : state;
    case 'dismiss':
      if (state.kind !== 'error') return state;
      if (state.failed === 'check' || !state.update) return IDLE;
      return { kind: 'available', update: state.update };
  }
}

export type PromptView =
  { readonly kind: 'available'; readonly update: UpdateFound } | { readonly kind: 'check_failed' };

export function promptView(state: UpdateState): PromptView | null {
  if (state.kind === 'available') return state;
  if (state.kind === 'error' && state.failed === 'check' && state.asked) return { kind: 'check_failed' };
  return null;
}

export interface DialogView {
  readonly phase: 'confirm' | 'downloading' | 'ready' | 'installing' | 'download_failed' | 'install_failed';
  readonly update: UpdateFound;
  readonly fraction: number | null;
  readonly reason: string | null;
}

export function dialogView(state: UpdateState): DialogView | null {
  switch (state.kind) {
    case 'confirm':
      return { phase: 'confirm', update: state.update, fraction: null, reason: null };
    case 'downloading':
      return state.shown
        ? { phase: 'downloading', update: state.update, fraction: state.fraction, reason: null }
        : null;
    case 'ready':
      return state.shown ? { phase: 'ready', update: state.update, fraction: 1, reason: null } : null;
    case 'installing':
      return { phase: 'installing', update: state.update, fraction: null, reason: null };
    case 'error':
      return state.failed !== 'check' && state.update && state.shown
        ? { phase: `${state.failed}_failed`, update: state.update, fraction: null, reason: state.reason }
        : null;
    default:
      return null;
  }
}

export const UP_TO_DATE_FOR = 4_000;

export type RailView =
  | { readonly kind: 'rest' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'up_to_date'; readonly until: number }
  | { readonly kind: 'failed' }
  | { readonly kind: 'downloading'; readonly version: string; readonly fraction: number | null }
  | { readonly kind: 'ready'; readonly version: string }
  | { readonly kind: 'update_failed'; readonly version: string };

const REST: RailView = { kind: 'rest' };

export function railView(state: UpdateState, now: number): RailView {
  switch (state.kind) {
    case 'checking':
      return state.asked ? { kind: 'checking' } : REST;
    case 'idle': {
      const until = state.asked && state.checkedAt !== null ? state.checkedAt + UP_TO_DATE_FOR : null;
      return until !== null && now < until ? { kind: 'up_to_date', until } : REST;
    }
    case 'error':
      if (state.failed !== 'check' && state.update) return { kind: 'update_failed', version: state.update.version };
      return state.failed === 'check' && state.asked ? { kind: 'failed' } : REST;
    case 'downloading':
      return { kind: 'downloading', version: state.update.version, fraction: state.fraction };
    case 'ready':
    case 'installing':
      return { kind: 'ready', version: state.update.version };
    default:
      return REST;
  }
}

const CHECKED_AT = zonedFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function standingWords(state: UpdateState, zone?: string): string | null {
  if (state.kind === 'idle' && state.checkedAt !== null)
    return `Up to date · checked ${CHECKED_AT(zone).format(state.checkedAt)}`;
  if (state.kind === 'available' || state.kind === 'later') return `${state.update.version} is available`;
  if (state.kind === 'downloading') return downloadingWords(state.update.version, state.fraction);
  if (state.kind === 'ready') return `${state.update.version} is ready · restart to update`;
  return null;
}

export function downloadingWords(version: string, fraction: number | null): string {
  return fraction === null
    ? `Downloading ${version}…`
    : `Downloading ${version} · ${String(Math.floor(fraction * 100))}%`;
}

export interface CheckAction {
  readonly words: string;
  readonly busy: boolean;
}

export function checkAction(state: UpdateState): CheckAction {
  switch (state.kind) {
    case 'checking':
      return { words: 'Checking for updates…', busy: true };
    case 'downloading':
      return { words: 'Show update', busy: false };
    case 'ready':
    case 'installing':
      return { words: 'Restart to update…', busy: state.kind === 'installing' };
    case 'error':
      return reopened(state) ? { words: 'Show update', busy: false } : { words: 'Check for updates', busy: false };
    default:
      return { words: 'Check for updates', busy: false };
  }
}

export const updateStore = createStore<UpdateState>(() => IDLE);

export function useUpdate(): UpdateState {
  return useStore(updateStore);
}

export function useRail(): RailView {
  const view = railView(useUpdate(), Date.now());
  const [, settle] = useReducer((n: number) => n + 1, 0);
  const until = view.kind === 'up_to_date' ? view.until : null;
  useEffect(() => {
    if (until === null) return;
    const timer = setTimeout(settle, Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until]);
  return view;
}

let inFlight: Promise<void> | null = null;
let install = 0;

function apply(step: UpdateStep): UpdateState {
  const before = read(updateStore);
  const after = next(before, step, Date.now());
  if (after !== before) write(updateStore, after);
  return after;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const KEPT_DOWNLOAD = 'tessera.updateDownload';

const keptUpdate = z.object({ version: z.string(), notes: z.string().nullable() });

function downloadToKeep(state: UpdateState): UpdateFound | null {
  return state.kind === 'downloading' || state.kind === 'ready' ? state.update : null;
}

function keptDownload(): UpdateFound | null {
  try {
    const raw = defaultStorage()?.getItem(KEPT_DOWNLOAD) ?? null;
    if (raw === null) return null;
    const parsed = keptUpdate.nullable().safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function keepDownload(state: UpdateState, previous: UpdateState): void {
  const kept = downloadToKeep(state);
  const before = downloadToKeep(previous);
  if (kept === before) return;
  try {
    defaultStorage()?.setItem(KEPT_DOWNLOAD, JSON.stringify(kept));
  } catch (error) {
    console.warn(`[updates] download not kept: ${reasonOf(error)}`);
  }
}

async function runCheck(updates: HostUpdates): Promise<void> {
  try {
    const found = await updates.check();
    apply(found ? { kind: 'found', update: found } : { kind: 'none' });
  } catch (error) {
    console.warn(`[updates] check failed: ${reasonOf(error)}`);
    apply({ kind: 'check_failed', reason: reasonOf(error) });
  }
}

function track(updates: HostUpdates): Promise<void> {
  const running = runCheck(updates).finally(() => {
    if (inFlight === running) inFlight = null;
  });
  inFlight = running;
  return running;
}

function startCheck(by: 'timer' | 'person'): Promise<void> {
  const updates = appHost().updates;
  if (!updates) return Promise.resolve();
  const before = read(updateStore);
  const after = apply({ kind: 'check', by });
  return before.kind !== 'checking' && after.kind === 'checking' ? track(updates) : (inFlight ?? Promise.resolve());
}

function checkOnFocus(): void {
  void startCheck('timer');
}

function checkOnVisible(): void {
  if (document.visibilityState === 'visible') checkOnFocus();
}

export function checkForUpdates(): Promise<void> {
  return startCheck('person');
}

export function updateLater(): void {
  apply({ kind: 'later' });
}

export function askToUpdate(): void {
  apply({ kind: 'ask' });
}

export function notNow(): void {
  apply({ kind: 'not_now' });
}

export function dismissUpdateError(): void {
  apply({ kind: 'dismiss' });
}

async function installNow(updates: HostUpdates, run: number): Promise<void> {
  try {
    await updates.installAndRestart();
  } catch (error) {
    if (run === install && read(updateStore).kind === 'installing')
      apply({ kind: 'failed', failed: 'install', reason: reasonOf(error) });
  }
}

type Start = 'held' | 'check_first';

async function stillOffered(updates: HostUpdates, version: string, current: () => boolean): Promise<boolean> {
  let found: UpdateFound | null;
  try {
    found = await updates.check();
  } catch (error) {
    if (current()) apply({ kind: 'failed', failed: 'download', reason: reasonOf(error) });
    return false;
  }
  if (!current()) return false;
  if (found?.version === version) return true;
  apply({ kind: 'superseded', update: found });
  return false;
}

async function downloadAndInstall(updates: HostUpdates, run: number, start: Start): Promise<void> {
  const wanted = read(updateStore);
  if (wanted.kind !== 'downloading') return;
  const current = () => run === install && read(updateStore).kind === 'downloading';
  if (start === 'check_first' && !(await stillOffered(updates, wanted.update.version, current))) return;
  try {
    await updates.download();
  } catch (error) {
    if (current()) apply({ kind: 'failed', failed: 'download', reason: reasonOf(error) });
    return;
  }
  if (!current()) return;
  if (apply({ kind: 'downloaded' }).kind === 'installing') await installNow(updates, run);
}

function beginInstall(updates: HostUpdates, start: Start): Promise<void> {
  install += 1;
  return downloadAndInstall(updates, install, start);
}

export function restartAndUpdate(): Promise<void> {
  const updates = appHost().updates;
  if (!updates) return Promise.resolve();
  const after = apply({ kind: 'confirmed' });
  if (after.kind === 'downloading') return beginInstall(updates, 'held');
  if (after.kind !== 'installing') return Promise.resolve();
  install += 1;
  return installNow(updates, install);
}

export function retryUpdate(): Promise<void> {
  const updates = appHost().updates;
  if (!updates) return Promise.resolve();
  const after = apply({ kind: 'retry' });
  if (after.kind === 'downloading') return beginInstall(updates, 'check_first');
  return after.kind === 'checking' ? track(updates) : Promise.resolve();
}

function hear(event: UpdateEvent): void {
  if (event.kind === 'check') void checkForUpdates();
  else apply({ kind: 'progress', version: event.version, downloaded: event.downloaded, total: event.total });
}

function resumeKeptDownload(updates: HostUpdates): void {
  const kept = keptDownload();
  if (kept && apply({ kind: 'resume', update: kept }).kind === 'downloading') void beginInstall(updates, 'check_first');
}

export function watchForUpdates(): () => void {
  const updates = appHost().updates;
  if (!updates) return () => undefined;
  const stopHearing = updates.onEvent(hear);
  const stopKeeping = updateStore.subscribe(keepDownload);
  resumeKeptDownload(updates);
  window.addEventListener('focus', checkOnFocus);
  document.addEventListener('visibilitychange', checkOnVisible);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (wait: number) => {
    timer = setTimeout(() => {
      void startCheck('timer');
      arm(CHECK_EVERY);
    }, wait);
  };
  arm(FIRST_CHECK);
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    window.removeEventListener('focus', checkOnFocus);
    document.removeEventListener('visibilitychange', checkOnVisible);
    stopKeeping();
    stopHearing();
  };
}
