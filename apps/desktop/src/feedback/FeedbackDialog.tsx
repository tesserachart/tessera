import type { FeedbackItem, FeedbackSendOutput } from '@tessera/protocol';
import { Button, SampleSkeleton, Segmented, Sheet, SheetContent, TextArea, TextInput, cx } from '@tessera/ui';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { afterPaint, useLoadOnceShown } from '../app/onceShown.ts';
import { useAccountList } from '../app/portfolio.ts';
import { APP_COMMIT, APP_VERSION } from '../app/runtime.ts';
import { appHost } from '../app/services.ts';
import { useLatestWrite } from '../app/mutations.ts';
import { failureText, runTool, type ToolInput } from '../app/tools.ts';
import { LEFT_OUT_ATTR, captureWindow, privateWordsOf } from './capture.ts';
import {
  KINDS,
  MAX_TEXT,
  PROMPTS,
  blankDraft,
  canSend,
  canWriteUp,
  deliveryWords,
  fromWriteUp,
  gotIt,
  keptItems,
  queuedWords,
  sendInput,
  sizeWords,
  toggleRemoved,
  type Draft,
  type Screenshot,
  type WriteUp,
} from './model.ts';
import { closeFeedback, useFeedback, type FeedbackFocus } from './store.ts';

type Shot = { kind: 'taking' } | { kind: 'taken'; shot: Screenshot } | { kind: 'failed'; why: string };

type Phase =
  | { kind: 'writing' }
  | { kind: 'sending' }
  | { kind: 'sent'; out: FeedbackSendOutput }
  | { kind: 'failed'; why: string };

function shellKind(): string | null {
  try {
    return appHost().kind === 'tauri' ? 'desktop' : 'browser';
  } catch {
    return null;
  }
}

function app() {
  return { version: APP_VERSION, commit: APP_COMMIT, shell: shellKind() };
}

function useFeedbackContext(open: boolean, opened: number, focus: FeedbackFocus) {
  const read = useLoadOnceShown(
    open ? String(opened) : null,
    () => runTool('feedback.context', { app: app(), ...focus }),
    afterPaint,
  );
  return {
    context: read.kind === 'ready' ? read.value : null,
    failed: read.kind === 'failed' ? failureText(read.error) : null,
  };
}

function useShot(open: boolean, opened: number, wordKey: string): Shot {
  const shot = useLoadOnceShown(
    open ? `${String(opened)}\n${wordKey}` : null,
    () => captureWindow(wordKey ? wordKey.split('\n') : []),
    afterPaint,
  );
  if (shot.kind === 'ready') return { kind: 'taken', shot: shot.value };
  if (shot.kind === 'failed') return { kind: 'failed', why: failureText(shot.error) };
  return { kind: 'taking' };
}

const SAMPLE_ITEMS: readonly FeedbackItem[] = [
  { key: 'chart', label: 'Where', value: 'Desk · Chart NQ Z6 · 5 minutes', detail: null },
  { key: 'app', label: 'Version', value: 'Tessera 0.00.0 · desktop · 0000000', detail: null },
  { key: 'account', label: 'Trading', value: 'Paper 50K · Rithmic Paper Trading', detail: null },
  { key: 'errors', label: 'Errors', value: 'None in the last hour', detail: null },
];

const leaveKept = () => undefined;

function Gathering() {
  return (
    <li className="contents" data-feedback-pending="">
      <SampleSkeleton label="Gathering the details">
        <ul>
          {SAMPLE_ITEMS.map((i) => (
            <Kept key={i.key} item={i} removed={false} onToggle={leaveKept} />
          ))}
        </ul>
      </SampleSkeleton>
    </li>
  );
}

function Kept({ item, removed, onToggle }: { item: FeedbackItem; removed: boolean; onToggle: () => void }) {
  return (
    <li className={cx('fb-item', removed && 'is-removed')} data-feedback-item={item.key}>
      <div className="fb-item-row">
        <span className="fb-item-label">{item.label}</span>
        <span className="fb-item-value">{item.value}</span>
        <Button
          size="s"
          variant="quiet"
          aria-label={removed ? `Put back ${item.label}` : `Remove ${item.label}`}
          onClick={onToggle}
        >
          {removed ? 'Put back' : 'Remove'}
        </Button>
      </div>
      {item.detail && !removed ? (
        <details className="fb-item-detail">
          <summary>Show what is sent</summary>
          <pre>{item.detail}</pre>
        </details>
      ) : null}
    </li>
  );
}

function PictureItem({
  words,
  kept,
  onToggle,
  children,
}: {
  words: string;
  kept: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <li className={cx('fb-item', !kept && 'is-removed')} data-feedback-item="screenshot">
      <div className="fb-item-row">
        <span className="fb-item-label">Picture</span>
        <span className="fb-item-value">{words}</span>
        <Button
          size="s"
          variant="quiet"
          aria-label={kept ? 'Remove the picture' : 'Put back the picture'}
          onClick={onToggle}
        >
          {kept ? 'Remove' : 'Put back'}
        </Button>
      </div>
      {children}
    </li>
  );
}

