import { useEffect, useRef, useState } from 'react';
import { NAMESPACES, formatBytes } from '../lib/format';
import type { EditEvent } from '../lib/types';

/**
 * The raw stream, as it arrives.
 *
 * This panel is doing product work rather than engineering work: it is the
 * proof that the numbers elsewhere on screen come from real edits to real
 * articles by real people. Every title links to the actual page, because the
 * moment a visitor clicks through and lands on a Wikipedia article that was
 * edited four seconds ago is the moment the whole thing stops looking like a
 * mock-up.
 */
export function LiveFeed({ events, paused, onTogglePause, humanOnly, onToggleHumanOnly }: {
  events: EditEvent[];
  paused: boolean;
  onTogglePause: () => void;
  humanOnly: boolean;
  onToggleHumanOnly: () => void;
}) {
  const [shown, setShown] = useState<EditEvent[]>([]);
  const seen = useRef<Set<string>>(new Set());

  // Switching the filter changes what the list is *of*, so the accumulated
  // history is discarded rather than left showing rows the filter excludes.
  useEffect(() => {
    setShown([]);
    seen.current = new Set();
  }, [humanOnly]);

  useEffect(() => {
    if (paused) return;
    setShown((previous) => {
      const identity = (event: EditEvent) => `${event.ts}:${event.title}:${event.user}`;
      const fresh = events.filter((event) => !seen.current.has(identity(event)));
      if (fresh.length === 0) return previous;
      for (const event of fresh) seen.current.add(identity(event));

      // Bound the seen-set alongside the visible list, or it grows without
      // limit over a long session.
      if (seen.current.size > 600) {
        seen.current = new Set([...seen.current].slice(-300));
      }
      return [...fresh.reverse(), ...previous].slice(0, 40);
    });
  }, [events, paused]);

  return (
    <div className="panel panel--grow">
      <div className="panel__head">
        <span className="panel__title">The raw stream</span>
        <span style={{ display: 'flex', gap: 2 }}>
          <button className="btn btn--ghost" onClick={onToggleHumanOnly}>
            {humanOnly ? 'People' : 'Everything'}
          </button>
          <button className="btn btn--ghost" onClick={onTogglePause}>
            {paused ? 'Resume' : 'Pause'}
          </button>
        </span>
      </div>
      <div className="hint">
        {humanOnly ? (
          <>People editing Wikipedia articles, as it happens. Titles link to the real page.</>
        ) : (
          <>
            The unfiltered firehose — including bots and <code>Q…</code> Wikidata records, which are
            most of it.
          </>
        )}
      </div>
      <div className="panel__body scroll-fade feed">
        {shown.length === 0 && <p className="empty">Waiting for the stream…</p>}
        {shown.map((event, index) => (
          <article
            className={index === 0 && !paused ? 'event event--new' : 'event'}
            key={`${event.ts}:${event.title}:${event.user}:${index}`}
          >
            <span className="event__title">
              {event.uri ? (
                <a href={event.uri} target="_blank" rel="noreferrer noopener" title={event.title}>
                  {event.title}
                </a>
              ) : (
                event.title
              )}
            </span>
            {/* A zero-byte edit is common and real -- a link fixed, a template
                swapped -- but rendering it as "+0 B" looks like a bug, so it
                says what actually happened instead. */}
            <span
              className={
                event.delta === 0 ? 'event__delta muted' : `event__delta ${event.delta > 0 ? 'pos' : 'neg'}`
              }
            >
              {event.delta === 0 ? 'same size' : formatBytes(event.delta)}
            </span>
            <span className="event__meta">
              <span className="chip">{event.lang === '-' ? event.project : event.lang}</span>
              {event.is_bot && <span className="chip chip--bot">bot</span>}
              {event.is_anon && <span className="chip chip--anon">anon</span>}
              {event.type === 'new' && <span className="chip">new</span>}
              {event.namespace !== 0 && (
                <span className="chip">{NAMESPACES[event.namespace] ?? `ns${event.namespace}`}</span>
              )}
              <span
                style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
                title={event.comment || undefined}
              >
                {event.user}
                {event.comment ? ` — ${event.comment}` : ''}
              </span>
            </span>
          </article>
        ))}
      </div>
    </div>
  );
}
