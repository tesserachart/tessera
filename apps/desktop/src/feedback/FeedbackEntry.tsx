import { RailItem, Tooltip } from '@tessera/ui';
import { FEEDBACK_KEY } from './model.ts';
import { openFeedback, useFeedback } from './store.ts';

export function FeedbackEntry() {
  const open = useFeedback((s) => s.open);
  return (
    <Tooltip content="Send feedback" shortcut={FEEDBACK_KEY} side="right">
      <RailItem icon="feedback" label="Feedback" current={open} data-feedback-entry="" onClick={openFeedback} />
    </Tooltip>
  );
}
