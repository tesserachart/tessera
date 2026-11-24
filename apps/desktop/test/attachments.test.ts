import type { Attachment } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  PASTE_AS_FILE_BYTES,
  UPLOAD_CHUNK_BYTES,
  bytesToBase64,
  classifyFile,
  fitWithin,
  formatBytes,
  imageType,
  jpegName,
  looksLikeText,
  partialNote,
  pasteAsFile,
  pasteTakesFiles,
  pastedTextName,
  pieceOffsets,
  readerOf,
  refusal,
  sendBlock,
  sendable,
  splitAttachments,
  type Draft,
} from '../src/analyst/attachments.ts';
import { EMPTY_TRANSCRIPT, reduceTranscript } from '../src/app/agentTranscript.ts';
import { timelineRows } from '../src/areas/agents/timeline.ts';

const MIB = 1024 * 1024;
const claude = { name: 'Claude Code', readsPdfs: true };
const codex = { name: 'Codex', readsPdfs: false };

const draft = (over: Partial<Draft> = {}): Draft => ({
  key: 'k',
  name: 'a.png',
  kind: 'image',
  mimeType: 'image/png',
  sizeBytes: 1000,
  progress: 1,
  attachment: { kind: 'image', label: 'a.png', id: 'att_1', mimeType: 'image/png', sizeBytes: 1000 },
  ...over,
});

describe('what a file is', () => {
  it('classifies images, images to convert, PDFs, text and the rest', () => {
    expect(classifyFile({ name: 'shot.png', type: 'image/png' })).toBe('image');
    expect(classifyFile({ name: 'photo.JPG', type: '' })).toBe('image');
    expect(classifyFile({ name: 'drag.webp', type: 'application/octet-stream' })).toBe('image');
    expect(classifyFile({ name: 'IMG_1.HEIC', type: '' })).toBe('convert');
    expect(classifyFile({ name: 'scan.bmp', type: 'image/bmp' })).toBe('convert');
    expect(classifyFile({ name: 'report.pdf', type: '' })).toBe('pdf');
    expect(classifyFile({ name: 'x', type: 'application/pdf' })).toBe('pdf');
    expect(classifyFile({ name: 'fills.csv', type: 'text/csv' })).toBe('text');
    expect(classifyFile({ name: 'strategy.py', type: '' })).toBe('text');
    expect(classifyFile({ name: 'data.json', type: 'application/json' })).toBe('text');
    expect(classifyFile({ name: 'archive.zip', type: 'application/zip' })).toBe('unknown');
    expect(classifyFile({ name: 'README', type: '' })).toBe('unknown');
    expect(imageType({ name: 'a.jpeg', type: '' })).toBe('image/jpeg');
    expect(imageType({ name: 'a.png', type: 'text/plain' })).toBeNull();
  });

  it('reads the first bytes of an unknown file as text or not', () => {
    const enc = new TextEncoder();
    expect(looksLikeText(enc.encode('# Plan\nES above 6,000\tlong\n'))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false);
    const euro = enc.encode('price €');
    expect(looksLikeText(euro.subarray(0, euro.length - 1))).toBe(true);
  });
});

describe('the limits', () => {
  it('holds an image to 10 MB, a file to 50 MB, a message to 100 and its images to 80 MB', () => {
    expect(refusal({ name: 'a.png', kind: 'image', pdf: false, size: MAX_IMAGE_BYTES }, [], claude)).toBeNull();
    expect(refusal({ name: 'a.png', kind: 'image', pdf: false, size: MAX_IMAGE_BYTES + 1 }, [], claude)).toContain(
      '10 MB',
    );
    expect(refusal({ name: 'log.txt', kind: 'file', pdf: false, size: MAX_FILE_BYTES }, [], claude)).toBeNull();
    expect(refusal({ name: 'log.txt', kind: 'file', pdf: false, size: MAX_FILE_BYTES + 1 }, [], claude)).toContain(
      '50 MB',
    );
    expect(refusal({ name: 'e.txt', kind: 'file', pdf: false, size: 0 }, [], claude)).toBe('e.txt is empty');
    const full = Array.from({ length: MAX_ATTACHMENTS }, () => draft());
    expect(refusal({ name: 'b.png', kind: 'image', pdf: false, size: 10 }, full, claude)).toContain('100');
    const heavy = Array.from({ length: 8 }, () => draft({ sizeBytes: 10 * MIB }));
    expect(refusal({ name: 'b.png', kind: 'image', pdf: false, size: 1 }, heavy, claude)).toContain('80 MB');
    expect(refusal({ name: 'b.txt', kind: 'file', pdf: false, size: 1 }, heavy, claude)).toBeNull();
  });

  it('refuses a PDF for a provider that does not read one, naming it', () => {
    const pdf = { name: 'report.pdf', kind: 'file' as const, pdf: true, size: 2000 };
    expect(refusal(pdf, [], claude)).toBeNull();
    expect(refusal(pdf, [], codex)).toBe('Codex does not read PDFs: report.pdf needs a Claude Code session');
    const attached = draft({ name: 'report.pdf', kind: 'file', mimeType: 'application/pdf' });
    expect(sendBlock([attached], claude)).toBeNull();
    expect(sendBlock([attached], codex)).toContain('Codex does not read PDFs');
    expect(sendBlock([draft({ attachment: null, progress: 0.4 })], claude)).toBe('Waiting for attachments to upload');
    expect(readerOf([{ id: 'codex', name: 'Codex', readsPdfs: false }], 'codex')).toEqual(codex);
    expect(readerOf([], 'codex')).toBeNull();
  });

  it('says when the analyst reads only part of a text file', () => {
    expect(partialNote({ kind: 'file', mimeType: 'text/plain', sizeBytes: 200_000 })).toContain('100,000');
    expect(partialNote({ kind: 'file', mimeType: 'text/plain', sizeBytes: 5_000 })).toBeNull();
    expect(partialNote({ kind: 'file', mimeType: 'application/pdf', sizeBytes: 9 * MIB })).toBeNull();
    expect(partialNote({ kind: 'image', mimeType: 'image/png', sizeBytes: 9 * MIB })).toBeNull();
  });
});