function pictureWords(width: number, height: number, bytes: number): string {
  return `This window, ${String(width)}×${String(height)}, ${sizeWords(bytes)}. Account numbers are hidden.`;
}

function TakingPicture() {
  return (
    <li className="contents" data-feedback-pending="">
      <SampleSkeleton label="Taking the picture">
        <ul>
          <PictureItem words={pictureWords(1440, 900, 420_000)} kept onToggle={leaveKept}>
            <span
              className="fb-shot"
              style={{ aspectRatio: `${String(window.innerWidth)} / ${String(window.innerHeight)}` }}
              skullet-block=""
            />
          </PictureItem>
        </ul>
      </SampleSkeleton>
    </li>
  );
}

function Picture({ shot, kept, onToggle }: { shot: Shot; kept: boolean; onToggle: () => void }) {
  if (shot.kind === 'taking') return <TakingPicture />;
  if (shot.kind === 'failed') {
    return (
      <li className="fb-item is-removed" data-feedback-item="screenshot">
        <div className="fb-item-row">
          <span className="fb-item-label">Picture</span>
          <span className="fb-item-value">The window couldn’t be pictured: {shot.why}</span>
        </div>
      </li>
    );
  }
  const s = shot.shot;
  return (
    <PictureItem words={pictureWords(s.width, s.height, s.bytes)} kept={kept} onToggle={onToggle}>
      {kept ? <img className="fb-shot" src={s.preview} alt="The picture of the window that is sent" /> : null}
    </PictureItem>
  );
}

function WriteUpFields({ w, onChange, onDrop }: { w: WriteUp; onChange: (w: WriteUp) => void; onDrop: () => void }) {
  return (
    <div className="fb-writeup" data-feedback-writeup="">
      <p className="fb-note">
        {w.by} wrote this from your note and what is attached. Check it before you send.{' '}
        <button type="button" className="fb-link" onClick={onDrop}>
          Drop the write-up
        </button>
      </p>
      <label className="fb-field">
        <span>Title</span>
        <TextInput value={w.title} maxLength={200} onChange={(e) => onChange({ ...w, title: e.target.value })} />
      </label>
      <label className="fb-field">
        <span>Steps, one a line</span>
        <TextArea rows={4} value={w.steps} onChange={(e) => onChange({ ...w, steps: e.target.value })} />
      </label>
      <label className="fb-field">
        <span>Expected</span>
        <TextArea
          rows={2}
          value={w.expected}
          maxLength={2000}
          onChange={(e) => onChange({ ...w, expected: e.target.value })}
        />
      </label>
      <label className="fb-field">
        <span>Actual</span>
        <TextArea
          rows={2}
          value={w.actual}
          maxLength={2000}
          onChange={(e) => onChange({ ...w, actual: e.target.value })}
        />
      </label>
    </div>
  );
}

