import type { Attachment } from '@tessera/protocol';

const MIB = 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * MIB;
export const MAX_FILE_BYTES = 50 * MIB;
export const MAX_ATTACHMENTS = 100;
export const MAX_IMAGE_BYTES_PER_MESSAGE = 80 * MIB;
export const UPLOAD_CHUNK_BYTES = 4 * MIB;
export const PASTE_AS_FILE_BYTES = 32 * 1024;
const INLINE_CHARS = 100_000;
export const MAX_SOURCE_IMAGE_BYTES = 50 * MIB;
const MAX_IMAGE_EDGE = 2048;
export const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
export const SCALE_STEPS = [0.75, 0.55] as const;

const SUPPORTED_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const CONVERTIBLE_EXTENSIONS = new Set(['heic', 'heif', 'bmp', 'avif', 'tif', 'tiff']);
const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/sql',
  'application/x-sh',
  'application/x-python',
  'application/csv',
  'application/x-ndjson',
]);
const TEXT_EXTENSIONS = new Set(
  (
    'txt md markdown csv tsv json jsonl ndjson log xml yaml yml toml ini cfg conf env sql ' +
    'py ts tsx js jsx mjs cjs rs go java kt swift c h cc cpp hpp cs rb php sh bash zsh ps1 ' +
    'html htm css scss less vue svelte r jl lua pine pinescript mq4 mq5 el efs ninjascript cs ' +
    'tex rst adoc org diff patch gitignore dockerfile makefile'
  ).split(' '),
);

export interface FileFacts {
  name: string;
  type: string;
  size: number;
}

export type FileClass = 'image' | 'convert' | 'pdf' | 'text' | 'unknown';

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : name.toLowerCase();
}

export function imageType(file: Pick<FileFacts, 'name' | 'type'>): string | null {
  const type = file.type.toLowerCase();
  if (SUPPORTED_IMAGES.has(type)) return type;
  if (type === '' || type === 'application/octet-stream') return IMAGE_BY_EXTENSION[extension(file.name)] ?? null;
  return null;
}

export function classifyFile(file: Pick<FileFacts, 'name' | 'type'>): FileClass {
  const type = file.type.toLowerCase();
  const ext = extension(file.name);
  if (imageType(file)) return 'image';
  if (type.startsWith('image/') || CONVERTIBLE_EXTENSIONS.has(ext)) return 'convert';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.startsWith('text/') || TEXT_TYPES.has(type) || TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unknown';
}

export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(trimPartialUtf8(bytes));
  } catch {
    return false;
  }
  let control = 0;
  let chars = 0;
  for (const c of text) {
    chars += 1;
    const code = c.codePointAt(0) ?? 0;
    if ((code < 0x20 && ![0x09, 0x0a, 0x0d, 0x0c, 0x1b].includes(code)) || code === 0x7f) control += 1;
  }
  return control * 100 <= chars;
}

function trimPartialUtf8(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  let i = end - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && ((bytes[i] ?? 0) & 0xc0) === 0x80) {
    i -= 1;
    cont += 1;
  }
  if (i < 0) return bytes;
  const lead = bytes[i] ?? 0;
  const need = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
  if (need > cont) end = i;
  return bytes.subarray(0, end);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < MIB) return `${String(Math.round(n / 1024))} KB`;
  const mb = n / MIB;
  return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`;
}

export interface Draft {
  key: string;
  name: string;
  kind: 'image' | 'file';
  mimeType: string;
  sizeBytes: number;
  progress: number;
  attachment: Attachment | null;
}

export interface Reader {
  name: string;
  readsPdfs: boolean;
}

export function readerOf(
  providers: readonly { id: string; name: string; readsPdfs: boolean }[],
  id: string | null,
): Reader | null {
  const p = id ? providers.find((x) => x.id === id) : undefined;
  return p ? { name: p.name, readsPdfs: p.readsPdfs } : null;
}

export function refusal(
  file: { name: string; kind: 'image' | 'file'; pdf: boolean; size: number },
  existing: readonly Pick<Draft, 'kind' | 'sizeBytes'>[],
  reader: Reader | null,
): string | null {
  if (existing.length >= MAX_ATTACHMENTS) return `A message carries ${String(MAX_ATTACHMENTS)} attachments at most`;
  if (file.size === 0) return `${file.name} is empty`;
  if (file.kind === 'image') {
    if (file.size > MAX_IMAGE_BYTES) return `${file.name} is larger than 10 MB, even made smaller`;
    const images = existing.filter((a) => a.kind === 'image').reduce((sum, a) => sum + a.sizeBytes, 0);
    if (images + file.size > MAX_IMAGE_BYTES_PER_MESSAGE) return `A message's images are 80 MB at most together`;
    return null;
  }
  if (file.size > MAX_FILE_BYTES) return `${file.name} is larger than 50 MB`;
  if (file.pdf && reader && !reader.readsPdfs) return pdfRefusal(file.name, reader.name);
  return null;
}

function pdfRefusal(name: string, reader: string): string {
  return `${reader} does not read PDFs: ${name} needs a Claude Code session`;
}

export function sendBlock(drafts: readonly Draft[], reader: Reader | null): string | null {
  if (drafts.some((d) => d.attachment === null)) return 'Waiting for attachments to upload';
  const pdf = drafts.find((d) => d.mimeType === 'application/pdf');
  if (pdf && reader && !reader.readsPdfs) return pdfRefusal(pdf.name, reader.name);
  return null;
}

export function partialNote(d: Pick<Draft, 'kind' | 'mimeType' | 'sizeBytes'>): string | null {
  if (d.kind !== 'file' || d.mimeType === 'application/pdf' || d.sizeBytes <= INLINE_CHARS) return null;
  return 'The analyst reads its first 100,000 characters';
}

export function pasteAsFile(text: string): boolean {
  if (text.length === 0) return false;
  return text.length >= PASTE_AS_FILE_BYTES || new TextEncoder().encode(text).byteLength >= PASTE_AS_FILE_BYTES;
}

export function pastedTextName(existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has('pasted-text.txt')) return 'pasted-text.txt';
  for (let i = 2; ; i += 1) {
    const name = `pasted-text-${String(i)}.txt`;
    if (!taken.has(name)) return name;
  }
}

export function pasteTakesFiles(files: readonly Pick<FileFacts, 'name' | 'type'>[], plainText: string): boolean {
  if (files.some((f) => ['image', 'convert'].includes(classifyFile(f)))) return true;
  return plainText.length === 0 && files.length > 0;
}

export function fitWithin(width: number, height: number, edge = MAX_IMAGE_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= edge) return { width, height };
  const k = edge / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export function jpegName(name: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.jpg`;
}

/** A whole piece would exceed `fromCharCode`'s argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

export function pieceOffsets(size: number, chunk = UPLOAD_CHUNK_BYTES): number[] {
  const out: number[] = [];
  for (let at = 0; at < size; at += chunk) out.push(at);
  return out;
}

export function sendable(drafts: readonly Draft[]): Attachment[] {
  return drafts.flatMap((d) => (d.attachment ? [d.attachment] : []));
}

export function splitAttachments(list: readonly Attachment[]): { images: Attachment[]; files: Attachment[] } {
  return {
    images: list.filter((a) => a.kind === 'image' && a.id),
    files: list.filter((a) => !(a.kind === 'image' && a.id)),
  };
}