describe('pasting', () => {
  it('turns text of 32 KiB and more into pasted-text.txt, counted in bytes', () => {
    expect(pasteAsFile('')).toBe(false);
    expect(pasteAsFile('x'.repeat(PASTE_AS_FILE_BYTES - 1))).toBe(false);
    expect(pasteAsFile('x'.repeat(PASTE_AS_FILE_BYTES))).toBe(true);
    expect(pasteAsFile('€'.repeat(Math.ceil(PASTE_AS_FILE_BYTES / 3)))).toBe(true);
    expect(pastedTextName([])).toBe('pasted-text.txt');
    expect(pastedTextName(['Pasted-Text.txt', 'pasted-text-2.txt'])).toBe('pasted-text-3.txt');
  });

  it('takes images, and files pasted without words', () => {
    expect(pasteTakesFiles([{ name: 'image.png', type: 'image/png' }], '')).toBe(true);
    expect(pasteTakesFiles([{ name: 'image.png', type: 'image/png' }], 'image.png')).toBe(true);
    expect(pasteTakesFiles([{ name: 'notes.md', type: 'text/markdown' }], '')).toBe(true);
    expect(pasteTakesFiles([], 'hello')).toBe(false);
  });

  it('pastes the words of a file manager’s copy, which carries the file’s path as text', () => {
    expect(pasteTakesFiles([{ name: 'notes.md', type: 'text/markdown' }], '/home/me/notes.md')).toBe(false);
  });
});

describe('sending', () => {
  it('fits an image within 2048 px, renames it as JPEG and uploads it in 4 MiB pieces', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(jpegName('IMG_1.HEIC')).toBe('IMG_1.jpg');
    expect(jpegName('shot')).toBe('shot.jpg');
    expect(pieceOffsets(0)).toEqual([]);
    expect(pieceOffsets(10)).toEqual([0]);
    expect(pieceOffsets(UPLOAD_CHUNK_BYTES * 2 + 1)).toEqual([0, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2]);
    expect(bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('iVBORw==');
    const big = new Uint8Array(100_000).fill(65);
    expect(atob(bytesToBase64(big)).length).toBe(100_000);
    expect(formatBytes(90)).toBe('90 B');
    expect(formatBytes(812 * 1024)).toBe('812 KB');
    expect(formatBytes(2.4 * MIB)).toBe('2.4 MB');
  });

  it('sends only whole uploads, and shows a message’s images apart from its files', () => {
    const done = draft();
    expect(sendable([done, draft({ key: 'b', attachment: null })])).toEqual([done.attachment]);
    const list: Attachment[] = [
      { kind: 'image', label: 'a.png', id: 'att_1' },
      { kind: 'file', label: 'b.csv', id: 'att_2' },
      { kind: 'chart_snapshot', label: 'NQ 1m', reference: 'sha' },
    ];
    const { images, files } = splitAttachments(list);
    expect(images.map((a) => a.label)).toEqual(['a.png']);
    expect(files.map((a) => a.label)).toEqual(['b.csv', 'NQ 1m']);
  });

  it('keeps a message’s attachments in the transcript, and its rows carry them', () => {
    const attachments: Attachment[] = [{ kind: 'image', label: 'a.png', id: 'att_1', mimeType: 'image/png' }];
    const t = reduceTranscript(EMPTY_TRANSCRIPT, {
      sessionId: 'S1',
      seq: 1,
      ts: 0,
      turnId: 'S1-t1',
      event: { type: 'user_message', text: 'What is this?', attachments },
    });
    expect(t.items[0]).toEqual({
      kind: 'user',
      key: '1',
      text: 'What is this?',
      attachments,
      turnId: 'S1-t1',
      steer: false,
    });
    const rows = timelineRows({ transcript: t, waiting: [], settled: true, working: false, open: new Set() });
    expect(rows[0]).toEqual({ kind: 'user', key: '1', text: 'What is this?', attachments });
  });
});
