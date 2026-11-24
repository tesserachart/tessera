import { useEffect } from 'react';
import { invited, markInvited, surveyShown, useDueSurvey } from '../app/survey.ts';
import { openSettings } from '../areas/settings/store.ts';
import { deskToasts } from '../workspace/dock/deskToasts.ts';

const INVITE_AFTER_MS = 10 * 60_000;

export function useSurveyInvite(): void {
  const { survey } = useDueSurvey();
  const id = survey?.id ?? null;
  useEffect(() => {
    if (!survey || invited(survey.id)) return;
    const t = setTimeout(() => {
      markInvited(survey.id);
      surveyShown(survey);
      deskToasts.push({
        tone: 'info',
        key: `survey-${survey.id}`,
        title: 'One question from the Tessera team',
        detail: survey.questions[0]?.question ?? null,
        action: { label: 'Answer', run: () => openSettings('app.survey') },
      });
    }, INVITE_AFTER_MS);
    return () => clearTimeout(t);
  }, [id]);
}
