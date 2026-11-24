import './AccountsTile.tsx';
import './AlertsTile.tsx';
import './AnalystTile.tsx';
import './ChartTile.tsx';
import './CopyTile.tsx';
import './DomTile.tsx';
import './IndicatorsTile.tsx';
import './JournalTile.tsx';
import './PositionsTile.tsx';
import './TapeTile.tsx';
import './TradeTile.tsx';
import './UnknownTile.tsx';

export {
  adoptUnknownTiles,
  registeredTileKinds,
  registerTile,
  resolveTileKind,
  restoreUnknownTiles,
  singletonPanelId,
  tileComponents,
  tileDefinition,
  tileDefinitions,
  tileMinWidth,
  tileRoom,
  UNKNOWN_TILE,
  type TileAdd,
  type TileDefinition,
  type TileRegistration,
  type TileSettingsDef,
  type TileSettingsProps,
  type UnknownTileParams,
} from './registry.ts';
