import type {
  FeedbackApp,
  FeedbackContextOutput,
  FeedbackDelivery,
  FeedbackItem,
  FeedbackKind,
  FeedbackSendInput,
  FeedbackSendOutput,
  FeedbackWriteUpOutput,
} from '@tessera/protocol';

export const FEEDBACK_KEY = 'mod+shift+/';

export const MAX_TEXT = 8000;

export const KINDS: readonly { value: FeedbackKind; label: string }[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' },
  { value: 'other', label: 'Other' },
];

export const PROMPTS: Record<FeedbackKind, string> = {
  bug: 'What happened, and what did you expect?',
  idea: 'What would help, and when would you use it?',
  other: 'What’s on your mind?',
};

export interface Screenshot {
  type: 'image/png' | 'image/jpeg';
  data: string;
  preview: string;
  width: number;
  height: number;
  bytes: number;
}

export interface WriteUp {
  title: string;
  steps: string;
  expected: string;
  actual: string;
  by: string;
}

export interface Draft {
  kind: FeedbackKind;
  text: string;
  removed: readonly string[];
  shot: boolean;
  writeUp: WriteUp | null;
}

export function blankDraft(): Draft {
  return { kind: 'bug', text: '', removed: [], shot: true, writeUp: null };
}

export function keptItems(items: readonly FeedbackItem[], removed: readonly string[]): FeedbackItem[] {
  return items.filter((i) => !removed.includes(i.key));
}

export function toggleRemoved(removed: readonly string[], key: string): string[] {
  return removed.includes(key) ? removed.filter((k) => k !== key) : [...removed, key];
}

export function fromWriteUp(w: FeedbackWriteUpOutput): WriteUp {
  return {
    title: w.title,
    steps: w.steps.join('\n'),
    expected: w.expected,
    actual: w.actual,
    by: w.writer.name,
  };
}

export function stepsOf(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
    .filter((l) => l.length > 0);
}

export function canSend(draft: Draft): boolean {
  const words = draft.text.trim().length > 0 || (draft.writeUp?.title.trim().length ?? 0) > 0;
  return words && draft.text.length <= MAX_TEXT;
}

export function canWriteUp(draft: Draft, context: FeedbackContextOutput | null): boolean {
  return (context?.writer ?? null) !== null && draft.text.trim().length > 0;
}

export function sendInput(
  draft: Draft,
  items: readonly FeedbackItem[],
  screenshot: Screenshot | null,
  app: FeedbackApp,
): FeedbackSendInput {
  const w = draft.writeUp;
  return {
    kind: draft.kind,
    title: w?.title.trim() ? w.title.trim() : null,
    text: draft.text.trim(),
    steps: w ? stepsOf(w.steps) : [],
    expected: w?.expected.trim() ? w.expected.trim() : null,
    actual: w?.actual.trim() ? w.actual.trim() : null,
    writtenUp: w !== null,
    context: keptItems(items, draft.removed),
    screenshot: draft.shot && screenshot ? { type: screenshot.type, data: screenshot.data } : null,
    app,
  };
}

export function deliveryWords(delivery: FeedbackDelivery): string {
  switch (delivery) {
    case 'cloud':
      return 'It goes to the Tessera team as an issue. Nothing leaves until you press Send.';
    case 'signed_out':
      return 'You’re not signed in. It waits on this computer and goes once you sign in.';
    case 'off':
      return 'This build has no Tessera Cloud, so it stays on this computer.';
  }
}

export function queuedWords(n: number): string | null {
  if (n === 0) return null;
  return n === 1
    ? 'One earlier report is still waiting to go.'
    : `${String(n)} earlier reports are still waiting to go.`;
}

export interface GotIt {
  lead: string;
  id: string;
  detail: string;
}

export function gotIt(out: FeedbackSendOutput): GotIt {
  if (out.status === 'sent') {
    return {
      lead: 'Got it. Thank you.',
      id: out.id,
      detail: out.issue ? `The team has it as issue ${String(out.issue.number)}.` : 'The team has it.',
    };
  }
  return {
    lead: 'Got it. It’s saved and goes by itself.',
    id: out.id,
    detail: out.reason ?? deliveryWords(out.delivery),
  };
}

export function sizeWords(bytes: number): string {
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