function GotIt({ out }: { out: FeedbackSendOutput }) {
  const g = gotIt(out);
  const [copied, setCopied] = useState(false);
  return (
    <div className="fb-gotit" role="status" data-feedback-sent={out.status}>
      <p className="fb-lead">{g.lead}</p>
      <p className="fb-id">
        Report <code>{g.id}</code>
        <Button
          size="s"
          variant="quiet"
          onClick={() =>
            void navigator.clipboard
              .writeText(g.id)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </p>
      <p className="fb-note">{g.detail}</p>
    </div>
  );
}

export function FeedbackDialog() {
  const open = useFeedback((s) => s.open);
  const opened = useFeedback((s) => s.opened);
  const focus = useFeedback((s) => s.focus);
  const accounts = useAccountList();
  const wordKey = privateWordsOf(accounts ?? []).join('\n');
  const { context, failed: contextFailed } = useFeedbackContext(open, opened, focus);
  const shot = useShot(open, opened, wordKey);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [phase, setPhase] = useState<Phase>({ kind: 'writing' });
  const upWriter = useLatestWrite((input: ToolInput<'feedback.write_up'>) => runTool('feedback.write_up', input));
  const [whyNotWritten, setWhyNotWritten] = useState<string | null>(null);
  const writing = { busy: upWriter.pending, why: whyNotWritten };
  const upWrite = upWriter.write;
  useEffect(() => () => upWrite.drop(), [opened, upWrite]);
  const [seen, setSeen] = useState(opened);
  if (seen !== opened) {
    setSeen(opened);
    setDraft(blankDraft());
    setPhase({ kind: 'writing' });
    setWhyNotWritten(null);
  }

  const items = context?.items ?? [];
  const screenshot = shot.kind === 'taken' ? shot.shot : null;
  const sending = phase.kind === 'sending';

  const report = useRef(() => sendInput(draft, items, screenshot, app()));
  useLayoutEffect(() => {
    report.current = () => sendInput(draft, items, screenshot, app());
  });
  const deliver = sending && !(draft.shot && shot.kind === 'taking');
  useEffect(() => {
    if (!deliver) return;
    let live = true;
    runTool('feedback.send', report.current())
      .then((out) => live && setPhase({ kind: 'sent', out }))
      .catch((e: unknown) => live && setPhase({ kind: 'failed', why: failureText(e) }));
    return () => {
      live = false;
    };
  }, [deliver]);

  const send = () => {
    if (canSend(draft) && !sending) setPhase({ kind: 'sending' });
  };

  const writeUp = () => {
    if (!canWriteUp(draft, context) || writing.busy) return;
    setWhyNotWritten(null);
    void upWriter.write
      .send({ kind: draft.kind, text: draft.text, context: keptItems(items, draft.removed) })
      .then((reply) => {
        if (reply.kind === 'done') setDraft((d) => ({ ...d, writeUp: fromWriteUp(reply.value) }));
        if (reply.kind === 'failed') setWhyNotWritten(failureText(reply.error));
      });
  };

  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  const sent = phase.kind === 'sent' ? phase.out : null;
  const footer = sent ? (
    <div className="fb-actions">
      <Button variant="primary" onClick={closeFeedback}>
        Close
      </Button>
    </div>
  ) : (
    <div className="fb-actions">
      <Button variant="quiet" onClick={closeFeedback}>
        Cancel
      </Button>
      <Button variant="primary" shortcut="mod+enter" disabled={!canSend(draft) || sending} onClick={send}>
        {sending ? 'Sending…' : 'Send'}
      </Button>
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={(o) => (o ? undefined : closeFeedback())}>
      {open ? (
        <SheetContent
          title="Send feedback"
          side="right"
          size={460}
          className="fb-sheet"
          footer={footer}
          {...{ [LEFT_OUT_ATTR]: '' }}
          onKeyDown={keys}
        >
          {sent ? (
            <GotIt out={sent} />
          ) : (
            <div className="fb-body">
              <Segmented
                label="Kind"
                options={KINDS}
                value={draft.kind}
                onChange={(kind) => setDraft((d) => ({ ...d, kind }))}
              />
              <TextArea
                aria-label="Your note"
                placeholder={PROMPTS[draft.kind]}
                rows={6}
                maxLength={MAX_TEXT}
                spellCheck
                autoFocus
                value={draft.text}
                onChange={(e) => {
                  const text = e.target.value;
                  setDraft((d) => ({ ...d, text }));
                }}
              />
              {context?.writer ? (
                <div className="fb-assist">
                  <Button
                    size="s"
                    disabled={!canWriteUp(draft, context) || writing.busy}
                    onClick={writeUp}
                    what={`with ${context.writer.name}`}
                  >
                    {writing.busy ? 'Writing it up…' : draft.writeUp ? 'Write it up again' : 'Write it up for me'}
                  </Button>
                  {writing.why ? (
                    <span className="fb-error" role="alert">
                      {writing.why}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {draft.writeUp ? (
                <WriteUpFields
                  w={draft.writeUp}
                  onChange={(writeUp) => setDraft((d) => ({ ...d, writeUp }))}
                  onDrop={() => setDraft((d) => ({ ...d, writeUp: null }))}
                />
              ) : null}
              <section className="fb-attached" aria-label="Sent with it">
                <h3 className="fb-head">Sent with it</h3>
                <p className="fb-note">Each line goes as shown. Remove any you’d rather keep.</p>
                <ul>
                  <Picture shot={shot} kept={draft.shot} onToggle={() => setDraft((d) => ({ ...d, shot: !d.shot }))} />
                  {context === null && contextFailed === null ? <Gathering /> : null}
                  {contextFailed ? (
                    <li className="fb-item is-removed">
                      <span className="fb-item-value">The session’s details couldn’t be read: {contextFailed}</span>
                    </li>
                  ) : null}
                  {items.map((i) => (
                    <Kept
                      key={i.key}
                      item={i}
                      removed={draft.removed.includes(i.key)}
                      onToggle={() => setDraft((d) => ({ ...d, removed: toggleRemoved(d.removed, i.key) }))}
                    />
                  ))}
                </ul>
              </section>
              {context ? (
                <p className="fb-note" data-feedback-delivery={context.delivery}>
                  {deliveryWords(context.delivery)} {queuedWords(context.queued) ?? ''}
                </p>
              ) : null}
              {phase.kind === 'failed' ? (
                <p className="fb-error" role="alert">
                  {phase.why}
                </p>
              ) : null}
            </div>
          )}
        </SheetContent>
      ) : null}
    </Sheet>
  );
}
