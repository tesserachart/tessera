import type { Command } from '../commands/registry.ts';
import { displaySymbol } from '../market/instruments.ts';
import { layoutsStore } from '../state/layouts.ts';
import { setRuntimeSetting, runtimeSettingsStore } from '../state/runtimeSettings.ts';
import { activeChartTarget } from '../workspace/controller.ts';
import { openAlertForm } from './formStore.ts';
import { chartPlotChoices, drawingChoice } from './seed.ts';
import { shownDrawings } from '../chart/drawings/sources.ts';
import { read } from '../app/store.ts';
import { runTool } from '../app/tools.ts';
import { soundSettings, soundsValue } from '../sound/settings.ts';

function muted(): boolean {
  const v = read(runtimeSettingsStore).values.sounds;
  return !!v && typeof v === 'object' && (v as { muted?: unknown }).muted === true;
}

export function alertCommands(): Command[] {
  return [
    {
      id: 'alerts.new',
      title: 'New alert on this chart…',
      group: 'Alerts',
      keywords: ['alert', 'price alert', 'notify', 'alarm', 'level', 'cross'],
      when: () => activeChartTarget() !== null,
      run: async () => {
        const target = activeChartTarget();
        const chart = target ? read(layoutsStore).layouts[target.layoutId]?.charts[target.tileId] : null;
        if (!target || !chart) return;
        const [quote, spec] = await Promise.all([
          runTool('market.get_quote', { instrument: chart.instrument }).catch(() => null),
          runTool('market.get_contract_spec', { instrument: chart.instrument }).catch(() => null),
        ]);
        const decimals = spec?.spec.priceDecimals ?? 2;
        openAlertForm({
          instrument: chart.instrument,
          symbol: displaySymbol(spec?.spec.instrument ?? chart.instrument),
          interval: chart.timeframe,
          decimals,
          tick: spec?.spec.tickSize ?? 10 ** -decimals,
          price: quote?.last ?? null,
          more: [
            ...shownDrawings(read(layoutsStore).layouts[target.layoutId]?.charts ?? {}, target.tileId).flatMap(
              (d) => drawingChoice(d) ?? [],
            ),
            ...chartPlotChoices(chart.layers, spec?.spec.root),
          ],
        });
      },
    },
    {
      id: 'sounds.toggleMute',
      title: 'Mute / unmute sounds',
      group: 'Alerts',
      keywords: ['sound', 'mute', 'unmute', 'silence', 'quiet', 'audio', 'beep'],
      run: () => void setSoundsMuted(!muted()),
    },
  ];
}

function setSoundsMuted(on: boolean): Promise<string | null> {
  const s = soundSettings(read(runtimeSettingsStore).values.sounds);
  return setRuntimeSetting('sounds', soundsValue({ ...s, muted: on }));
}
