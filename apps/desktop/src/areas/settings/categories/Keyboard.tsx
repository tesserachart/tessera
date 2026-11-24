import { Key, SettingsRow } from '@tessera/ui';
import type { Command } from '../../../commands/registry.ts';
import { useKeyedCommands } from '../hooks.ts';
import { commandRow } from '../words.ts';
import { Section } from '../parts.tsx';

export function KeyboardSection() {
  const keyed = useKeyedCommands();
  const groups = new Map<string, Command[]>();
  for (const c of keyed) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  return (
    <Section id="app.keyboard" bare>
      {[...groups].map(([group, list]) => (
        <div key={group} className="st-keys">
          <h3 className="st-sub">{group}</h3>
          <div className="t-set-card">
            {list.map((c) => (
              <SettingsRow key={c.id} className="st-key" data-setting={commandRow(c.id)} label={c.title}>
                <Key shortcut={c.shortcut!} />
              </SettingsRow>
            ))}
          </div>
        </div>
      ))}
    </Section>
  );
}
