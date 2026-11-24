import type { Delivery, SessionMode } from '@tessera/protocol';
import {
  Icon,
  ToastStack,
  Tooltip,
  cx,
  formatShortcut,
  matchesShortcut,
  modifierLabel,
  usePlatform,
  type IconName,
} from '@tessera/ui';
import { useEffect, useLayoutEffect, useRef, type ClipboardEvent } from 'react';
import { pasteAsFile, pasteTakesFiles, sendBlock, type Reader } from '../../analyst/attachments.ts';
import { alternateOf, dispatchMode, type Dispatch } from '../../analyst/dispatch.ts';
import { attachFiles, attachPastedText, composerToasts, useComposerFiles } from '../../analyst/composerFiles.ts';
import { registerComposer } from '../../shell/composer.ts';
import { STOP_KEY } from '../../shell/keys.ts';
import { useUi, setComposerDraft } from '../../state/ui.ts';
import { ComposerTray } from './Attachments.tsx';
import { useFitRow, useModifierHeld } from './composerFoot.ts';
import { QueuedMessages } from './QueuedMessages.tsx';
import type { QueueView } from './useChat.ts';
import { ModePicker } from './ModePicker.tsx';
import { EffortMenu, ModelPicker } from './ModelPicker.tsx';
import type { ModelPick, ProviderView } from './models.ts';
import { setProviderEnabled } from './providers.ts';
import './agents.css';

const MAX_PX = 240;

const ALTERNATE_KEY = 'mod+enter';

const SEND: Record<Dispatch, { label: string; icon: IconName }> = {
  start: { label: 'Send', icon: 'send' },
  steer: { label: 'Steer message', icon: 'steer' },
  queue: { label: 'Queue message', icon: 'queue' },
};

function fitHeight(t: HTMLTextAreaElement): void {
  t.style.height = 'auto';
  t.style.height = `${String(Math.min(t.scrollHeight, MAX_PX))}px`;
}

export function AgentComposer({
  providers,
  pick,
  sessionProvider,
  reader,
  working,
  sending,
  followUp,
  queue,
  onPick,
  onSend,
  onStop,
  mode = null,
  onMode,
  placeholder,
  narrow = false,
  dropping = false,
}: {
  providers: readonly ProviderView[];
  pick: ModelPick | null;
  sessionProvider: string | null;
  reader: Reader | null;
  working: boolean;
  sending: boolean;
  followUp: Delivery;
  queue: QueueView;
  onPick: (pick: ModelPick) => void;
  onSend: (alternate: boolean) => void;
  onStop: () => void;
  mode?: SessionMode | null;
  onMode?: (mode: SessionMode) => void;
  placeholder?: string;
  narrow?: boolean;
  dropping?: boolean;
}) {
  const draft = useUi((s) => s.composerDraft);
  const files = useComposerFiles();
  const el = useRef<HTMLTextAreaElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const foot = useRef<HTMLDivElement | null>(null);
  useFitRow(foot);
  useLayoutEffect(() => {
    if (el.current) fitHeight(el.current);
  }, [draft]);
  useEffect(() => {
    const t = el.current;
    if (!t || typeof ResizeObserver === 'undefined') return;
    let width = t.clientWidth;
    const resized = new ResizeObserver(() => {
      if (t.clientWidth === width) return;
      width = t.clientWidth;
      fitHeight(t);
    });
    resized.observe(t);
    return () => resized.disconnect();
  }, []);
  const platform = usePlatform();
  const modifier = useModifierHeld(working);
  const editing = queue.editing !== null;
  const block = editing ? null : sendBlock(files, reader);
  const empty = editing ? !draft.trim() : !draft.trim() && files.length === 0;
  const dispatch = dispatchMode({ running: working, followUp, alternate: modifier });
  const resume = queue.held && !working && empty && !editing;
  const mod = modifierLabel('mod', platform);
  const sendTip = editing
    ? 'Update queued message'
    : (block ??
      (working
        ? `Click to ${followUp}, ${mod}-click or ${formatShortcut(ALTERNATE_KEY, platform)} to ${alternateOf(followUp)}`
        : 'Send'));
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(e.clipboardData.files);
    const text = e.clipboardData.getData('text/plain');
    if (pasteTakesFiles(pasted, text)) {
      e.preventDefault();
      void attachFiles(pasted, reader);
    } else if (pasteAsFile(text)) {
      e.preventDefault();
      void attachPastedText(text, reader);
    }
  };
  return (
    <form
      className={cx('ag-compose', narrow && 'is-narrow', dropping && 'is-dropping')}
      onSubmit={(e) => {
        e.preventDefault();
        onSend(false);
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          el.current?.focus();
        }
      }}
    >
      <ToastStack queue={composerToasts} label="Composer notices" className="ag-compose-toasts" />
      <QueuedMessages queue={queue} />
      {editing ? null : <ComposerTray files={files} reader={reader} />}
      <textarea
        ref={(node) => {
          el.current = node;
          const off = registerComposer(node);
          return () => {
            off();
            el.current = null;
          };
        }}
        rows={1}
        aria-label="Ask the analyst"
        placeholder={placeholder ?? (providers.some((p) => p.ready) ? 'Ask, or type an order' : 'Ask the analyst')}
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(e) => setComposerDraft(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && editing) {
            e.preventDefault();
            queue.cancelEdit();
            return;
          }
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          onSend(matchesShortcut(e.nativeEvent, ALTERNATE_KEY, platform));
        }}
      />
      <div ref={foot} className="ag-compose-foot">
        {editing ? null : (
          <Tooltip content="Attach files" side="top">
            <button
              type="button"
              className="ag-attach"
              aria-label="Attach files"
              onClick={() => picker.current?.click()}
            >
              <Icon name="attach" />
            </button>
          </Tooltip>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (picked.length > 0) void attachFiles(picked, reader);
          }}
        />
        {mode && onMode ? <ModePicker mode={mode} onMode={onMode} /> : null}
        <ModelPicker
          providers={providers}
          pick={pick}
          sessionProvider={sessionProvider}
          onPick={onPick}
          onTurnOn={(id) => void setProviderEnabled(id, true)}
        />
        <EffortMenu providers={providers} pick={pick} onPick={onPick} />
        {working ? (
          <Tooltip content="Stop" shortcut={STOP_KEY} side="top">
            <button type="button" className={cx('ag-stop', !empty && 'is-beside')} onClick={onStop} aria-label="Stop">
              <Icon name="stop" />
            </button>
          </Tooltip>
        ) : null}
        {resume ? (
          <Tooltip content="Send the queued messages, in order" side="top">
            <button type="button" className="ag-send" aria-label="Resume queue" onClick={queue.resume}>
              <Icon name="play" />
            </button>
          </Tooltip>
        ) : working && empty ? null : (
          <Tooltip content={sendTip} shortcut={block || working ? undefined : 'enter'} side="top">
            <button
              type="submit"
              className="ag-send"
              aria-label={editing ? 'Update queued message' : SEND[dispatch].label}
              disabled={empty || sending || block !== null}
              onClick={(e) => {
                e.preventDefault();
                onSend(e.metaKey || e.ctrlKey);
              }}
            >
              <Icon name={editing ? 'done' : SEND[dispatch].icon} />
            </button>
          </Tooltip>
        )}
      </div>
    </form>
  );
}
