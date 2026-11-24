import { openSettings } from '../areas/settings/store.ts';
import { RITHMIC, focusConnections, type LoginMode } from './accountsUi.ts';

export const connectionTarget = (id: string) => `connections.${id}`;

export function openConnections(): void {
  openSettings('connections');
}

export function addConnection(provider: string = RITHMIC): void {
  openSettings(`connections.add.${provider}`);
}

export function openConnection(id: string, login: LoginMode | null = null): void {
  if (login) focusConnections({ kind: 'edit', id, login });
  openSettings(connectionTarget(id));
}

export function openExchanges(): void {
  openSettings('connections.exchanges');
}
