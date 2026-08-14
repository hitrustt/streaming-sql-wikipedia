import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from './components/Header';
import { Intro } from './components/Intro';
import { LiveFeed } from './components/LiveFeed';
import { QueryEditor } from './components/QueryEditor';
import { Results } from './components/Results';
import { PresetRail, SchemaPanel } from './components/Sidebar';
import { useRiverbed } from './lib/useRiverbed';
import type { Preset } from './lib/types';

type Theme = 'light' | 'dark';

const THEME_KEY = 'riverbed.theme';
const INTRO_KEY = 'riverbed.intro';

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Shown before the socket delivers the preset list, so the editor is never blank. */
const BOOT_SQL = `SELECT lang, count(*) AS edits
FROM edits
WHERE lang != '-'
GROUP BY lang
ORDER BY edits DESC
LIMIT 12
WINDOW 5m`;

export default function App() {
  const {
    connected, presets, columns, stats, events, headline, headlineColumns, result,
    subscribe, setHumanOnly,
  } = useRiverbed();

  const [sql, setSql] = useState(BOOT_SQL);
  // The query currently running on the server, as distinct from the editor's
  // text. The gap between them is what "unsaved changes" reports.
  const [runningSql, setRunningSql] = useState<string | null>(null);
  const [viz, setViz] = useState<Preset['viz']>('bar');
  const [paused, setPaused] = useState(false);
  const [humanOnly, setHumanOnlyState] = useState(true);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  // Shown to everyone by default; dismissal is remembered so a return visitor
  // is not re-explained to.
  const [showIntro, setShowIntro] = useState(() => localStorage.getItem(INTRO_KEY) !== 'done');
  const bootstrapped = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // Start the default query as soon as the connection is up, so a visitor who
  // never interacts still sees live results within a second of landing.
  useEffect(() => {
    if (!connected || bootstrapped.current) return;
    bootstrapped.current = true;
    const first = presets[0];
    if (first) {
      setSql(first.sql);
      setViz(first.viz);

      setRunningSql(first.sql);
      subscribe(first.sql);
    } else {
      setRunningSql(BOOT_SQL);
      subscribe(BOOT_SQL);
    }
  }, [connected, presets, subscribe]);

  const run = useCallback(() => {
    setRunningSql(sql);
    subscribe(sql);
  }, [sql, subscribe]);

  const pickPreset = useCallback(
    (preset: Preset) => {
      setSql(preset.sql);
      setViz(preset.viz);

      setRunningSql(preset.sql);
      subscribe(preset.sql);
    },
    [subscribe],
  );

  const editSql = useCallback((next: string) => setSql(next), []);

  const dirty = runningSql !== null && sql !== runningSql;

  // Derived from the editor text rather than tracked separately: once someone
  // edits a preset's SQL it is no longer that preset, and highlighting it would
  // misrepresent what is running.
  const activeId = useMemo(
    () => presets.find((preset) => preset.sql.trim() === sql.trim())?.id ?? null,
    [presets, sql],
  );

  // Names the result panel in plain language. Once the SQL has been hand-edited
  // there is no preset to describe it, so it says so rather than mislabelling.
  const caption = useMemo(() => {
    const preset = presets.find((candidate) => candidate.id === activeId);
    if (preset) return { title: preset.label, description: preset.description };
    if (runningSql === null) return null;
    return { title: 'Your query', description: 'Live results for the SQL above.' };
  }, [presets, activeId, runningSql]);

  return (
    <div className="app">
      <Header
        stats={stats}
        headline={headline}
        headlineColumns={headlineColumns}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />

      {showIntro && (
        <Intro
          onDismiss={() => {
            setShowIntro(false);
            localStorage.setItem(INTRO_KEY, 'done');
          }}
        />
      )}

      {!connected && (
        <div className="banner">
          <span>Disconnected from the stream — retrying automatically.</span>
        </div>
      )}

      <div className="workspace">
        <aside className="column column--side">
          <PresetRail presets={presets} activeId={activeId} onPick={pickPreset} />
          <SchemaPanel columns={columns} />
        </aside>

        <main className="column column--center">
          <QueryEditor
            value={sql}
            onChange={editSql}
            onRun={run}
            error={result.error}
            dirty={dirty}
          />
          <Results result={result} viz={viz} caption={caption} />
        </main>

        <aside className="column column--side">
          <LiveFeed
            events={events}
            paused={paused}
            onTogglePause={() => setPaused((p) => !p)}
            humanOnly={humanOnly}
            onToggleHumanOnly={() => {
              const next = !humanOnly;
              setHumanOnlyState(next);
              setHumanOnly(next);
            }}
          />
        </aside>
      </div>
    </div>
  );
}
