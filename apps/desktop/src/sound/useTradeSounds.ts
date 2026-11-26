import { useEffect, useState } from 'react';
import { useTopicEffect } from '../app/useTopic.ts';
import { useSetting } from '../state/runtimeSettings.ts';
import { ConnectionSoundTracker } from './connectionSounds.ts';
import { SOUNDS } from './settings.ts';
import { LimitSoundTracker, PositionSoundTracker, RefusalSoundTracker, TradeSoundTracker } from './tradeSounds.ts';
import type { VoiceLineId } from './voice/lines.ts';
import { announce, primeVoice, voicePack } from './voice/speaker.ts';

export function useTradeSounds(): void {
  const settings = useSetting(SOUNDS);
  const packId = voicePack(settings)?.manifest.id ?? null;
  const voiced = packId === null ? null : {};
  const [orders] = useState(() => new TradeSoundTracker());
  const [refusals] = useState(() => new RefusalSoundTracker());
  const [positions] = useState(() => new PositionSoundTracker());
  const [limits] = useState(() => new LimitSoundTracker());
  const [connections] = useState(() => new ConnectionSoundTracker());
  const say = (line: VoiceLineId | null) => {
    if (line) announce(line);
  };

  useEffect(() => {
    if (packId !== null) primeVoice();
  }, [packId]);
  const voiceOn = packId !== null;
  useEffect(() => {
    if (!voiceOn) return;
    positions.restart();
    limits.restart();
    connections.restart();
  }, [voiceOn, positions, limits, connections]);

  useTopicEffect('orders', {}, (ev, meta) => say(orders.see(ev.order, meta.seq)), {
    replay: false,
    onActive: () => orders.activate(),
    onResubscribed: () => orders.reset(),
  });
  useTopicEffect('tool.calls', {}, (ev, meta) => say(refusals.see(ev, meta.seq)), {
    replay: false,
    onActive: () => refusals.activate(),
    onResubscribed: () => refusals.reset(),
  });
  useTopicEffect('positions', voiced, (ev, meta) => say(positions.see(ev.position, meta.seq)), {
    replay: false,
    onActive: () => positions.activate(),
    onResubscribed: () => positions.reset(),
  });
  useTopicEffect('accounts', voiced, (ev, meta) => say(limits.see(ev, meta.seq)), {
    replay: false,
    onActive: () => limits.activate(),
    onResubscribed: () => limits.reset(),
  });
  useTopicEffect('health', voiced, (ev, meta) => say(connections.see(ev.providers, meta.seq)), {
    replay: false,
    onActive: () => connections.activate(),
    onResubscribed: () => connections.reset(),
  });
}
