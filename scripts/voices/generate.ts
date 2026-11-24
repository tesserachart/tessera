import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { VOICE_LINE_IDS, type VoiceLineId } from '../../apps/desktop/src/sound/voice/lines.ts';
import { parseManifest, type PackClip } from '../../apps/desktop/src/sound/voice/manifest.ts';
import { PROCESS, checkTools, processClip } from './audio.ts';
import { OUTPUT_FORMAT, elevenLabs } from './elevenlabs.ts';
import { LANGUAGE, manifestFor, planJobs, refusal, spendOf, type Job } from './plan.ts';
import type { Quota } from './vendor.ts';
import { VOICES } from './voices.ts';

const repo = resolve(import.meta.dirname, '../..');
const PACKS = join(repo, 'apps/desktop/src/sound/voice/packs');
const CACHE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'tessera/voices');
const FREE_PLAN_REQUESTS_AT_ONCE = 2;

function flags(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith('--')) throw new Error(`unexpected ${k}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) m.set(k.slice(2), 'true');
    else {
      m.set(k.slice(2), v);
      i++;
    }
  }
  return m;
}

const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()) : []);

async function pool<T>(items: readonly T[], n: number, work: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
}

async function main(): Promise<void> {
  const f = flags(process.argv.slice(2));
  const dry = f.has('dry-run');
  const maxChars = Number(f.get('max-chars') ?? '0');
  const voiceIds = list(f.get('voices'));
  const lineIds = list(f.get('lines'));
  for (const id of lineIds)
    if (!(VOICE_LINE_IDS as readonly string[]).includes(id)) throw new Error(`no line ${id} (lines.ts)`);
  const voices = voiceIds.length ? VOICES.filter((v) => voiceIds.includes(v.id)) : VOICES;
  if (voices.length !== (voiceIds.length || VOICES.length)) throw new Error(`no voice among ${voiceIds.join(', ')}`);
  if (!dry && !(maxChars > 0)) throw new Error('Say the most this run may spend: --max-chars N (or --dry-run).');

  checkTools();
  const el = elevenLabs();
  let account: Quota | null = null;
  try {
    account = await el.quota();
  } catch (e) {
    if (!dry) throw e;
  }
  const plan = account?.plan ?? null;
  const rawPath = (j: Job) =>
    join(CACHE, 'raw', j.voice.vendor, plan ?? 'unknown', j.voice.voiceId, `${j.line}-${j.key}.mp3`);
  const jobs = planJobs(voices, OUTPUT_FORMAT, lineIds as VoiceLineId[]);
  const made = (j: Job) => plan !== null && existsSync(rawPath(j));
  const todo = jobs.filter((j) => !made(j));

  const worstCaseCost = (j: Job) => j.text.length;
  let spend: number;
  try {
    const costs = new Map<Job, number>();
    for (const j of todo) costs.set(j, await el.costOf(j.text, j.voice.model));
    spend = Math.ceil(spendOf(jobs, made, (j) => costs.get(j) ?? 0));
  } catch (e) {
    if (!dry) throw e;
    spend = spendOf(jobs, made, worstCaseCost);
  }
  console.info(
    `${String(jobs.length)} clips (${String(voices.length)} voices × ${String(jobs.length / voices.length)} lines): ` +
      `${String(jobs.length - todo.length)} taken already, ${String(todo.length)} to take, ${String(spend)} characters.`,
  );
  if (account) {
    const left = account.limit - account.used;
    console.info(`${el.id}: ${account.plan} plan, ${String(left)} of ${String(account.limit)} characters left.`);
  }
  if (dry) {
    for (const j of todo) console.info(`  ${j.voice.id.padEnd(8)} ${j.line.padEnd(20)} ${JSON.stringify(j.text)}`);
    return;
  }
  if (!account || plan === null) throw new Error('No ElevenLabs account to make the takes on.');
  const no = refusal(spend, maxChars, account.limit - account.used);
  if (no) throw new Error(no);

  let charged = 0;
  await pool(todo, FREE_PLAN_REQUESTS_AT_ONCE, async (j) => {
    const speech = await el.speak({
      text: j.text,
      voiceId: j.voice.voiceId,
      model: j.voice.model,
      settings: j.voice.settings,
      seed: j.seed,
      language: LANGUAGE,
    });
    const path = rawPath(j);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, speech.audio);
    charged += speech.charged ?? j.text.length;
    console.info(`  took ${j.voice.id} ${j.line} (${String(speech.charged ?? '?')} characters)`);
  });

  const today = new Date().toISOString().slice(0, 10);
  for (const voice of voices) {
    const dir = join(PACKS, voice.id);
    mkdirSync(dir, { recursive: true });
    const clips: Partial<Record<VoiceLineId, PackClip>> = {};
    for (const j of jobs.filter((x) => x.voice === voice)) {
      const file = `${j.line}.mp3`;
      const out = processClip(rawPath(j), join(dir, file), PROCESS);
      clips[j.line] = { file, text: j.text, durationMs: out.durationMs, lufs: Math.round(out.lufs * 10) / 10 };
      const warn =
        out.durationMs < 250 || out.durationMs > 2500 || Math.abs(out.lufs - PROCESS.targetLufs) > 1.5 ? '  CHECK' : '';
      console.info(
        `  ${voice.id.padEnd(8)} ${j.line.padEnd(20)} ${String(out.durationMs).padStart(5)} ms ` +
          `${out.lufs.toFixed(1)} LUFS ${out.truePeakDbtp.toFixed(1)} dBTP ${String(out.bytes).padStart(6)} B${warn}`,
      );
    }
    const manifestPath = join(dir, 'manifest.json');
    const previous = existsSync(manifestPath)
      ? parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
      : null;
    const manifest = manifestFor(voice, { plan, credit: el.credit }, clips, today, previous);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  if (todo.length > 0) {
    // the account's count catches up a few seconds after the requests
    let after = await el.quota();
    for (let i = 0; i < 6 && after.used - account.used < charged; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      after = await el.quota();
    }
    const spent = Math.max(after.used - account.used, charged);
    console.info(
      `Spent ${String(spent)} characters (the account's count moved ${String(after.used - account.used)}; ` +
        `the responses charged ${String(charged)}). ${String(after.limit - after.used)} left.`,
    );
    mkdirSync(CACHE, { recursive: true });
    appendFileSync(
      join(CACHE, 'spend.log'),
      `${new Date().toISOString()} ${el.id} ${after.plan} spent=${String(spent)} takes=${String(todo.length)} left=${String(after.limit - after.used)}\n`,
    );
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
