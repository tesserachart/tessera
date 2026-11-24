export function endSentence(words: string): string {
  const t = words.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function asSentence(words: string): string {
  const t = words.trim();
  return endSentence(t.charAt(0).toUpperCase() + t.slice(1));
}
