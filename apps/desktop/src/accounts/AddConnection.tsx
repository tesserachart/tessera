import {
  Button,
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  SettingsSection,
  Sheet,
} from '@tessera/ui';
import { useHasTool } from '../app/tools.ts';
import { askAnalyst } from '../shell/tradeActions.ts';
import { RITHMIC, focusConnections, openConnectionDialog, useAccountsUi } from './accountsUi.ts';
import { LoginForm } from './ConnectionSetup.tsx';
import { LevelSourceSheet } from './LevelSourceSheet.tsx';
import { addConnection, openConnection } from './navigate.ts';
import { ADD_WITH_ANALYST } from './providers.ts';
import { useHasUserConnectionTools } from './useConnections.ts';

const close = () => openConnectionDialog(null);

export function ConnectionForms() {
  const dialog = useAccountsUi((s) => s.dialog);
  return (
    <Sheet open={dialog?.kind === 'levels'} onOpenChange={(o) => (o ? undefined : close())}>
      {dialog?.kind === 'levels' ? <LevelSourceSheet id={dialog.id} draft={dialog.draft} onDone={close} /> : null}
    </Sheet>
  );
}

export function AddConnection() {
  const canAdd = useHasUserConnectionTools();
  const hasLevels = useHasTool('intel.list_sources');
  if (!canAdd) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="s" variant="primary">
          <Icon name="plus" />
          Add connection
          <Icon name="chevron-down" />
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem onSelect={() => addConnection(RITHMIC)} hint="Prices, depth, accounts, orders">
          Rithmic…
        </MenuItem>
        {hasLevels ? (
          <>
            <MenuSeparator />
            <MenuLabel>Levels</MenuLabel>
            <MenuItem onSelect={() => askAnalyst(ADD_WITH_ANALYST)} hint="From its docs or a sample">
              Any API, with the analyst…
            </MenuItem>
            <MenuItem onSelect={() => openConnectionDialog({ kind: 'levels' })} hint="Form or JSON">
              Write a spec…
            </MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

export function AddForm({ provider }: { provider: string }) {
  const done = () => focusConnections(null);
  if (provider === RITHMIC)
    return (
      <SettingsSection data-setting="connections.add" title="Add a Rithmic login" aria-label="Add a Rithmic login" bare>
        <div className="t-set-card st-conn-add">
          <LoginForm
            mode="new"
            onDone={(c) => {
              done();
              openConnection(c.id);
            }}
            onCancel={done}
          />
        </div>
      </SettingsSection>
    );
  return null;
}
