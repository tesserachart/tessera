export const FLAGS = {
  'analyst-trading-sessions': {
    fallback: true,
    about: 'The analyst trades whole sessions on its own (Settings › Analyst › Trading sessions).',
  },
} as const satisfies Record<string, { fallback: boolean | string; about: string }>;

export type FlagKey = keyof typeof FLAGS;
