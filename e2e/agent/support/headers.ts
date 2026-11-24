export function headerProblems(): string[] {
  const problems: string[] = [];
  const name = (el: Element) =>
    el.getAttribute('aria-label') ?? (el.textContent.trim().slice(0, 30) || (el.getAttribute('class') ?? ''));
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  const rows = [...document.querySelectorAll<HTMLElement>('.dv-tabs-and-actions-container')].filter((r) => {
    const b = r.getBoundingClientRect();
    return b.width > 1 && b.height > 1 && !r.closest('[data-kept]');
  });
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    const where = `${name(row.querySelector('[aria-selected="true"], .dv-active-tab, .dock-tab') ?? row)} at ${String(Math.round(box.width))}px`;
    const parts = [...row.querySelectorAll<HTMLElement>('button, [role="tab"], .dv-tab, .dock-tab-title, .tt')].filter(
      shown,
    );
    for (const el of parts) {
      const r = el.getBoundingClientRect();
      if (r.left < box.left - 1 || r.right > box.right + 1) problems.push(`${where}: ${name(el)} leaves its header`);
      const cx = Math.min(Math.max(r.left + r.width / 2, box.left + 1), box.right - 1);
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (hit && !el.contains(hit) && !hit.contains(el) && !row.contains(hit))
        problems.push(`${where}: ${name(el)} is covered by ${name(hit)}`);
    }
    const items = [
      ...row.querySelectorAll<HTMLElement>(
        '.panel-header-tabs > *, .panel-header > button, .panel-header .dock-actions button, .panel-header-end, .dv-tab, .dv-tabs-overflow-dropdown-default, .dv-left-actions-container button, .dv-right-actions-container button',
      ),
    ].filter((el) => shown(el) && !el.parentElement?.closest('.dv-tab, .dock-tab'));
    for (const [i, a] of items.entries())
      for (const b of items.slice(i + 1)) {
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        if (Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 1)
          problems.push(`${where}: ${name(a)} overlaps ${name(b)}`);
      }
    const active = row.querySelector('.dock-tab[aria-selected="true"]');
    if (active?.hasAttribute('data-squeezed') && box.width >= 160)
      problems.push(`${where}: the active title is shortened`);
    for (const title of row.querySelectorAll<HTMLElement>('.dock-tab-title')) {
      if (!shown(title)) continue;
      const s = getComputedStyle(title);
      if (title.scrollWidth > title.clientWidth + 1 && s.textOverflow !== 'ellipsis')
        problems.push(`${where}: ${name(title)} is cut without an ellipsis`);
    }
  }
  for (const el of document.querySelectorAll('.dv-tab-ghost-drag, .dv-dragged, body > .dv-tab'))
    problems.push(`a drag preview is left on the page: ${name(el)}`);
  for (const el of document.querySelectorAll('.dv-drop-target-anchor, .dv-drop-target-selection'))
    if (shown(el)) problems.push(`a drop overlay is left on the page: ${el.getAttribute('class') ?? ''}`);
  for (const el of document.querySelectorAll<HTMLElement>('.dv-tabs-and-actions-container *')) {
    if (!shown(el) || !el.childNodes.length) continue;
    const font = getComputedStyle(el).fontFamily;
    if (!font.startsWith('"Instrument')) problems.push(`${name(el)} is in ${font}`);
  }
  return [...new Set(problems)];
}
