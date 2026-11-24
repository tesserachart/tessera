import type { JsonValue } from '@tessera/protocol';
import {
  Button,
  Choice,
  ColorPicker,
  ConfirmButton,
  SettingsRow,
  TextInput,
  cx,
  type SegmentedOption,
} from '@tessera/ui';
import { useRef, useState, type KeyboardEvent } from 'react';
import { failureText } from '../../../app/tools.ts';
import { appHost } from '../../../app/services.ts';
import { hexOf } from '../../../theme/colour.ts';
import { changeScheme, changeTheme, deleteTheme, renameTheme, saveTheme } from '../../../theme/actions.ts';
import {
  builtIn,
  resolveTheme,
  SHELL_COLORS,
  themeKey,
  type SavedTheme,
  type ThemeKey,
  type ThemeMode,
} from '../../../theme/resolve.ts';
import type { Appearance as AppearanceChoice } from '../../../theme/scheme.ts';
import { useTheme } from '../../../theme/store.ts';
import { Row, Section, SettingSelect } from '../parts.tsx';
import {
  APP_BANDS,
  changeFor,
  choiceOf,
  copyName,
  modeRows,
  readThemeFile,
  resetChange,
  savedWords,
  saveAsName,
  shownNowWords,
  themeFile,
  themeOptions,
  themeRefusal,
  whenShownWords,
  type ModeRow,
  type ThemeChoice,
} from '../themes.ts';

