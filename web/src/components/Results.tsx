import { useEffect, useRef, useState } from 'react';
import { formatCell, formatNumber, formatWindow } from '../lib/format';
import { type LiveResult, type Row, type Scalar, orderedRows } from '../lib/types';

interface Props {
  result: LiveResult;
  viz: 'bar' | 'table' | 'stat' | 'line';
  /** Human description of what the running query answers. */
  caption: { title: string; description: string } | null;
}

const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];

export function Results({ result, viz, caption }: Props) {
  const rows = orderedRows(result);
  const hasRows = rows.length > 0;

  return (
    <div className="panel panel--grow">
      <div className="panel__head">
        <span className="panel__title">Result · updates every second</span>
        {result.meta && (
          <span className="panel__meta">
            {formatNumber(result.meta.matched)} of {formatNumber(result.meta.scanned)} rows ·{' '}
            {formatWindow(result.meta.window_seconds)} · {result.meta.elapsed_ms.toFixed(1)} ms
          </span>
        )}
      </div>

      {caption && (
        <div className="caption">
          <div className="measure">
            <div className="caption__title">{caption.title}</div>
            <div className="caption__desc">{caption.description}</div>
          </div>
        </div>
      )}

      {result.meta?.notes.map((note) => (
        <div className="notes" key={note}>
          <div className="measure">{note}</div>
        </div>
      ))}

      <div
        className={
          viz === 'stat' && hasRows
            ? 'panel__body scroll-fade panel__body--center'
            : 'panel__body scroll-fade'
        }
      >
        {!hasRows ? (
          <p className="empty">
            {result.error
              ? 'Fix the query above to see results.'
              : 'No rows match yet — the window may still be filling.'}
          </p>
        ) : viz === 'bar' ? (
          <BarList result={result} rows={rows} />
        ) : viz === 'stat' ? (
          <StatGrid result={result} rows={rows} />
        ) : (
          <ResultTable result={result} rows={rows} />
        )}
      </div>
    </div>
  );
}

/**
 * Tracks which cells changed since the previous render so they can flash once.
 *
 * The animation is keyed on a counter rather than a boolean: re-adding the same
 * class does not restart a CSS animation, so a cell that changes on consecutive
 * ticks would only flash the first time.
 */
function useChangeTicks(result: LiveResult): Map<string, number> {
  const [ticks, setTicks] = useState<Map<string, number>>(new Map());
  const counter = useRef(0);

  useEffect(() => {
    if (result.changed.size === 0) return;
    counter.current += 1;
    setTicks((previous) => {
      const next = new Map(previous);
      for (const key of result.changed) next.set(key, counter.current);
      return next;
    });
  }, [result]);

  return ticks;
}

/** Short codes that read better as tags than as bare text. */
const TAG_COLUMNS = new Set(['lang', 'project', 'type', 'editor', 'who']);

