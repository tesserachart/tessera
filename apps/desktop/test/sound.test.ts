import type { Order, OrderRole, OrderStatus } from '@tessera/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { playSound, previewSound } from '../src/sound/index.ts';
import { DEFAULT_SOUNDS, audible, previewGain, soundSettings, soundsValue } from '../src/sound/settings.ts';
import { SOUND_NAMES, TONES, toneLength } from '../src/sound/tones.ts';
import { TradeSoundTracker, tradeSound } from '../src/sound/tradeSounds.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';

let n = 0;
function order(o: { id?: string; role?: OrderRole; status?: OrderStatus; filledQty?: number; qty?: number }): Order {
  n += 1;
  return {
    id: o.id ?? `o${String(n)}`,
    brokerOrderId: null,
    draftId: null,
    request: {
      accountId: 'paper-main',
      instrument: 'NQZ6.CME',
      side: 'buy',
      qty: o.qty ?? 2,
      orderType: 'market',
      limitPrice: null,
      stopPrice: null,
      tif: 'day',
      bracket: null,
      clientOrderId: null,
      reduceOnly: false,
    },
    role: o.role ?? 'entry',
    parentId: null,
    status: o.status ?? 'working',
    filledQty: o.filledQty ?? 0,
    avgFillPrice: null,
    queueAhead: null,
    triggeredAt: null,
    environment: 'paper',
    reason: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('the tones', () => {
  it('are short, calm and each its own', () => {
    for (const name of SOUND_NAMES) {
      const notes = TONES[name];
      expect(notes.length, name).toBeGreaterThan(0);
      expect(toneLength(notes), name).toBeLessThanOrEqual(0.35);
      for (const note of notes) {
        expect(['sine', 'triangle']).toContain(note.wave);
        expect(note.gain).toBeGreaterThan(0);
        expect(note.gain).toBeLessThanOrEqual(0.5);
        expect(note.dur).toBeGreaterThan(0);
        expect(note.at).toBeGreaterThanOrEqual(0);
      }
    }
    const shapes = SOUND_NAMES.map((name) => JSON.stringify(TONES[name]));
    expect(new Set(shapes).size).toBe(SOUND_NAMES.length);
    expect(TONES.target[1]!.freq).toBeGreaterThan(TONES.target[0]!.freq);
    expect(TONES.stop[1]!.freq).toBeLessThan(TONES.stop[0]!.freq);
  });
});

describe('the sounds setting', () => {
  it('reads defaults where it holds nothing or something else', () => {
    expect(soundSettings(undefined)).toEqual(DEFAULT_SOUNDS);
    expect(soundSettings(null)).toEqual(DEFAULT_SOUNDS);
    expect(soundSettings('loud')).toEqual(DEFAULT_SOUNDS);
    expect(soundSettings([1, 2])).toEqual(DEFAULT_SOUNDS);
  });

  it('keeps each field it holds of its type, the rest from the default', () => {
    expect(soundSettings({ muted: true })).toEqual({ ...DEFAULT_SOUNDS, muted: true });
    expect(soundSettings({ volume: 0.25, voice: 'sarah', events: { stop: false, cancelled: false } })).toEqual({
      muted: false,
      volume: 0.25,
      voice: 'sarah',
      events: {
        fill: true,
        stop: false,
        target: true,
        rejected: true,
        cancelled: false,
        connection: true,
        alert: true,
      },
    });
    expect(soundSettings({ voice: 7 }).voice).toBeNull();
    expect(soundSettings({ voice: '' }).voice).toBeNull();
    expect(soundSettings({ muted: 'yes', volume: 'max', events: { fill: 0 } })).toEqual(DEFAULT_SOUNDS);
    expect(soundSettings({ volume: 3 }).volume).toBe(1);
    expect(soundSettings({ volume: -1 }).volume).toBe(0);
    expect(soundSettings({ volume: Number.NaN }).volume).toBe(DEFAULT_SOUNDS.volume);
  });

  it('writes back the whole value, every sound named, a voice only once chosen', () => {
    const events = {
      fill: true,
      stop: true,
      target: true,
      rejected: true,
      cancelled: true,
      connection: true,
      alert: true,
    };
    expect(soundsValue(soundSettings({ volume: 0.3 }))).toEqual({ muted: false, volume: 0.3, events });
    expect(soundsValue(soundSettings({ volume: 0.3, voice: 'off' }))).toEqual({
      muted: false,
      volume: 0.3,
      voice: 'off',
      events,
    });
  });

  it('plays at the volume, unless muted or that sound is off', () => {
    const s = soundSettings({ volume: 0.4, events: { rejected: false } });
    expect(audible(s, 'fill')).toBe(0.4);
    expect(audible(s, 'rejected')).toBe(0);
    expect(audible({ ...s, muted: true }, 'fill')).toBe(0);
    expect(audible({ ...s, volume: 0 }, 'fill')).toBe(0);
    expect(previewGain(s)).toBe(0.4);
    expect(previewGain({ ...s, muted: true })).toBe(0);
  });
});

describe('a trade’s sound with tones alone', () => {
  it('is a fill, a stop or a target by the order’s role', () => {
    const was = { status: 'working' as const, filledQty: 0 };
    expect(tradeSound(was, order({ status: 'filled', filledQty: 2 }))).toBe('fill');
    expect(tradeSound(was, order({ role: 'exit', status: 'filled', filledQty: 2 }))).toBe('fill');
    expect(tradeSound(was, order({ role: 'stop_loss', status: 'filled', filledQty: 2 }))).toBe('stop');
    expect(tradeSound(was, order({ role: 'take_profit', status: 'filled', filledQty: 2 }))).toBe('target');
  });

  it('is a rejection when the order is newly rejected', () => {
    expect(tradeSound({ status: 'pending_submit', filledQty: 0 }, order({ status: 'rejected' }))).toBe('rejected');
    expect(tradeSound(undefined, order({ status: 'rejected' }))).toBe('rejected');
    expect(tradeSound({ status: 'rejected', filledQty: 0 }, order({ status: 'rejected' }))).toBeNull();
  });

  it('is nothing for an update that fills nothing', () => {
    expect(tradeSound({ status: 'pending_submit', filledQty: 0 }, order({ status: 'working' }))).toBeNull();
    expect(
      tradeSound({ status: 'partially_filled', filledQty: 1 }, order({ status: 'partially_filled', filledQty: 1 })),
    ).toBeNull();
    expect(tradeSound({ status: 'working', filledQty: 0 }, order({ status: 'cancelled' }))).toBeNull();
  });

  it('sounds each part of a partial fill as it grows, once for each, and never for the snapshot', () => {
    const t = new TradeSoundTracker();
    expect(t.see(order({ id: 'a', status: 'partially_filled', filledQty: 1, qty: 3 }), 0)).toBeNull();
    t.activate();
    expect(t.see(order({ id: 'b', role: 'stop_loss', status: 'filled', filledQty: 1 }), 0)).toBeNull();
    expect(t.see(order({ id: 'a', status: 'partially_filled', filledQty: 1, qty: 3 }), 1)).toBeNull();
    expect(t.see(order({ id: 'a', status: 'partially_filled', filledQty: 2, qty: 3 }), 2)).toBe('partially_filled');
    expect(t.see(order({ id: 'a', status: 'filled', filledQty: 3, qty: 3 }), 3)).toBe('market_filled');
    expect(t.see(order({ id: 'a', status: 'filled', filledQty: 3, qty: 3 }), 4)).toBeNull();
    expect(t.see(order({ id: 'a', status: 'partially_filled', filledQty: 2, qty: 3 }), 5)).toBeNull();
    expect(t.see(order({ id: 'b', role: 'stop_loss', status: 'filled', filledQty: 1 }), 6)).toBeNull();
    expect(t.see(order({ id: 'c', role: 'take_profit', status: 'filled', filledQty: 1 }), 7)).toBe('target_hit');
  });

  it('notes everything before the subscription is acknowledged, and forgets on resubscribing', () => {
    const t = new TradeSoundTracker();
    expect(t.see(order({ id: 'a', status: 'working' }), 1)).toBeNull();
    t.activate();
    expect(t.see(order({ id: 'a', status: 'filled', filledQty: 2 }), 2)).toBe('market_filled');
    t.reset();
    expect(t.see(order({ id: 'd', status: 'partially_filled', filledQty: 1 }), 0)).toBeNull();
    expect(t.see(order({ id: 'd', status: 'partially_filled', filledQty: 1 }), 1)).toBeNull();
    expect(t.see(order({ id: 'd', status: 'filled', filledQty: 2 }), 2)).toBe('market_filled');
  });
});

describe('playing', () => {
  const g = globalThis as { AudioContext?: unknown };
  const had = g.AudioContext;
  afterEach(() => {
    g.AudioContext = had;
    putRuntimeSettings({}, true);
  });

  it('is silent without Web Audio, and never throws', () => {
    g.AudioContext = undefined;
    for (const name of SOUND_NAMES) {
      expect(() => playSound(name)).not.toThrow();
      expect(() => previewSound(name)).not.toThrow();
    }
  });

  it('plays a sound once however often it is asked at once, and nothing while muted', () => {
    const started: number[] = [];
    const param = () => ({
      value: 0,
      setValueAtTime: () => undefined,
      linearRampToValueAtTime: () => undefined,
      exponentialRampToValueAtTime: () => undefined,
    });
    const node = () => ({ gain: param(), connect: (x: unknown) => x, disconnect: () => undefined });
    g.AudioContext = class {
      state = 'running';
      currentTime = 0;
      destination = {};
      createGain = node;
      createOscillator = () => ({
        ...node(),
        type: 'sine',
        frequency: param(),
        onended: null,
        start: (t: number) => started.push(t),
        stop: () => undefined,
      });
      resume = () => Promise.resolve();
    };
    putRuntimeSettings({ sounds: { muted: true } }, true);
    playSound('target');
    expect(started).toHaveLength(0);
    putRuntimeSettings({ sounds: { muted: false, volume: 0.5 } }, true);
    playSound('target');
    playSound('target');
    expect(started).toHaveLength(TONES.target.length);
    putRuntimeSettings({ sounds: { events: { alert: false } } }, true);
    playSound('alert');
    playSound('alertAsk');
    playSound('alertBid');
    expect(started).toHaveLength(TONES.target.length);
    previewSound('alert');
    expect(started).toHaveLength(TONES.target.length + TONES.alert.length);
  });
});
