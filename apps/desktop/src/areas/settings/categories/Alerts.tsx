import type { AlertDelivery, JsonValue } from '@tessera/protocol';
import { Button, Stepper, Switch, TextInput } from '@tessera/ui';
import { useEffect, useState } from 'react';
import { useAlerts, alertsStore } from '../../../alerts/store.ts';
import { SOUND_EVENTS, VOICE_ONLY_EVENTS, type SoundEvent } from '../../../sound/events.ts';
import { SOUNDS, VOICE_OFF, soundsValue, type SoundSettings } from '../../../sound/settings.ts';
import { EVENT_SAMPLE } from '../../../sound/voice/lines.ts';
import { creditsOf, packFor } from '../../../sound/voice/packs.ts';
import { previewLine, voicePacks } from '../../../sound/voice/speaker.ts';
import { saveSetting, useSetting } from '../../../state/runtimeSettings.ts';
import type { Setting } from '../../../state/setting.ts';
import { DEFAULT_DELIVERY } from '../../../alerts/formStore.ts';
import { rowWords } from '../model.ts';
import { Row, Section, SettingSelect } from '../parts.tsx';
import { asSentence } from '../sentence.ts';
import { patch } from '../../../app/store.ts';
import { useAttempt } from '../../../app/tools.ts';

const DELIVERY_ROWS: readonly { key: keyof AlertDelivery; row: string }[] = [
  { key: 'sound', row: 'alerts.delivery.sound' },
  { key: 'desktop', row: 'alerts.delivery.desktop' },
  { key: 'discord', row: 'alerts.delivery.discord' },
];

const SAID_MS = 4000;

const soundRow = (name: SoundEvent) => `alerts.sound.${name}`;

function useRowSave() {
  const [failed, setFailed] = useState<{ row: string; why: string } | null>(null);
  const save = (row: string, setting: Setting<unknown>, value: JsonValue) => {
    setFailed(null);
    void saveSetting(setting, value).then((why) => setFailed(why ? { row, why } : null));
  };
  const errorOf = (row: string) => (failed?.row === row ? failed.why : null);
  return { save, errorOf };
}

function Voice({ s, put, silent, error }: SoundsRowProps) {
  const packs = voicePacks();
  const pack = packFor(s.voice, packs);
  if (packs.length === 0) return null;
  const pick = (voice: string) => {
    put('alerts.voice', { ...s, voice });
    if (voice !== VOICE_OFF && !silent) previewLine(EVENT_SAMPLE.fill, voice);
  };
  return (
    <Row
      id="alerts.voice"
      help={[rowWords('alerts.voice').help, ...creditsOf(packs)].filter(Boolean).join(' · ')}
      error={error('alerts.voice')}
    >
      {pack ? (
        <Button
          size="s"
          variant="quiet"
          aria-label={`Play ${pack.manifest.name}`}
          disabled={silent}
          onClick={() => previewLine(EVENT_SAMPLE.fill, pack.manifest.id)}
        >
          Play
        </Button>
      ) : null}
      <SettingSelect
        label="Voice"
        value={pack?.manifest.id ?? VOICE_OFF}
        onValueChange={pick}
        options={[
          ...packs.map((p) => ({ value: p.manifest.id, label: p.manifest.name, hint: p.manifest.about })),
          { value: VOICE_OFF, label: 'Off', hint: 'Tones' },
        ]}
      />
    </Row>
  );
}

interface SoundsRowProps {
  s: SoundSettings;
  put: (row: string, next: SoundSettings) => void;
  silent: boolean;
  error: (row: string) => string | null;
}

