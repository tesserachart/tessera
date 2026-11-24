const STALE_MS = 1000;
const CHECK_MS = 1000;
const RESUME_MS = 1000;
const START_MS = 5000;
const MAX_BACKOFF_MS = 60_000;
const STALL_RATIO = 0.5;

type AudioContextClass = new () => AudioContext;

interface Reading {
  readonly at: number;
  readonly time: number;
}

interface Output {
  readonly ctx: AudioContext;
  ran: boolean;
  askedAt: number | null;
  runningSince: number | null;
  reading: Reading | null;
}

let out: Output | null = null;
let watching = false;
let armed = false;
let replacements = 0;
let replaceAfter = 0;

/** performance.now() stands still while macOS sleeps; Date.now() does not. */
const wallNow = (): number => Date.now();

export function bestEffort(run: () => void): void {
  try {
    run();
  } catch {}
}

function pageNeverPressed(): boolean {
  const nav = globalThis.navigator as { userActivation?: { hasBeenActive: boolean } } | undefined;
  return nav?.userActivation?.hasBeenActive === false;
}

const waitingForPress = (o: Output): boolean => !o.ran && o.ctx.state === 'suspended' && pageNeverPressed();

function open(): Output | null {
  const g = globalThis as { AudioContext?: AudioContextClass; webkitAudioContext?: AudioContextClass };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) return null;
  try {
    const o: Output = { ctx: new Ctor(), ran: false, askedAt: null, runningSince: null, reading: null };
    ask(o).catch(() => undefined);
    return o;
  } catch {
    return null;
  }
}

function retire(o: Output): void {
  bestEffort(() => void o.ctx.close().catch(() => undefined));
}

const recent = (r: Reading | null, now: number): boolean => r !== null && now >= r.at && now - r.at < CHECK_MS;

const keptPace = (o: Output, r: Reading, now: number): boolean =>
  (o.ctx.currentTime - r.time) * 1000 >= (now - r.at) * STALL_RATIO;

function clockKeptUp(o: Output, now: number): boolean {
  if (!o.ran) return o.runningSince === null || now < o.runningSince || now - o.runningSince <= START_MS;
  const r = o.reading;
  if (!r || recent(r, now) || now < r.at) return true;
  return keptPace(o, r, now);
}

function stillSounds(o: Output, now: number): boolean {
  const { state } = o.ctx;
  if (state === 'closed' || !clockKeptUp(o, now)) return false;
  if (state !== 'running') return waitingForPress(o) || o.askedAt === null || now - o.askedAt <= RESUME_MS;
  o.askedAt = null;
  o.runningSince ??= now;
  const r = o.reading;
  if (recent(r, now)) return true;
  if (r && now >= r.at && keptPace(o, r, now)) {
    o.ran = true;
    replacements = 0;
  }
  o.reading = { at: now, time: o.ctx.currentTime };
  return true;
}

function output(): Output | null {
  const now = wallNow();
  if (out && !stillSounds(out, now) && now >= replaceAfter) {
    retire(out);
    out = null;
    replaceAfter = now + Math.min(MAX_BACKOFF_MS, RESUME_MS * 2 ** replacements);
    replacements++;
  }
  out ??= open();
  if (out && !watching) {
    watching = true;
    setInterval(() => bestEffort(check), CHECK_MS);
  }
  return out;
}

function check(): void {
  const o = output();
  if (o && o.ctx.state !== 'running' && !waitingForPress(o)) ask(o).catch(() => undefined);
}

export function audioContext(): AudioContext | null {
  return output()?.ctx ?? null;
}

/** The webview's autoplay rule keeps the context suspended until a press or key. */
function armResume(): void {
  if (armed || typeof window === 'undefined') return;
  armed = true;
  const resume = () => {
    window.removeEventListener('pointerdown', resume, true);
    window.removeEventListener('keydown', resume, true);
    const o = out?.ctx.state === 'closed' ? output() : out;
    if (o && o.ctx.state !== 'running') {
      o.askedAt = wallNow();
      o.ctx.resume().catch(() => undefined);
    }
    armed = false;
  };
  window.addEventListener('pointerdown', resume, true);
  window.addEventListener('keydown', resume, true);
}

function ask(o: Output): Promise<void> {
  o.askedAt ??= wallNow();
  armResume();
  return o.ctx.resume();
}

function play(start: (c: AudioContext) => void, asked: number): void {
  const o = output();
  if (!o || performance.now() - asked >= STALE_MS) return;
  if (o.ctx.state === 'running') {
    start(o.ctx);
    return;
  }
  const again = () => {
    if (out !== o || o.ctx.state === 'running') play(start, asked);
  };
  ask(o).then(again, again);
}

export function whenRunning(start: (c: AudioContext) => void): void {
  play(start, performance.now());
}
