import { matchesShortcut, parseShortcut, type KeyEventLike, type ParsedShortcut, type Platform } from '@tessera/ui';

export type FocusZone = 'global' | 'chart' | 'agent' | 'sidebar' | 'palette' | 'table' | 'dom' | 'tape' | 'ticket';

export interface Command {
  id: string;
  title: string;
  group: string;
  keywords?: readonly string[];
  shortcut?: string;
  zone?: FocusZone;
  allowInInput?: boolean;
  once?: boolean;
  hidden?: boolean;
  hint?: () => string | null;
  when?: () => boolean;
  unavailable?: () => string | null;
  run: () => void | Promise<void>;
}

export interface CommandMatch {
  command: Command;
  score: number;
}

interface Entry {
  command: Command;
  shortcut: ParsedShortcut | null;
}

export class CommandRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  register(command: Command): () => void {
    if (this.entries.has(command.id)) throw new Error(`command "${command.id}" is already registered`);
    const shortcut = command.shortcut ? parseShortcut(command.shortcut) : null;
    this.entries.set(command.id, { command, shortcut });
    this.changed();
    return () => {
      if (this.entries.get(command.id)?.command === command) {
        this.entries.delete(command.id);
        this.changed();
      }
    };
  }

  registerAll(commands: readonly Command[]): () => void {
    const offs = commands.map((c) => this.register(c));
    return () => {
      for (const off of offs) off();
    };
  }

  get(id: string): Command | null {
    return this.entries.get(id)?.command ?? null;
  }

  isEnabled(id: string): boolean {
    const c = this.get(id);
    return c ? (c.when?.() ?? true) : false;
  }

  run(id: string): boolean {
    const c = this.get(id);
    if (!c || !(c.when?.() ?? true)) return false;
    const r = c.run();
    if (r instanceof Promise) r.catch((err: unknown) => console.error(`[commands] ${id} failed`, err));
    return true;
  }

  all(): Command[] {
    return [...this.entries.values()].map((e) => e.command);
  }

  list(): Command[] {
    return [...this.entries.values()].map((e) => e.command).filter((c) => !c.hidden);
  }

  search(query: string): CommandMatch[] {
    const q = query.trim().toLowerCase();
    const out: CommandMatch[] = [];
    for (const c of this.list()) {
      const score = q ? scoreCommand(c, q) : 1;
      if (score > 0) out.push({ command: c, score });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  handleKey(
    event: KeyEventLike & { repeat?: boolean },
    zone: FocusZone,
    platform: Platform,
    inInput: boolean,
  ): string | null {
    let fallback: Command | null = null;
    for (const { command, shortcut } of this.entries.values()) {
      if (!shortcut || !matchesShortcut(event, shortcut, platform)) continue;
      const cz = command.zone ?? 'global';
      if (cz !== 'global' && cz !== zone) continue;
      if (inInput && !command.allowInInput) continue;
      if (!(command.when?.() ?? true)) continue;
      if (command.once && event.repeat) return command.id;
      if (cz === zone && cz !== 'global') {
        this.run(command.id);
        return command.id;
      }
      fallback ??= command;
    }
    if (fallback) {
      this.run(fallback.id);
      return fallback.id;
    }
    return null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }
}

export function scoreCommand(c: Pick<Command, 'title' | 'group' | 'keywords'>, q: string): number {
  const title = c.title.toLowerCase();
  if (title === q) return 100;
  if (c.keywords?.some((k) => k.toLowerCase() === q)) return 90;
  if (title.startsWith(q)) return 80;
  if (title.split(/[\s·/]+/).some((w) => w.startsWith(q))) return 60;
  if (title.includes(q)) return 40;
  const group = c.group.toLowerCase();
  if (group.startsWith(q)) return 30;
  if (c.keywords?.some((k) => k.toLowerCase().startsWith(q))) return 25;
  if (isSubsequence(q, title)) return 10;
  return 0;
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
}

export function zoneOf(el: Element | null): FocusZone {
  const z = el?.closest('[data-focus-zone]')?.getAttribute('data-focus-zone');
  return (z as FocusZone | null) ?? 'global';
}

export function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(el.type);
  return (el as HTMLElement).isContentEditable;
}

export const commands = new CommandRegistry();
