import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* EBU R128 measures loudness in 400 ms blocks. */

export interface Loudness {
  lufs: number;
  truePeakDbtp: number;
}

export interface ClipOut extends Loudness {
  durationMs: number;
  bytes: number;
}

export interface ProcessOptions {
  targetLufs: number;
  ceilingDbtp: number;
  bitrateKbps: number;
}

export const PROCESS: ProcessOptions = { targetLufs: -20, ceilingDbtp: -1.5, bitrateKbps: 64 };

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) throw new Error(`${cmd} could not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr.split('\n').slice(-6).join('\n')}`);
  return `${r.stdout}\n${r.stderr}`;
}

export function checkTools(): void {
  const enc = run('ffmpeg', ['-hide_banner', '-encoders']);
  if (!enc.includes('libmp3lame')) throw new Error('ffmpeg has no libmp3lame encoder.');
  const filters = run('ffmpeg', ['-hide_banner', '-filters']);
  for (const f of ['loudnorm', 'silenceremove', 'areverse', 'afade'])
    if (!new RegExp(`\\b${f}\\b`).test(filters)) throw new Error(`ffmpeg has no ${f} filter.`);
  run('ffprobe', ['-version']);
}

const LEAD_SILENCE_S = 0.01;
const TAIL_SILENCE_S = 0.06;
const LEAD_FADE_S = 0.004;
const TAIL_FADE_S = 0.025;

const silenceDownTo = (seconds: number) =>
  `silenceremove=start_periods=1:start_threshold=-50dB:start_silence=${String(seconds)}:detection=peak`;
const fadeIn = (seconds: number) => `afade=t=in:d=${String(seconds)}`;
const atTheTail = (...filters: string[]) => ['areverse', ...filters, 'areverse'];

const TRIM = [
  silenceDownTo(LEAD_SILENCE_S),
  ...atTheTail(silenceDownTo(TAIL_SILENCE_S), fadeIn(TAIL_FADE_S)),
  fadeIn(LEAD_FADE_S),
].join(',');

function measure(file: string): Loudness {
  const out = run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-stream_loop',
    '2',
    '-i',
    file,
    '-af',
    'loudnorm=print_format=json',
    '-f',
    'null',
    '-',
  ]);
  const json = /\{[^{}]*"input_i"[^{}]*\}/.exec(out);
  if (!json) throw new Error(`no loudness measured for ${file}`);
  const m = JSON.parse(json[0]) as { input_i: string; input_tp: string };
  return { lufs: Number(m.input_i), truePeakDbtp: Number(m.input_tp) };
}

function durationMs(file: string): number {
  const out = run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  return Math.round(Number(out.trim().split('\n')[0]) * 1000);
}

export function gainFor(m: Loudness, o: ProcessOptions): number {
  return Math.min(o.targetLufs - m.lufs, o.ceilingDbtp - m.truePeakDbtp);
}

export function processClip(raw: string, out: string, o: ProcessOptions = PROCESS): ClipOut {
  const dir = mkdtempSync(join(tmpdir(), 'tessera-voice-'));
  try {
    const trimmed = join(dir, 'trimmed.wav');
    run('ffmpeg', [
      '-hide_banner',
      '-y',
      '-i',
      raw,
      '-ac',
      '1',
      '-ar',
      '44100',
      '-af',
      TRIM,
      '-c:a',
      'pcm_s16le',
      trimmed,
    ]);
    const gain = gainFor(measure(trimmed), o);
    run('ffmpeg', [
      '-hide_banner',
      '-y',
      '-i',
      trimmed,
      '-af',
      `volume=${gain.toFixed(2)}dB`,
      '-c:a',
      'libmp3lame',
      '-b:a',
      `${String(o.bitrateKbps)}k`,
      '-ar',
      '44100',
      '-ac',
      '1',
      '-map_metadata',
      '-1',
      '-id3v2_version',
      '0',
      out,
    ]);
    const final = measure(out);
    return { ...final, durationMs: durationMs(trimmed), bytes: statSync(out).size };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
