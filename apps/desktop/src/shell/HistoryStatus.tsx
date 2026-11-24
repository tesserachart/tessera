import { Tooltip } from '@tessera/ui';
import { openSettings } from '../areas/settings/store.ts';
import { statusWords } from '../areas/settings/history.ts';
import { useHistoryProgress } from '../areas/settings/useHistory.ts';

export function HistoryStatus() {
  const { progress, acknowledge } = useHistoryProgress();
  if (progress.kind === 'idle') return null;
  const words = statusWords(progress);
  const tip =
    progress.kind === 'running' ? (
      <span className="t-history-lines">
        {progress.lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    ) : (
      'Resume it in Settings › Data'
    );
  return (
    <div className="t-conns t-history">
      <Tooltip content={tip} side="top">
        <button
          type="button"
          className="t-conn"
          data-status={progress.kind}
          aria-label={words.name}
          onClick={() => {
            acknowledge();
            openSettings('data.pulls');
          }}
        >
          <span className="nm">{words.shown}</span>
        </button>
      </Tooltip>
    </div>
  );
}
