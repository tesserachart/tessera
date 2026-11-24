export const ns = (ms: number): number => ms * 1e6;

export const nsAt = (iso: string): number => ns(Date.parse(iso));
