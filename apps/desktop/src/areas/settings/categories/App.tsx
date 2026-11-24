import type { RiskTier } from '@tessera/protocol';
import { Button, Choice, SettingsRow, Switch, TextArea } from '@tessera/ui';
import wordmark from '@tessera/ui/brand/wordmark.svg';
import { useEffect, useState } from 'react';
import { privacyWords, useAccount } from '../../../account/account.ts';
import { NOTICES_SETTING, RITHMIC_NOTICES } from '../../../accounts/rithmicAttribution.ts';
import { APP_VERSION } from '../../../app/runtime.ts';
import { surveyShown, useDueSurvey } from '../../../app/survey.ts';
import { setConsent, useSharing } from '../../../app/telemetry.ts';
import { useHasTool, useTools, useToolValue } from '../../../app/tools.ts';
import { useConnection } from '../../../app/runtimeContext.ts';
import { appHost } from '../../../app/services.ts';
import { checkAction, checkForUpdates, standingWords, useUpdate } from '../../../app/updates.ts';
import { useDisplayZone } from '../../../state/timeZone.ts';
import { Fact, Row, Section } from '../parts.tsx';
import { FEEDBACK_KEY } from '../../../feedback/model.ts';
import { openFeedback } from '../../../feedback/store.ts';
import { GeneralSection } from './General.tsx';
import { KeyboardSection } from './Keyboard.tsx';
import { SharesSection } from './Shares.tsx';

const RISK_ORDER: RiskTier[] = ['read', 'modify', 'financial'];
const RISK_WORD: Record<RiskTier, string> = { financial: 'Financial', modify: 'Modify', read: 'Read' };

export function App() {
  return (
    <>
      <GeneralSection />
      <PrivacySection />
      <SurveySection />
      <ReportSection />
      <SharesSection />
      <KeyboardSection />
      <BuildSections />
    </>
  );
}

function PrivacySection() {
  const account = useAccount();
  return (
    <Section id="app.privacy">
      <SettingsRow
        data-setting="app.privacyLine"
        label="Prices and orders go only to your connections"
        help={privacyWords(account?.phase ?? 'off')}
      />
      <ConsentRows />
    </Section>
  );
}

function DesktopRow() {
  const update = useUpdate();
  const zone = useDisplayZone();
  const action = checkAction(update);
  return (
    <SettingsRow data-setting="app.desktop" label="Tessera desktop" help={standingWords(update, zone) ?? undefined}>
      <Fact>{APP_VERSION}</Fact>
      {appHost().updates ? (
        <Button variant="quiet" size="s" disabled={action.busy} onClick={() => void checkForUpdates()}>
          {action.words}
        </Button>
      ) : null}
    </SettingsRow>
  );
}

