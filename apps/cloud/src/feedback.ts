import { z } from 'zod';

export const MAX_FEEDBACK_BYTES = 12 * 1024 * 1024;
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

const ContextItem = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.]{0,39}$/),
  label: z.string().max(60),
  value: z.string().max(500),
  detail: z
    .string()
    .max(40000)
    .nullish()
    .transform((detail) => detail ?? null),
});

const Screenshot = z.object({
  type: z.enum(['image/png', 'image/jpeg']),
  data: z.base64().min(4),
});

export const FeedbackRequest = z.object({
  id: z.string().regex(/^fb-[a-z0-9]{8,40}$/),
  kind: z.enum(['bug', 'idea', 'other']),
  title: z.string().min(1).max(200),
  text: z.string().max(8000),
  steps: z.array(z.string().max(500)).max(20).default([]),
  expected: z
    .string()
    .max(2000)
    .nullish()
    .transform((expected) => expected ?? null),
  actual: z
    .string()
    .max(2000)
    .nullish()
    .transform((actual) => actual ?? null),
  written_up: z.boolean().default(false),
  context: z.array(ContextItem).max(20).default([]),
  screenshot: Screenshot.nullish().transform((screenshot) => screenshot ?? null),
  app_version: z.string().min(1).max(64),
  created_at: z.iso.datetime({ offset: true }),
});

export type FeedbackKind = z.infer<typeof FeedbackRequest>['kind'];
export type ContextEntry = z.infer<typeof ContextItem>;
type Screenshot = z.infer<typeof Screenshot>;

export interface FiledReport {
  id: string;
  kind: FeedbackKind;
  title: string;
  text: string;
  steps: string[];
  expected: string | null;
  actual: string | null;
  writtenUp: boolean;
  context: ContextEntry[];
  screenshot: Screenshot | null;
  appVersion: string;
  createdAt: string;
  reporter: string;
}

export interface FiledIssue {
  number: number;
  url: string;
}

export interface IssueTracker {
  file(report: FiledReport): Promise<FiledIssue>;
}

export class IssueTrackerFailed extends Error {
  override name = 'IssueTrackerFailed';
  constructor(
    readonly status: number,
    readonly step: string,
  ) {
    super(`issue tracker refused ${step}: ${String(status)}`);
  }
}

export function filedReport(request: z.infer<typeof FeedbackRequest>, reporter: string): FiledReport {
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    text: request.text,
    steps: request.steps,
    expected: request.expected,
    actual: request.actual,
    writtenUp: request.written_up,
    context: request.context,
    screenshot: request.screenshot,
    appVersion: request.app_version,
    createdAt: request.created_at,
    reporter,
  };
}

export function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

export function parseJson(raw: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}