function Sounds() {
  const s = useSetting(SOUNDS);
  const { save, errorOf } = useRowSave();
  const put = (row: string, next: SoundSettings) => save(row, SOUNDS, soundsValue(next));
  const silent = s.muted || s.volume === 0;
  const pack = packFor(s.voice, voicePacks());
  const events = SOUND_EVENTS.filter((e) => pack !== null || !VOICE_ONLY_EVENTS.has(e));
  return (
    <Section id="alerts.sounds">
      <Row id="alerts.mute" error={errorOf('alerts.mute')}>
        <Switch label="Mute" checked={s.muted} onCheckedChange={(muted) => put('alerts.mute', { ...s, muted })} />
      </Row>
      <Row id="alerts.volume" error={errorOf('alerts.volume')}>
        <span className="st-num">
          <Stepper
            label="Volume"
            value={Math.round(s.volume * 100)}
            min={0}
            max={100}
            step={10}
            shiftSteps={1}
            suffix="%"
            inputMode="numeric"
            onValueChange={(v) => put('alerts.volume', { ...s, volume: Math.round(v) / 100 })}
          />
        </span>
      </Row>
      <Voice s={s} put={put} silent={silent} error={errorOf} />
      {events.map((name) => {
        const row = soundRow(name);
        const title = rowWords(row).title;
        return (
          <Row key={name} id={row} error={errorOf(row)}>
            <Button
              size="s"
              variant="quiet"
              aria-label={`Play the ${title.toLowerCase()} sound`}
              disabled={silent}
              onClick={() => previewLine(EVENT_SAMPLE[name], pack?.manifest.id)}
            >
              Play
            </Button>
            <Switch
              label={title}
              checked={s.events[name]}
              onCheckedChange={(on) => put(row, { ...s, events: { ...s.events, [name]: on } })}
            />
          </Row>
        );
      })}
    </Section>
  );
}

function Delivery({ discordSet }: { discordSet: boolean }) {
  const d = useSetting(DEFAULT_DELIVERY);
  const { save, errorOf } = useRowSave();
  return (
    <Section id="alerts.delivery">
      {DELIVERY_ROWS.map(({ key, row }) => (
        <Row
          key={key}
          id={row}
          help={key === 'discord' && !discordSet ? 'No webhook is set yet: below' : undefined}
          error={errorOf(row)}
        >
          <Switch
            label={rowWords(row).title}
            checked={d[key]}
            onCheckedChange={(on) => save(row, DEFAULT_DELIVERY, { ...d, [key]: on })}
          />
        </Row>
      ))}
    </Section>
  );
}

const DISCORD_CALL = { timeoutMs: 20_000 } as const;

function Discord({ set }: { set: boolean }) {
  const setHook = useAttempt('alerts.set_discord', DISCORD_CALL);
  const tester = useAttempt('alerts.test_discord', DISCORD_CALL);
  const busy = setHook.busy || tester.busy;
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(null), SAID_MS);
    return () => clearTimeout(t);
  }, [said]);
  const save = () => {
    const u = url.trim();
    if (!u || busy) return;
    setFailed(null);
    void setHook.run({ url: u }).then((r) => {
      if (!r) return;
      if (!r.ok) {
        setFailed(asSentence(r.why));
        return;
      }
      setUrl('');
      patch(alertsStore, { discord: r.out.configured });
    });
  };
  const test = () => {
    setSaid(null);
    void tester.run({}).then((r) => {
      if (r) setSaid(r.ok ? { ok: true, text: 'Sent' } : { ok: false, text: asSentence(r.why) });
    });
  };
  const remove = () => {
    setSaid(null);
    setFailed(null);
    void setHook.run({}).then((r) => {
      if (!r) return;
      if (r.ok) patch(alertsStore, { discord: r.out.configured });
      else setSaid({ ok: false, text: asSentence(r.why) });
    });
  };
  if (!set)
    return (
      <Section id="alerts.discord">
        <Row
          id="alerts.discord.webhook"
          help="Not set. Copy one from a channel’s settings, Integrations › Webhooks"
          error={failed}
        >
          <span className="st-actions">
            <TextInput
              className="st-rename"
              size="s"
              type="password"
              aria-label="Discord webhook URL"
              autoComplete="off"
              spellCheck={false}
              value={url}
              disabled={busy}
              onChange={(e) => {
                setUrl(e.target.value);
                setFailed(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                save();
              }}
            />
            <Button size="s" disabled={busy || url.trim() === ''} onClick={save}>
              {setHook.busy ? 'Saving…' : 'Save'}
            </Button>
          </span>
        </Row>
      </Section>
    );
  return (
    <Section id="alerts.discord">
      <Row
        id="alerts.discord.webhook"
        help="Set · kept with your passwords and keys, never shown"
        error={said && !said.ok ? said.text : null}
      >
        {said?.ok ? <span className="st-health">{said.text}</span> : null}
        <Button size="s" disabled={busy} onClick={test}>
          {tester.busy ? 'Sending…' : 'Send test'}
        </Button>
        <Button size="s" variant="quiet" disabled={busy} onClick={remove}>
          Remove
        </Button>
      </Row>
    </Section>
  );
}

export function Alerts() {
  const discordSet = useAlerts((s) => s.discord);
  return (
    <>
      <Sounds />
      <Delivery discordSet={discordSet} />
      <Discord set={discordSet} />
    </>
  );
}