const APPEARANCES: readonly SegmentedOption<AppearanceChoice>[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

const ROW_OF: Readonly<Record<ThemeMode, string>> = { dark: 'appearance.dark', light: 'appearance.light' };

export function Appearance() {
  return (
    <>
      <ThemeSection />
      <SavedSection />
      <AppColoursSection />
    </>
  );
}

function useRefusal() {
  const [refused, setRefused] = useState<{ key: string; message: string } | null>(null);
  const run = async (key: string, work: () => Promise<void>) => {
    try {
      await work();
      setRefused((x) => (x?.key === key ? null : x));
    } catch (e) {
      setRefused({ key, message: themeRefusal(failureText(e), key as ThemeKey) });
    }
  };
  return { refused, run, errorOf: (key: string) => (refused?.key === key ? refused.message : null) };
}

function NameField({ start, label, onDone }: { start: string; label: string; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(start);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(save && name.trim() ? name.trim() : null);
  };
  return (
    <TextInput
      size="s"
      className="st-rename"
      aria-label={label}
      autoFocus
      maxLength={60}
      value={name}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

function ThemeSection() {
  const resolved = useTheme((s) => s.resolved);
  const link = useTheme((s) => s.link);
  const saved = useTheme((s) => s.savedThemes);
  const scheme = useTheme((s) => s.scheme);
  const { run, errorOf } = useRefusal();
  const file = useRef<HTMLInputElement>(null);
  const take = async (files: FileList | null) => {
    const picked = files?.[0];
    if (file.current) file.current.value = '';
    if (!picked) return;
    const read = readThemeFile(await picked.text(), picked.name);
    if ('problem' in read) throw new Error(read.problem);
    await saveTheme(read.name, { theme: read.theme as JsonValue });
  };
  const rows = modeRows(resolved.mode, choiceOf(resolved, link), scheme, saved);
  return (
    <Section id="appearance.theme">
      <Row id="appearance.scheme" error={errorOf('scheme')}>
        <Choice<AppearanceChoice>
          label="Appearance"
          value={scheme.appearance}
          options={APPEARANCES}
          onChange={(appearance) => void run('scheme', () => changeScheme({ appearance }))}
        />
      </Row>
      {rows.map((row) => (
        <ModeThemeRow key={row.mode} row={row} />
      ))}
      <Row id="appearance.import" error={errorOf('import')}>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => void run('import', () => take(e.target.files))}
        />
        <Button size="s" onClick={() => file.current?.click()}>
          Import…
        </Button>
      </Row>
    </Section>
  );
}

function ModeThemeRow({ row }: { row: ModeRow }) {
  const resolved = useTheme((s) => s.resolved);
  const link = useTheme((s) => s.link);
  const saved = useTheme((s) => s.savedThemes);
  const appearance = useTheme((s) => s.scheme.appearance);
  const { run, errorOf } = useRefusal();
  const [naming, setNaming] = useState(false);
  const own = row.shown && resolved.overridden.size > 0;
  const pick = (choice: ThemeChoice) =>
    row.shown ? changeTheme(changeFor(choice)) : changeScheme({ [row.mode]: changeFor(choice) });
  return (
    <Row
      id={ROW_OF[row.mode]}
      help={row.shown ? shownNowWords(resolved, link) : whenShownWords(appearance, row.mode)}
      error={errorOf('pick')}
    >
      {own ? (
        <Button
          size="s"
          variant="quiet"
          onClick={() => void run('pick', () => changeTheme(resetChange(resolved, link)))}
        >
          Reset
        </Button>
      ) : null}
      {!row.shown ? null : naming ? (
        <NameField
          label="Name the theme"
          start={saveAsName(resolved, link, saved)}
          onDone={(name) => {
            setNaming(false);
            if (name) void run('pick', () => saveTheme(name));
          }}
        />
      ) : (
        <Button size="s" variant="quiet" onClick={() => setNaming(true)}>
          Save as…
        </Button>
      )}
      <SettingSelect<ThemeChoice>
        label={rowLabel(row.mode)}
        value={row.choice}
        onValueChange={(choice) => void run('pick', () => pick(choice))}
        options={themeOptions(saved, row.mode, row.choice)}
      />
    </Row>
  );
}

const rowLabel = (mode: ThemeMode) => (mode === 'dark' ? 'Dark theme' : 'Light theme');

function SavedSection() {
  const saved = useTheme((s) => s.savedThemes);
  const link = useTheme((s) => s.link);
  return (
    <Section
      id="appearance.saved"
      description={saved.length === 0 ? 'Save the theme shown with Save as…, or import one.' : undefined}
    >
      {saved.map((t) => (
        <SavedRow key={t.id} t={t} shown={link?.id === t.id} all={saved} />
      ))}
    </Section>
  );
}

function SavedRow({ t, shown, all }: { t: SavedTheme; shown: boolean; all: readonly SavedTheme[] }) {
  const { run, errorOf } = useRefusal();
  const [renaming, setRenaming] = useState(false);
  const r = resolveTheme(t.theme);
  const exportIt = () =>
    run('row', async () => {
      const f = themeFile(t.name, t.theme);
      await appHost().saveFile({
        suggestedName: f.name,
        data: f.text,
        mimeType: 'application/json',
        filters: [{ name: 'Theme', extensions: ['json'] }],
      });
    });
  return (
    <SettingsRow
      data-setting={`appearance.saved.${t.id}`}
      label={
        renaming ? (
          <NameField
            label={`Rename ${t.name}`}
            start={t.name}
            onDone={(name) => {
              setRenaming(false);
              if (name && name !== t.name) void run('row', () => renameTheme(t.id, name));
            }}
          />
        ) : (
          <span className="st-theme-name">
            <ThemeSwatch r={r} />
            {t.name}
          </span>
        )
      }
      help={savedWords(t, shown)}
      error={errorOf('row')}
    >
      {shown ? null : (
        <Button size="s" variant="quiet" onClick={() => void run('row', () => changeTheme({ saved: t.id }))}>
          Show
        </Button>
      )}
      <Button
        size="s"
        variant="quiet"
        onClick={() => void run('row', () => saveTheme(copyName(t.name, all), { from: t.id }))}
      >
        Duplicate
      </Button>
      <Button size="s" variant="quiet" onClick={() => setRenaming(true)}>
        Rename
      </Button>
      <Button size="s" variant="quiet" onClick={() => void exportIt()}>
        Export…
      </Button>
      <ConfirmButton
        what={t.name}
        question={shown ? 'The app keeps its colours until you pick another theme.' : 'Built-in themes stay.'}
        onConfirm={() => void run('row', () => deleteTheme(t.id))}
      >
        Delete
      </ConfirmButton>
    </SettingsRow>
  );
}

function ThemeSwatch({ r }: { r: ReturnType<typeof resolveTheme> }) {
  const hex = (k: ThemeKey) => {
    const c = r.colors[k];
    return c ? hexOf(c) : undefined;
  };
  return (
    <span className="st-theme-swatch" aria-hidden="true">
      {(['surfaces.ground', 'surfaces.panel', 'ink.t1', 'semantics.up', 'semantics.down', 'accents.teal'] as const).map(
        (k) => (
          <i key={k} style={{ background: hex(k) }} />
        ),
      )}
    </span>
  );
}

function AppColoursSection() {
  const resolved = useTheme((s) => s.resolved);
  const { run, errorOf } = useRefusal();
  const base = builtIn(resolved.preset).label;
  return (
    <Section id="appearance.colours" bare>
      {APP_BANDS.map((b) => (
        <div key={b.role} className="st-colours-band" data-setting={`appearance.band.${b.groups[0]!}`}>
          <h3 className="st-sub">
            {b.role}
            {b.note ? <span className="st-sub-note">{b.note}</span> : null}
          </h3>
          <div className="st-colours">
            {SHELL_COLORS.filter((c) => b.groups.includes(c.group)).map((c) => {
              const key = themeKey(c);
              const mine = resolved.overridden.has(key);
              const c0 = resolved.colors[key];
              return (
                <div key={key} className="st-colour" data-setting={`appearance.colour.${key}`}>
                  <span className={cx('nm', mine && 'is-own')}>{c.label}</span>
                  <ColorPicker
                    label={c.label}
                    hint={c.about}
                    value={c0 ? hexOf(c0) : null}
                    alpha
                    error={errorOf(key)}
                    onChange={(hex) => void run(key, () => changeTheme({ [c.group]: { [c.key]: hex } }))}
                    {...(mine
                      ? {
                          onReset: () => void run(key, () => changeTheme({ [c.group]: { [c.key]: null } })),
                          resetLabel: `Back to ${base}'s`,
                        }
                      : {})}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </Section>
  );
}
