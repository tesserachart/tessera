import { isWorking, type Activity } from './activity.ts';
import { useAnalystInView } from './focus.ts';
import { useAnalystStatus } from './status.ts';

export interface AnalystAway {
  words: string;
  working: boolean;
  count: number;
  unread: boolean;
}

export function analystAway(
  status: { activity: Activity; count: number; unread: boolean },
  shown: boolean,
): AnalystAway | null {
  const { activity, count, unread } = status;
  if (shown || (!activity.words && count === 0 && !unread)) return null;
  const words = [
    activity.words,
    count > 0 ? `${String(count)} need${count === 1 ? 's' : ''} you` : null,
    !activity.words && count === 0 && unread ? 'Answered' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return { words, working: isWorking(activity), count, unread: unread && count === 0 && !activity.words };
}

export function useAnalystAway(): AnalystAway | null {
  const status = useAnalystStatus();
  return analystAway(status, useAnalystInView());
}
