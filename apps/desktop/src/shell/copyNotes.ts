import { useTopicEffect } from '../app/useTopic.ts';
import { deskToasts } from '../workspace/dock/deskToasts.ts';

export function useCopyNotes(): void {
  useTopicEffect('copy.notes', {}, (n) => {
    deskToasts.push({ tone: n.tone === 'err' ? 'err' : 'info', title: n.title, detail: n.detail });
  });
}