function ResultTable({ result, rows }: { result: LiveResult; rows: Array<{ key: string; row: Row }> }) {
  const ticks = useChangeTicks(result);

  const numeric = result.columns.map((_, index) =>
    rows.some(({ row }) => typeof row[index] === 'number'),
  );

  // The widest text column absorbs the slack. Preferring the longest average
  // content means `title` wins over `lang` without hardcoding column names.
  const growIndex = (() => {
    let best = -1;
    let bestLength = -1;
    result.columns.forEach((name, index) => {
      if (numeric[index] || TAG_COLUMNS.has(name)) return;
      const sample = rows.slice(0, 20);
      const average =
        sample.reduce((sum, { row }) => sum + String(row[index] ?? '').length, 0) /
        Math.max(1, sample.length);
      if (average > bestLength) {
        bestLength = average;
        best = index;
      }
    });
    return best;
  })();

  // The first numeric column is the metric the rows are ranked by, so it gets
  // the data bars. Later numeric columns are supporting detail.
  const metricIndex = numeric.findIndex(Boolean);
  const metricMax = Math.max(
    1,
    ...rows.map(({ row }) => {
      const value = row[metricIndex];
      return typeof value === 'number' ? Math.abs(value) : 0;
    }),
  );

  return (
    <table className="table">
      <thead>
        <tr>
          <th className="rank shrink" />
          {result.columns.map((name, index) => (
            <th
              key={`${name}:${index}`}
              className={[
                index === growIndex ? 'grow' : 'shrink',
                numeric[index] ? 'num' : '',
              ].filter(Boolean).join(' ')}
            >
              {name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ key, row }, index) => {
          const tick = ticks.get(key);
          return (
            <tr key={key}>
              <td className="rank shrink">{index + 1}</td>
              {result.columns.map((name, column) => {
                const value = row[column] ?? null;
                const text = formatCell(value);
                const isMetric = column === metricIndex && typeof value === 'number';

                return (
                  <td
                    key={`${name}:${column}`}
                    className={[
                      column === growIndex ? 'grow' : 'shrink',
                      numeric[column] ? 'num' : '',
                      isMetric ? 'metric' : '',
                      tick ? 'cell--changed' : '',
                    ].filter(Boolean).join(' ')}
                    title={text}
                  >
                    {isMetric && (
                      <span
                        className="metric__bar"
                        style={{ width: `${(Math.abs(value as number) / metricMax) * 100}%` }}
                      />
                    )}
                    {TAG_COLUMNS.has(name) && typeof value === 'string' && value ? (
                      <span className="tag">{text}</span>
                    ) : (
                      <span className={isMetric ? 'metric__value' : undefined}>{text}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function BarList({ result, rows }: { result: LiveResult; rows: Array<{ key: string; row: Row }> }) {
  // The value column is the first numeric one after the grouping keys.
  const valueIndex = result.columns.findIndex(
    (_, index) => index >= Math.max(1, result.meta?.key_columns ?? 1) &&
      rows.some(({ row }) => typeof row[index] === 'number'),
  );
  const index = valueIndex === -1 ? result.columns.length - 1 : valueIndex;

  const values = rows.map(({ row }) => {
    const value = row[index];
    return typeof value === 'number' ? value : 0;
  });
  const max = Math.max(1, ...values.map(Math.abs));

  const keyCount = Math.max(1, result.meta?.key_columns ?? 1);

  return (
    <div className="bars">
      {rows.map(({ key, row }, position) => {
        const value = values[position] ?? 0;
        const label = row.slice(0, keyCount).map((v) => formatCell(v)).join(' · ');
        return (
          <div className="bar" key={key}>
            <span className="bar__label" title={label}>
              {label}
            </span>
            <span className="bar__track">
              <span
                className="bar__fill"
                style={{
                  width: `${(Math.abs(value) / max) * 100}%`,
                  background: `var(${SERIES[position % SERIES.length]})`,
                }}
              />
            </span>
            <span className="bar__value">{formatCell(value)}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Plain-language labels for the columns the presets produce.
 *
 * A number without a unit is not information: "typical bytes 9.57" tells a
 * reader nothing, while "about 10 characters — roughly two words" tells them
 * that most Wikipedia edits are tiny. Unknown columns fall back to the raw
 * name, so a hand-written query still renders sensibly.
 */
const STAT_COPY: Record<string, { label: string; note: (value: number) => string }> = {
  edits: {
    label: 'Edits measured',
    note: () => 'Human edits to Wikipedia articles in this window.',
  },
  typical_bytes: {
    label: 'A typical edit',
    note: (v) => `Half of all edits change less than this — roughly ${words(v)}.`,
  },
  large_bytes: {
    label: 'A large edit',
    note: () => 'Only 1 edit in 20 is bigger than this.',
  },
  huge_bytes: {
    label: 'A very large edit',
    note: () => 'Only 1 edit in 100 is bigger than this.',
  },
  largest: {
    label: 'Biggest single edit',
    note: (v) => `Someone added about ${words(v)} in one go.`,
  },
};

function words(bytes: number): string {
  // Rough but honest: ~5 characters per word in Latin scripts, and one byte per
  // character. Stated as an approximation because it is one.
  const count = Math.max(1, Math.round(Math.abs(bytes) / 5));
  return count === 1 ? 'one word' : `${count.toLocaleString()} words`;
}

function statDisplay(name: string, value: Scalar): string {
  if (typeof value !== 'number') return formatCell(value);
  if (name === 'edits') return formatNumber(value);
  // Byte-valued columns get a unit, so the number means something.
  const abs = Math.abs(value);
  if (abs < 1024) return `${value.toFixed(abs < 10 ? 1 : 0)} B`;
  return `${(value / 1024).toFixed(1)} kB`;
}

function StatGrid({ result, rows }: { result: LiveResult; rows: Array<{ key: string; row: Row }> }) {
  const row = rows[0]?.row;
  if (!row) return <p className="empty">No data yet.</p>;

  return (
    <>
      <div className="stats">
        {result.columns.map((name, index) => {
          const value = row[index] ?? null;
          const copy = STAT_COPY[name];
          return (
            <div className="stat" key={`${name}:${index}`}>
              <div className="stat__label">{copy?.label ?? name.replace(/_/g, ' ')}</div>
              <div className="stat__value">{statDisplay(name, value)}</div>
              {copy && typeof value === 'number' && (
                <div className="stat__note">{copy.note(value)}</div>
              )}
            </div>
          );
        })}
      </div>
      <p className="stats__footnote">
        A byte is roughly one character. Most edits fix a word or a link; a rare few rewrite an
        entire article.
      </p>
    </>
  );
}
