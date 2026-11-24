import type { TelemetrySurvey } from '@tessera/protocol';
import { useState } from 'react';
import { defaultStorage } from './store.ts';
import { track, useTelemetryConfig } from './telemetry.ts';

const SEEN = 'tessera.survey.';

function seen(id: string): boolean {
  return (defaultStorage()?.getItem(SEEN + id) ?? null) !== null;
}

function markSeen(id: string, how: 'sent' | 'dismissed'): void {
  defaultStorage()?.setItem(SEEN + id, how);
}

export function useDueSurvey(): { survey: TelemetrySurvey | null; send: Send; dismiss: () => void } {
  const config = useTelemetryConfig();
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const survey = config?.surveys.find((s) => !done.has(s.id) && !seen(s.id)) ?? null;
  const close = (id: string, how: 'sent' | 'dismissed') => {
    markSeen(id, how);
    setDone((d) => new Set(d).add(id));
  };
  return {
    survey,
    send: (answers) => {
      if (!survey) return;
      const responses = Object.fromEntries(
        survey.questions.flatMap((q) => {
          const a = answers[q.id]?.trim();
          return a ? [[`$survey_response_${q.id}`, a] as const] : [];
        }),
      );
      track({
        event: 'survey sent',
        $survey_id: survey.id,
        $survey_name: survey.name,
        $survey_questions: survey.questions.map((q) => ({ id: q.id, question: q.question })),
        ...responses,
      });
      close(survey.id, 'sent');
    },
    dismiss: () => {
      if (!survey) return;
      track({ event: 'survey dismissed', $survey_id: survey.id, $survey_name: survey.name });
      close(survey.id, 'dismissed');
    },
  };
}

type Send = (answers: Readonly<Record<string, string>>) => void;

const shown = new Set<string>();

export function surveyShown(survey: TelemetrySurvey): void {
  if (shown.has(survey.id)) return;
  shown.add(survey.id);
  track({ event: 'survey shown', $survey_id: survey.id, $survey_name: survey.name });
}

const INVITED = '.invited';

export function invited(id: string): boolean {
  return (defaultStorage()?.getItem(SEEN + id + INVITED) ?? null) !== null;
}

export function markInvited(id: string): void {
  defaultStorage()?.setItem(SEEN + id + INVITED, '1');
}
