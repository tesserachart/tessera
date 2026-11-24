import type { TileSpec } from '@tessera/bridge';
import { LoadingProvider, PlatformProvider, TooltipProvider, detectPlatform } from '@tessera/ui';
import { TileWindow } from './TileWindow.tsx';
import { windowTileKind } from './windowKind.ts';
import { tileDefinition } from '../workspace/tiles/registry.ts';
import { Splash } from '../shell/Splash.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { Shell } from '../shell/Shell.tsx';
import type { AppServices } from './services.ts';
import { RuntimeProvider } from './RuntimeProvider.tsx';
import { useConnection } from './runtimeContext.ts';

function Gate({ tile }: { tile: Omit<TileSpec, 'width' | 'height'> | null }) {
  const conn = useConnection();
  if (!conn.everConnected) return <Splash />;
  const def = tile ? tileDefinition(windowTileKind(tile.kind)) : null;
  if (tile && def)
    return (
      <ErrorBoundary name={def.title}>
        <TileWindow tile={tile} />
      </ErrorBoundary>
    );
  return <Shell />;
}

export interface AppProps {
  services: AppServices;
  tile: Omit<TileSpec, 'width' | 'height'> | null;
}

export function App({ services, tile }: AppProps) {
  return (
    <RuntimeProvider services={services}>
      <PlatformProvider value={detectPlatform()}>
        <TooltipProvider>
          <LoadingProvider>
            <Gate tile={tile} />
          </LoadingProvider>
        </TooltipProvider>
      </PlatformProvider>
    </RuntimeProvider>
  );
}