function BuildSections() {
  const conn = useConnection();
  const server = conn.server;
  const tools = useTools();
  const info = useToolValue('runtime.data_info', useHasTool('runtime.data_info') ? {} : null, { keepFor: 60_000 });
  const byRisk = new Map<RiskTier, string[]>();
  for (const t of tools?.values() ?? []) byRisk.set(t.risk, [...(byRisk.get(t.risk) ?? []), t.name]);
  return (
    <>
      <header className="st-about">
        <img className="wm" src={wordmark} alt="Tessera" />
        <p className="line">Every piece, in place.</p>
        <p className="story">
          A Roman <i>tessera hospitalis</i> was one token broken in two; each party kept a half, and only the matching
          halves proved the bond. The T is that token, cut once down the stem: the left half is yours, the right half
          the analyst&apos;s.
        </p>
      </header>
      <Section id="app.build">
        <DesktopRow />
        <SettingsRow
          data-setting="app.runtimeVersion"
          label="Runtime"
          help={info ? `${info.profile === 'release' ? 'Release' : 'Development'} build` : undefined}
        >
          <Fact>{server?.serverVersion ?? '—'}</Fact>
        </SettingsRow>
        <SettingsRow data-setting="app.protocol" label="Protocol">
          <Fact>{server ? String(server.protocolVersion) : '—'}</Fact>
        </SettingsRow>
      </Section>
      <Section id={NOTICES_SETTING}>
        <Row id="app.rithmicNotices" layout="stack">
          <ul className="m-0 grid list-none gap-1 p-0 text-body text-t2" data-selectable>
            {RITHMIC_NOTICES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Row>
      </Section>
      <Section id="app.runtime">
        <SettingsRow data-setting="app.endpoint" label="Endpoint" help="This machine only">
          <Fact code>{conn.endpoint?.replace(/token=[^&]+/, 'token=…') ?? '—'}</Fact>
        </SettingsRow>
        {tools ? (
          <SettingsRow
            data-setting="app.tools"
            label="Tools"
            help={RISK_ORDER.map((r) => `${RISK_WORD[r].toLowerCase()} ${String(byRisk.get(r)?.length ?? 0)}`).join(
              ' · ',
            )}
          >
            <Fact>{tools.size}</Fact>
          </SettingsRow>
        ) : null}
        {RISK_ORDER.map((r) =>
          byRisk.get(r)?.length ? (
            <SettingsRow key={r} data-setting={`app.tools.${r}`} label={RISK_WORD[r]} layout="stack">
              <span className="st-code st-words" data-selectable>
                {byRisk.get(r)!.sort().join('  ')}
              </span>
            </SettingsRow>
          ) : null,
        )}
      </Section>
    </>
  );
}

function ConsentRows() {
  const sharing = useSharing();
  const [failed, setFailed] = useState<{ row: string; why: string } | null>(null);
  if (sharing.kind !== 'known') return null;
  const { consent } = sharing;
  const change = (row: string, part: 'crashes' | 'usage', on: boolean) => {
    setFailed(null);
    void setConsent(consent, { [part]: on }).then((why) => setFailed(why ? { row, why } : null));
  };
  const error = (row: string) => (failed?.row === row ? failed.why : null);
  return (
    <>
      <Row id="app.crashes" error={error('app.crashes')}>
        <Switch
          label="Send crash reports"
          checked={consent.crashes}
          onCheckedChange={(on) => change('app.crashes', 'crashes', on)}
        />
      </Row>
      <Row id="app.usage" error={error('app.usage')}>
        <Switch
          label="Share usage analytics"
          checked={consent.usage === true}
          onCheckedChange={(on) => change('app.usage', 'usage', on)}
        />
      </Row>
    </>
  );
}

function ReportSection() {
  return (
    <Section id="app.report">
      <SettingsRow
        data-setting="app.sendFeedback"
        label="Send feedback"
        help="The sheet shows everything Tessera attaches, each line removable, and nothing leaves until you press Send."
      >
        <Button size="s" shortcut={FEEDBACK_KEY} onClick={openFeedback}>
          Send feedback…
        </Button>
      </SettingsRow>
    </Section>
  );
}

function SurveySection() {
  const { survey, send, dismiss } = useDueSurvey();
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    if (survey) surveyShown(survey);
  }, [survey]);
  if (!survey) return null;
  const answer = (q: string, a: string) => setAnswers({ ...answers, [q]: a });
  const ready = survey.questions.every((q) => q.optional || answers[q.id]?.trim());
  const last = survey.questions.length - 1;
  return (
    <Section id="app.survey">
      {survey.questions.map((q, i) => (
        <SettingsRow
          key={q.id}
          data-setting={`app.survey.${q.id}`}
          label={q.question}
          help={q.description ?? undefined}
          layout="stack"
        >
          {q.kind === 'single_choice' ? (
            <Choice<string>
              label={q.question}
              options={q.choices.map((c) => ({ value: c, label: c }))}
              value={answers[q.id] ?? null}
              onChange={(c) => answer(q.id, c)}
            />
          ) : (
            <TextArea
              aria-label={q.question}
              rows={3}
              maxLength={2000}
              spellCheck
              value={answers[q.id] ?? ''}
              onChange={(e) => answer(q.id, e.target.value)}
            />
          )}
          {i === last ? (
            <span className="st-actions">
              <Button size="s" variant="quiet" onClick={dismiss}>
                Skip
              </Button>
              <Button size="s" disabled={!ready} onClick={() => send(answers)}>
                Send
              </Button>
            </span>
          ) : null}
        </SettingsRow>
      ))}
    </Section>
  );
}
