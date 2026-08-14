import { useEffect, useLayoutEffect, useRef } from 'react';
import { highlight } from '../lib/highlight';
import type { SqlErrorInfo } from '../lib/types';

interface Props {
  value: string;
  onChange: (sql: string) => void;
  onRun: () => void;
  error: SqlErrorInfo | null;
  dirty: boolean;
}

export function QueryEditor({ value, onChange, onRun, error, dirty }: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const layerRef = useRef<HTMLPreElement>(null);

  // The textarea grows to fit its content so the highlight layer underneath is
  // never clipped or scrolled out of register.
  useLayoutEffect(() => {
    const input = inputRef.current;
    const layer = layerRef.current;
    if (!input || !layer) return;
    input.style.height = 'auto';
    const height = Math.max(84, layer.scrollHeight);
    input.style.height = `${height}px`;
  }, [value]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Ctrl/Cmd+Enter runs from anywhere on the page, which is the muscle
      // memory anyone who uses a SQL client already has.
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        onRun();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRun]);

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">Query</span>
        <span className="panel__meta">edits · one table, {'{'}15 columns{'}'}</span>
      </div>

      <div className="editor">
        <pre className="editor__layer" ref={layerRef} aria-hidden="true">
          {highlight(value, error)}
        </pre>
        <textarea
          ref={inputRef}
          className="editor__input"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="SQL query"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              // Trap Tab so it indents rather than escaping the editor. The
              // keyboard escape route is Escape-then-Tab, which screen reader
              // users expect from a code editor.
              event.preventDefault();
              const target = event.currentTarget;
              const { selectionStart, selectionEnd } = target;
              const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
              onChange(next);
              requestAnimationFrame(() => {
                target.selectionStart = target.selectionEnd = selectionStart + 2;
              });
            }
          }}
        />
      </div>

      <div className="editor__bar">
        {error ? (
          <span className="error">
            <span>{error.message}</span>
            {error.hint && <span className="error__hint">{error.hint}</span>}
          </span>
        ) : (
          <span className="panel__meta">
            {dirty ? 'Unsaved changes' : 'Running continuously'}
          </span>
        )}

        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 'none' }}>
          <span className="kbd">{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+↵</span>
          {/* Never disabled. A Run button that silently does nothing on a fresh
              page load reads as a broken app, and re-running an unchanged query
              is harmless -- it just resubscribes. */}
          <button className="btn btn--primary" onClick={onRun}>
            {dirty ? 'Run' : 'Re-run'}
          </button>
        </span>
      </div>
    </div>
  );
}
