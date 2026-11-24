import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import { Key } from './Key.tsx';

export type MenuIcon = IconName | ReactElement;

export function MenuLead({ icon }: { icon: MenuIcon | undefined }) {
  if (icon === undefined) return null;
  return (
    <span className="t-menu-lead" aria-hidden="true">
      {isValidElement(icon) ? icon : <Icon name={icon} />}
    </span>
  );
}

export function MenuRowEnd({ hint, shortcut }: { hint?: ReactNode; shortcut?: string | undefined }) {
  return (
    <>
      {hint ? <span className="r">{hint}</span> : null}
      {shortcut ? <Key shortcut={shortcut} /> : null}
    </>
  );
}

export function MenuMark() {
  return <span className="t-menu-mark" aria-hidden="true" />;
}

export function MenuSubChevron() {
  return <Icon name="chevron-right" className="sub" />;
}
