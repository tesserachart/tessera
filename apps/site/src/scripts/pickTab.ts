export function pickTab(root: Element | null): void {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } };
  const hint = `${nav.userAgentData?.platform ?? ''} ${navigator.userAgent}`;
  if (!root || nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(hint)) return;
  const platform = /Win/i.test(hint)
    ? 'windows'
    : /Mac/i.test(hint)
      ? 'mac'
      : /Linux|X11|CrOS/i.test(hint)
        ? 'linux'
        : '';
  if (!platform) return;
  for (const tab of root.querySelectorAll('[role="tab"]')) {
    const on = tab.getAttribute('data-platform') === platform;
    tab.setAttribute('aria-selected', String(on));
    tab.setAttribute('tabindex', on ? '0' : '-1');
    const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
    if (panel) panel.hidden = !on;
  }
}
