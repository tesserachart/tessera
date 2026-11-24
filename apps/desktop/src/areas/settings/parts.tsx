import { Select, SettingsRow, SettingsSection, type SelectProps, type SettingsRowProps } from '@tessera/ui';
import type { ReactNode } from 'react';
import { rowWords, sectionWords } from './model.ts';

export function Section({
  id,
  description,
  actions,
  bare,
  children,
}: {
  id: string;
  description?: ReactNode;
  actions?: ReactNode;
  bare?: boolean;
  children?: ReactNode;
}) {
  const w = sectionWords(id);
  return (
    <SettingsSection
      data-setting={id}
      title={w.title}
      description={description ?? w.description}
      actions={actions}
      bare={bare}
      aria-label={w.title}
    >
      {children}
    </SettingsSection>
  );
}

export function Row({ id, label, help, ...rest }: { id: string; label?: ReactNode } & Omit<SettingsRowProps, 'label'>) {
  const w = rowWords(id);
  return <SettingsRow data-setting={id} label={label ?? w.title} help={help ?? w.help} {...rest} />;
}

export function SettingSelect<T extends string = string>(props: Omit<SelectProps<T>, 'align'>) {
  return <Select<T> {...props} align="end" />;
}

export function Fact({ children, code = false }: { children: ReactNode; code?: boolean }) {
  return (
    <span className={code ? 'st-fact st-code' : 'st-fact'} data-selectable>
      {children}
    </span>
  );
}
