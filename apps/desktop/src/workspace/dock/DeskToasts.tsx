import {
  Icon,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  PrivateScope,
  useToasts,
  type ToastItem,
} from '@tessera/ui';
import { Fragment, useEffect, useState } from 'react';
import { deskToasts } from './deskToasts.ts';

export function DeskToasts() {
  const list = useToasts(deskToasts).filter((t) => t.state === 'open');
  const latest = list.at(-1);
  return latest ? (
    <PrivateScope>
      <Notices list={list} latest={latest} />
    </PrivateScope>
  ) : null;
}

function Notices({ list, latest }: { list: readonly ToastItem[]; latest: ToastItem }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = open || hovered || focused;
  useEffect(() => {
    if (held) deskToasts.pause();
    else deskToasts.resume();
    return () => deskToasts.resume();
  }, [held]);
  const full = [latest.title, latest.detail].filter(Boolean).join(' · ');
  return (
    <div
      className="desk-toasts"
      data-private=""
      aria-label="Desk notices"
      data-tone={latest.tone}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
    >
      <Icon name={latest.tone === 'err' ? 'attention' : latest.tone === 'info' ? 'note' : 'done'} className="tone" />
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger asChild>
          <button type="button" className="desk-notice-summary" title={full} aria-label={`Notice details: ${full}`}>
            <span className="desk-notice-text" role={latest.tone === 'err' ? 'alert' : 'status'} aria-atomic="true">
              {full}
            </span>
            {list.length > 1 ? <span className="desk-notice-count">{list.length}</span> : null}
            <Icon name="chevron-up" />
          </button>
        </MenuTrigger>
        <MenuContent
          side="top"
          align="end"
          className="desk-notice-menu"
          aria-label="Current notices"
          aria-labelledby={undefined}
        >
          {list.toReversed().map((t, i) => (
            <Fragment key={t.id}>
              {i > 0 ? <MenuSeparator /> : null}
              <MenuLabel className="desk-notice-detail" id={`desk-notice-${String(t.id)}`}>
                <b>{t.title}</b>
                {t.detail ? <span>{t.detail}</span> : null}
              </MenuLabel>
              {t.action ? (
                <MenuItem aria-describedby={`desk-notice-${String(t.id)}`} onSelect={() => deskToasts.act(t.id)}>
                  {t.action.label}
                </MenuItem>
              ) : null}
              <MenuItem
                aria-label={`Dismiss ${t.title}`}
                aria-describedby={`desk-notice-${String(t.id)}`}
                onSelect={() => deskToasts.dismiss(t.id)}
              >
                Dismiss
              </MenuItem>
            </Fragment>
          ))}
        </MenuContent>
      </Menu>
      {latest.action ? (
        <button type="button" className="desk-notice-action" onClick={() => deskToasts.act(latest.id)}>
          {latest.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="desk-notice-dismiss"
        aria-label={`Dismiss ${latest.title}`}
        onClick={() => deskToasts.dismiss(latest.id)}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
