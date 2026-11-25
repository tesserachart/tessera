import type { Attachment } from '@tessera/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachFiles,
  clearSentFiles,
  composerFiles,
  composerToasts,
  removeFile,
  typedSince,
} from '../src/analyst/composerFiles.ts';
import { answeringClient, setTestServices } from './support/runtime.tsx';

afterEach(() => {
  for (const f of composerFiles()) removeFile(f.key);
  composerToasts.clear();
});

const text = (name: string) => new File(['the 5m chart'], name, { type: 'text/plain' });

const attached = (name: string): Attachment => ({
  id: `up-${name}`,
  label: name,
  mimeType: 'text/plain',
  sizeBytes: 12,
  kind: 'file',
});

describe('what a send leaves in the composer', () => {
  it('keeps what was typed while the message was on its way, and only that', () => {
    expect(typedSince('Why did NQ drop?', 'Why did NQ drop?')).toBe('');
    expect(typedSince('Why did NQ drop?', 'Why did NQ drop? And ES')).toBe('And ES');
    expect(typedSince('Why did NQ drop?', 'Something else')).toBe('Something else');
  });

  it('takes away only the files it sent, never one added while it was on its way', async () => {
    setTestServices(
      answeringClient({
        'agent.upload_attachment': (input) => ({
          uploadId: `u-${input.name}`,
          received: input.sizeBytes,
          attachment: attached(input.name),
        }),
      }).client,
    );
    await attachFiles([text('levels.txt')], null);
    await vi.waitFor(() => expect(composerFiles()[0]?.attachment).not.toBeNull());
    const sent = composerFiles();
    await attachFiles([text('notes.txt')], null);
    clearSentFiles(sent);
    expect(composerFiles().map((f) => f.name)).toEqual(['notes.txt']);
  });
});

describe('an upload that never ends in an attachment', () => {
  it('leaves the tray and says the file was not attached, instead of waiting for ever', async () => {
    setTestServices(
      answeringClient({
        'agent.upload_attachment': (input) => ({ uploadId: 'u-1', received: input.sizeBytes, attachment: null }),
      }).client,
    );
    await attachFiles([text('levels.txt')], null);
    await vi.waitFor(() => expect(composerFiles()).toEqual([]));
    expect(composerToasts.getSnapshot().map((t) => t.title)).toContain('levels.txt was not attached');
  });
});
