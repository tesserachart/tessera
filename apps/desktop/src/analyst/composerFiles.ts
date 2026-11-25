import { createToastQueue } from '@tessera/ui';
import { patch, read, makeStore, useStore } from '../app/store.ts';
import { runTool } from '../app/tools.ts';
import {
  bytesToBase64,
  classifyFile,
  looksLikeText,
  pastedTextName,
  pieceOffsets,
  refusal,
  UPLOAD_CHUNK_BYTES,
  type Draft,
  type Reader,
} from './attachments.ts';
import { shrinkImage } from './imageShrink.ts';

export interface ComposerFile extends Draft {
  preview: string | null;
}

interface ComposerFilesState {
  files: readonly ComposerFile[];
}

const filesStore = makeStore<ComposerFilesState>({ files: [] });

export const composerToasts = createToastQueue();

export function useComposerFiles(): readonly ComposerFile[] {
  return useStore(filesStore, (s) => s.files);
}

export function composerFiles(): readonly ComposerFile[] {
  return read(filesStore).files;
}

let seq = 0;
const dropped = new Set<string>();

function update(key: string, change: Partial<ComposerFile>): void {
  patch(filesStore, (s) => ({ files: s.files.map((f) => (f.key === key ? { ...f, ...change } : f)) }));
}

function forget(key: string): ComposerFile | undefined {
  const file = read(filesStore).files.find((f) => f.key === key);
  if (file?.preview) URL.revokeObjectURL(file.preview);
  patch(filesStore, (s) => ({ files: s.files.filter((f) => f.key !== key) }));
  return file;
}

function discard(id: string): void {
  runTool('agent.discard_attachment', { id }).catch(() => undefined);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function refuse(title: string, detail?: string): void {
  composerToasts.push({ tone: 'err', title, detail: detail ?? null, ms: 6000 });
}

async function prepare(file: File): Promise<{ file: File; kind: 'image' | 'file'; pdf: boolean } | string> {
  const cls = classifyFile(file);
  if (cls === 'image' || cls === 'convert') {
    const out = await shrinkImage(file);
    if (out.ok) return { file: out.file, kind: 'image', pdf: false };
    return out.reason === 'too-large'
      ? `${file.name} is too large to send, even made smaller`
      : `${file.name} could not be read as an image`;
  }
  if (cls === 'pdf') return { file, kind: 'file', pdf: true };
  if (cls === 'unknown') {
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (!looksLikeText(head)) return `${file.name}: the analyst reads images, PDFs and text files`;
  }
  return { file, kind: 'file', pdf: false };
}

async function upload(key: string, file: File, mimeType: string): Promise<void> {
  let uploadId: string | undefined;
  try {
    for (const offset of pieceOffsets(file.size)) {
      if (dropped.has(key)) break;
      const piece = new Uint8Array(await file.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer());
      const out = await runTool('agent.upload_attachment', {
        name: file.name,
        mimeType,
        sizeBytes: file.size,
        dataBase64: bytesToBase64(piece),
        ...(uploadId ? { uploadId, offset } : {}),
      });
      uploadId = out.uploadId;
      if (out.attachment) {
        if (dropped.has(key)) break;
        update(key, { progress: 1, attachment: out.attachment, mimeType: out.attachment.mimeType ?? mimeType });
        return;
      }
      update(key, { progress: out.received / file.size });
    }
    if (!dropped.has(key)) {
      forget(key);
      refuse(`${file.name} was not attached`);
    }
  } catch (err) {
    if (!dropped.has(key)) {
      forget(key);
      refuse(`${file.name} was not attached`, errorText(err));
    }
    return;
  } finally {
    if (dropped.delete(key) && uploadId) discard(uploadId);
  }
}

export async function attachFiles(files: readonly File[], reader: Reader | null): Promise<void> {
  for (const original of files) {
    const prepared = await prepare(original).catch(() => `${original.name} could not be read`);
    if (typeof prepared === 'string') {
      refuse(prepared);
      continue;
    }
    const { file, kind, pdf } = prepared;
    const why = refusal({ name: file.name, kind, pdf, size: file.size }, read(filesStore).files, reader);
    if (why) {
      refuse(why);
      continue;
    }
    seq += 1;
    const key = `att-${String(seq)}`;
    const mimeType = pdf ? 'application/pdf' : file.type;
    const entry: ComposerFile = {
      key,
      name: file.name,
      kind,
      mimeType,
      sizeBytes: file.size,
      progress: 0,
      attachment: null,
      preview: kind === 'image' ? URL.createObjectURL(file) : null,
    };
    patch(filesStore, (s) => ({ files: [...s.files, entry] }));
    void upload(key, file, mimeType);
  }
}

export function attachPastedText(text: string, reader: Reader | null): Promise<void> {
  const name = pastedTextName(read(filesStore).files.map((f) => f.name));
  composerToasts.push({
    tone: 'info',
    title: `Attached as ${name}`,
    detail: 'Long pastes go with the message as a file',
    key: 'pasted-text',
  });
  return attachFiles([new File([text], name, { type: 'text/plain' })], reader);
}

export function removeFile(key: string): void {
  const file = forget(key);
  if (!file) return;
  const id = file.attachment?.id;
  if (id) discard(id);
  else dropped.add(key);
}

export function clearSentFiles(sent: readonly ComposerFile[]): void {
  const keys = new Set(sent.map((f) => f.key));
  for (const f of read(filesStore).files) if (keys.has(f.key) && f.preview) URL.revokeObjectURL(f.preview);
  patch(filesStore, (s) => ({ files: s.files.filter((f) => !keys.has(f.key)) }));
}

export function typedSince(sent: string, now: string): string {
  return now.startsWith(sent) ? now.slice(sent.length).trimStart() : now;
}
