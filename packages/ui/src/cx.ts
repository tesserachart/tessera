import { extendTailwindMerge } from 'tailwind-merge';
import { THEME_KEYS } from './theme.ts';

const merge = extendTailwindMerge({
  extend: {
    theme: {
      color: [...THEME_KEYS.color],
      text: [...THEME_KEYS.text],
      spacing: [...THEME_KEYS.spacing],
      font: [...THEME_KEYS.font],
      'font-weight': [...THEME_KEYS.fontWeight],
      tracking: [...THEME_KEYS.tracking],
      radius: [...THEME_KEYS.radius],
      shadow: [...THEME_KEYS.shadow],
      ease: [...THEME_KEYS.ease],
    },
  },
});

export function cx(...parts: (string | false | null | undefined)[]): string {
  return merge(parts.filter(Boolean).join(' '));
}

export function flag(on: boolean | undefined): '' | undefined {
  return on ? '' : undefined;
}
