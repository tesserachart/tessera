import type { ContextEntry, FeedbackKind, FiledReport } from './feedback.ts';

const MAX_TITLE = 256;
export const MAX_BODY = 65_000;
export const TRIMMED = '(trimmed)';

const WORD_JOINER = '\u2060';
const ZERO_WIDTH_SPACE = '\u200b';

const KINDS: Record<FeedbackKind, string> = { bug: 'Bug', idea: 'Idea', other: 'Other' };

export interface IssueDraft {
  title: string;
  body: string;
}

export function feedbackIssue(report: FiledReport, screenshotUrl: string | null): IssueDraft {
  return { title: issueTitle(report), body: issueBody(report, screenshotUrl) };
}

function issueTitle(report: FiledReport): string {
  const title = `${KINDS[report.kind]}: ${unlinked(report.title.replace(/\s+/g, ' ').trim())}`;
  return title.slice(0, MAX_TITLE).replace(/[\uD800-\uDBFF]$/, '');
}

function issueBody(report: FiledReport, screenshotUrl: string | null): string {
  const lengths = report.context.map((entry) => entry.detail?.length ?? 0);
  let cap = Infinity;
  for (;;) {
    const body = render(report, screenshotUrl, cap);
    if (body.length <= MAX_BODY) return body;
    const next = capFor(
      lengths.map((length) => Math.min(length, cap)),
      body.length - MAX_BODY,
    );
    if (next >= cap || cap === 0) return body.slice(0, MAX_BODY - TRIMMED.length - 2) + `\n\n${TRIMMED}`;
    cap = next;
  }
}

function capFor(lengths: readonly number[], excess: number): number {
  const sorted = [...lengths].sort((a, b) => b - a);
  let removed = 0;
  for (const [index, length] of sorted.entries()) {
    const next = sorted[index + 1] ?? 0;
    const width = index + 1;
    const available = (length - next) * width;
    if (removed + available >= excess) return Math.max(0, length - Math.ceil((excess - removed) / width));
    removed += available;
  }
  return 0;
}

function render(report: FiledReport, screenshotUrl: string | null, cap: number): string {
  const sections: string[] = [
    [
      `**${KINDS[report.kind]}**`,
      `Tessera ${prose(report.appVersion)}`,
      `report \`${report.id}\``,
      `reporter \`${report.reporter}\``,
      prose(report.createdAt),
    ].join(' · '),
  ];
  if (report.text.trim() !== '') sections.push(quote(report.text));
  if (report.steps.length > 0) {
    sections.push(
      '### Steps',
      report.steps.map((step, index) => `${String(index + 1)}. ${prose(oneLine(step))}`).join('\n'),
    );
  }
  if (report.expected !== null && report.expected.trim() !== '') sections.push('### Expected', prose(report.expected));
  if (report.actual !== null && report.actual.trim() !== '') sections.push('### Actual', prose(report.actual));
  if (report.writtenUp) {
    sections.push("_The reporter's own agent wrote this up from their note; they reviewed it before sending._");
  }
  if (screenshotUrl !== null) sections.push('### Screenshot', `![Screenshot](${screenshotUrl})`);
  if (report.context.length > 0) sections.push('### Context', contextTable(report.context));
  for (const entry of report.context) {
    if (entry.detail !== null) sections.push(details(entry, entry.detail, cap));
  }
  return sections.join('\n\n') + '\n';
}

function contextTable(context: readonly ContextEntry[]): string {
  const rows = context.map((entry) => `| ${cell(entry.label)} | ${cell(entry.value)} |`);
  return ['| | |', '| --- | --- |', ...rows].join('\n');
}

function details(entry: ContextEntry, detail: string, cap: number): string {
  const trimmed = detail.length > cap;
  const shown = trimmed ? detail.slice(0, cap) : detail;
  return [
    `<details><summary>${prose(oneLine(entry.label)) || entry.key}</summary>`,
    '',
    '```text',
    fenced(shown),
    '```',
    ...(trimmed ? ['', TRIMMED] : []),
    '',
    '</details>',
  ].join('\n');
}

function quote(text: string): string {
  return prose(text)
    .split(/\r?\n/)
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

function cell(text: string): string {
  return prose(text).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ');
}

function unlinked(text: string): string {
  return text
    .replace(/@/g, `@${WORD_JOINER}`)
    .replace(/#(?=\d)/g, `#${WORD_JOINER}`)
    .replace(/\b(GH)-(?=\d)/gi, `$1-${WORD_JOINER}`);
}

function prose(text: string): string {
  return unlinked(text.replace(/</g, '&lt;').replace(/>/g, '&gt;')).replace(/`(?=``)/g, `\`${ZERO_WIDTH_SPACE}`);
}

function fenced(text: string): string {
  return text.replace(/`(?=``)/g, `\`${ZERO_WIDTH_SPACE}`);
}
