const HELD = 32;

const recent = new Map<string, readonly string[]>();

export function noteChartFocus(layoutId: string, tileId: string): void {
  const was = recent.get(layoutId) ?? [];
  recent.set(layoutId, [tileId, ...was.filter((id) => id !== tileId)].slice(0, HELD));
}

export function chartFocusOrder(layoutId: string): readonly string[] {
  return recent.get(layoutId) ?? [];
}

export function successorChart(
  focusOrder: readonly string[],
  docked: readonly string[],
  leaving: string,
): string | null {
  const open = docked.filter((id) => id !== leaving);
  return focusOrder.find((id) => open.includes(id)) ?? open[0] ?? null;
}
