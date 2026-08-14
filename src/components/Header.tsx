import { formatNumber } from '../lib/format';
import type { Row, StoreStats } from '../lib/types';

interface Props {
  stats: StoreStats | null;
  headline: Row | null;
  headlineColumns: string[];
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

/**
 * Column order from HEADLINE_SQL: edits, editors, pages, net_bytes.
 *
 * These count *all* Wikimedia activity, bots included, while most views default
 * to human article edits. The labels say "all wikis" so the header and the
 * panels below cannot be mistaken for measuring the same thing.
 */
const HEADLINE_LABELS: Record<string, string> = {
  edits: 'Edits · 5m · all wikis',
  editors: 'Editors · 5m',
  pages: 'Pages · 5m',
};

export function Header({ stats, headline, headlineColumns, theme, onToggleTheme }: Props) {
  return (
    <header className="header">
      <div className="brand">
        {/* Flowing, unequal strokes rather than three equal horizontal bars:
            the latter is the universal hamburger-menu glyph, and a logo that
            looks like a button but isn't one is a broken affordance. */}
        <svg className="brand__mark" viewBox="0 0 18 16" aria-hidden="true" fill="none">
          <path
            d="M1 4.5c2.4 0 2.4 2 4.8 2s2.4-2 4.8-2 2.4 2 4.8 2"
            stroke="var(--accent)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            d="M1 9c2.4 0 2.4 2 4.8 2s2.4-2 4.8-2 2.4 2 4.8 2"
            stroke="var(--accent)"
            strokeWidth="1.6"
            strokeLinecap="round"
            opacity="0.55"
          />
        </svg>
        <span className="brand__name">Riverbed</span>
        <span className="brand__tag">streaming SQL over Wikipedia's edit firehose</span>
      </div>

      <div className="readout">
        {headlineColumns.map((name, index) => {
          const label = HEADLINE_LABELS[name];
          if (!label) return null;
          const value = headline?.[index];
          return (
            <div className="readout__cell" key={name}>
              <span className="readout__label">{label}</span>
              <span className="readout__value">
                {typeof value === 'number' ? formatNumber(value) : '—'}
              </span>
            </div>
          );
        })}

        <div className="readout__cell">
          <span className="readout__label">Ingest rate</span>
          <span className="readout__value">
            {stats ? `${stats.eventsPerSecond.toFixed(1)}/s` : '—'}
          </span>
        </div>

        <div className="readout__cell">
          <span className="readout__label">Buffered</span>
          <span className="readout__value">
            {stats ? formatNumber(stats.bufferedRows) : '—'}
          </span>
        </div>

        {/* Connection state is not shown here. When the socket drops, the banner
            below the header says so outright, which is more useful than a status
            light that says "fine" 99% of the time. */}
        <div className="readout__cell" style={{ minWidth: 0, justifyContent: 'center' }}>
          <button
            className="btn btn--ghost"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </div>
    </header>
  );
}
