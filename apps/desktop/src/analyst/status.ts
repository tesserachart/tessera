import { analystActivity, needsYouCount, type Activity } from './activity.ts';
import { useAnalyst, useCurrentSession, useCurrentTranscript } from './analystStore.ts';

export const TAB_MAX_PX = 240;

export function useAnalystStatus(): { activity: Activity; count: number; unread: boolean } {
  const session = useCurrentSession();
  const transcript = useCurrentTranscript();
  const approvals = useAnalyst((s) => s.approvals);
  const sessions = useAnalyst((s) => s.sessions);
  const unread = useAnalyst((s) => s.unread);
  return {
    activity: analystActivity(transcript, session),
    count: needsYouCount(approvals ?? [], sessions ?? []),
    unread,
  };
}
