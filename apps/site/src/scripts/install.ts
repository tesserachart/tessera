const COPIED_MS = 1600;

function setUp(root: HTMLElement): void {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const choose = (tab: HTMLButtonElement, focus: boolean): void => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls') ?? '');
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => choose(tab, false));
    tab.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(tab);
      const next =
        e.key === 'ArrowRight'
          ? tabs[(i + 1) % tabs.length]
          : e.key === 'ArrowLeft'
            ? tabs[(i - 1 + tabs.length) % tabs.length]
            : e.key === 'Home'
              ? tabs[0]
              : e.key === 'End'
                ? tabs.at(-1)
                : undefined;
      if (!next) return;
      e.preventDefault();
      choose(next, true);
    });
  }

  const live = root.querySelector<HTMLElement>('[data-copied]');
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    let timer = 0;
    button.addEventListener('click', () => {
      void navigator.clipboard.writeText(button.dataset.copy ?? '').then(() => {
        button.textContent = 'Copied';
        if (live) live.textContent = 'Command copied';
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          button.textContent = 'Copy';
          if (live) live.textContent = '';
        }, COPIED_MS);
      });
    });
  }
}

document.querySelectorAll<HTMLElement>('[data-install]').forEach(setUp);
