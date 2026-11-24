import { TooltipProvider } from '@tessera/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PASTE_AS_FILE_BYTES } from '../src/analyst/attachments.ts';
import { composerToasts } from '../src/analyst/composerFiles.ts';
import { AgentComposer } from '../src/areas/agents/AgentComposer.tsx';
import { MessageFiles } from '../src/areas/agents/Attachments.tsx';
import { queueView } from './support/queue.ts';

afterEach(() => {
  cleanup();
  composerToasts.clear();
});

const noop = () => undefined;

function composer() {
  return render(
    <TooltipProvider>
      <AgentComposer
        providers={[]}
        pick={null}
        sessionProvider={null}
        reader={{ name: 'Codex', readsPdfs: false }}
        working={false}
        sending={false}
        followUp="steer"
        queue={queueView()}
        onPick={noop}
        onSend={noop}
        onStop={noop}
      />
    </TooltipProvider>,
  );
}

describe('the composer’s attachments', () => {
  it('has Attach files, a hidden file input taking several, and Send off while there is nothing to send', () => {
    const { container } = composer();
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
    const input = container.querySelector<HTMLInputElement>('input[type=file]');
    expect(input?.multiple).toBe(true);
    expect(input?.hidden).toBe(true);
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
  });

  it('turns a long paste into pasted-text.txt and says so', () => {
    composer();
    const text = 'x'.repeat(PASTE_AS_FILE_BYTES);
    const box = screen.getByRole('textbox', { name: 'Ask the analyst' });
    fireEvent.paste(box, { clipboardData: { files: [], getData: () => text } });
    expect(composerToasts.getSnapshot().map((t) => t.title)).toContain('Attached as pasted-text.txt');
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('refuses a PDF for a provider that does not read one, naming it', async () => {
    const { container } = composer();
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    const pdf = new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [pdf] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(composerToasts.getSnapshot().map((t) => t.title)).toContain(
      'Codex does not read PDFs: report.pdf needs a Claude Code session',
    );
  });
});

describe('a sent message’s attachments', () => {
  it('shows its files as rows with their size', () => {
    render(
      <TooltipProvider>
        <MessageFiles
          attachments={[{ kind: 'file', label: 'fills.csv', id: 'att_1', mimeType: 'text/csv', sizeBytes: 2048 }]}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText('fills.csv')).toBeTruthy();
    expect(screen.getByText('2 KB')).toBeTruthy();
  });
});
