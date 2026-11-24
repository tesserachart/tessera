import { Button } from '@tessera/ui';
import { openExternal } from '../../app/host.ts';

export function InstallButton({ url, name, download = false }: { url: string; name: string; download?: boolean }) {
  return (
    <Button
      size="s"
      variant="quiet"
      aria-label={download ? `Download ${name}` : `How to install ${name}`}
      onClick={() => void openExternal(url).catch(() => undefined)}
    >
      {download ? 'Download' : 'How to install'}
    </Button>
  );
}
