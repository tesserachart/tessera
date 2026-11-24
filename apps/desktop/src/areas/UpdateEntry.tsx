import { RailItem, Tooltip, type IconName } from '@tessera/ui';
import { appHost } from '../app/services.ts';
import { checkForUpdates, downloadingWords, useRail, type RailView } from '../app/updates.ts';

interface Look {
  readonly icon: IconName;
  readonly label: string;
  readonly name: string;
  readonly progress?: number | null;
}

function lookOf(view: RailView): Look {
  switch (view.kind) {
    case 'rest':
      return { icon: 'update', label: 'Updates', name: 'Check for updates' };
    case 'checking':
      return { icon: 'update', label: 'Checking…', name: 'Checking for updates…' };
    case 'up_to_date':
      return { icon: 'done', label: 'Up to date', name: 'Tessera is up to date' };
    case 'failed':
      return { icon: 'attention', label: 'Try again', name: 'Couldn’t check for updates. Try again' };
    case 'downloading':
      return {
        icon: 'update',
        label: 'Updating',
        name: downloadingWords(view.version, view.fraction),
        progress: view.fraction,
      };
    case 'ready':
      return { icon: 'restart', label: 'Restart', name: `Update ready · Restart to install ${view.version}` };
    case 'update_failed':
      return { icon: 'attention', label: 'Try again', name: `Couldn’t update to ${view.version}. Try again` };
  }
}

function UpdateItem() {
  const view = useRail();
  const look = lookOf(view);
  return (
    <Tooltip content={look.name} side="right">
      <RailItem
        icon={look.icon}
        label={look.label}
        aria-label={look.name}
        aria-busy={view.kind === 'checking' || view.kind === 'downloading' || undefined}
        data-update-entry={view.kind}
        progress={look.progress}
        onClick={() => void checkForUpdates()}
      />
    </Tooltip>
  );
}

export function UpdateEntry() {
  return appHost().updates ? <UpdateItem /> : null;
}
