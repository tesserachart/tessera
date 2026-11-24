import { Button, SettingsRow, SettingsSection } from '@tessera/ui';
import { SECTIONS, type RowDef, type SectionDef, type SettingsCategory } from './model.ts';

function sampleRows(section: SectionDef): readonly RowDef[] {
  if (section.rows?.length) return section.rows;
  return [{ id: section.id, title: section.title, help: section.description }];
}

export function CategorySample({ category }: { category: SettingsCategory }) {
  return (
    <div className="st-col" data-category={category}>
      {SECTIONS[category].map((section) => (
        <SettingsSection key={section.id} title={section.title} description={section.description}>
          {sampleRows(section).map((row) => (
            <SettingsRow key={row.id} label={row.title} help={row.help}>
              <Button size="s" tabIndex={-1}>
                Default
              </Button>
            </SettingsRow>
          ))}
        </SettingsSection>
      ))}
    </div>
  );
}
