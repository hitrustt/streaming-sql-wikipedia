import type { ReactNode } from 'react';
import type { SqlErrorInfo } from './types';

/**
 * Minimal SQL tokenizer for display only.
 *
 * Deliberately independent of the server's lexer: this one must never throw and
 * must colour *invalid* text too, since the user is mid-keystroke most of the
 * time. It walks the source and emits spans, then overlays the error range on
 * top so the offending token gets underlined wherever it falls.
 */

const KEYWORDS = new Set([
  'select', 'from', 'where', 'group', 'by', 'order', 'limit', 'window', 'and',
  'or', 'not', 'as', 'asc', 'desc', 'distinct', 'like', 'in', 'is', 'null',
  'true', 'false', 'case', 'when', 'then', 'else', 'end',
]);

const FUNCTIONS = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'percentile', 'top_k', 'lower', 'upper',
  'length', 'abs', 'round', 'coalesce', 'substr', 'now',
]);

type Span = { start: number; end: number; cls: string };

function scan(src: string): Span[] {
  const spans: Span[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i]!;

    if (c === '-' && src[i + 1] === '-') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      spans.push({ start: i, end: stop, cls: 'tok-com' });
      i = stop;
      continue;
    }

    if (c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") j += 2;
        else if (src[j] === "'") break;
        else j += 1;
      }
      spans.push({ start: i, end: Math.min(j + 1, src.length), cls: 'tok-str' });
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9._smhd]/.test(src[j]!)) j += 1;
      spans.push({ start: i, end: j, cls: 'tok-num' });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      const word = src.slice(i, j).toLowerCase();
      // A name followed by '(' is a call, which reads better in the function
      // colour even when the name is not one we know.
      const isCall = src.slice(j).trimStart().startsWith('(');
      if (KEYWORDS.has(word)) spans.push({ start: i, end: j, cls: 'tok-kw' });
      else if (FUNCTIONS.has(word) || isCall) spans.push({ start: i, end: j, cls: 'tok-fn' });
      i = j;
      continue;
    }

    i += 1;
  }

  return spans;
}

export function highlight(src: string, error: SqlErrorInfo | null): ReactNode[] {
  const spans = scan(src);

  // Build a per-character class map, then coalesce back into runs. Simpler and
  // more robust than trying to intersect the error range with token boundaries,
  // and the strings involved are a few hundred characters at most.
  const classes = new Array<string>(src.length).fill('');
  for (const span of spans) {
    for (let i = span.start; i < span.end && i < src.length; i += 1) classes[i] = span.cls;
  }

  if (error && error.end > error.start) {
    const from = Math.max(0, Math.min(error.start, src.length));
    const to = Math.max(from, Math.min(error.end, src.length));
    for (let i = from; i < to; i += 1) {
      classes[i] = `${classes[i] ?? ''} tok-err`.trim();
    }
  }

  const out: ReactNode[] = [];
  let index = 0;
  let cursor = 0;

  while (cursor < src.length) {
    const cls = classes[cursor] ?? '';
    let end = cursor + 1;
    while (end < src.length && (classes[end] ?? '') === cls) end += 1;
    const text = src.slice(cursor, end);
    out.push(
      cls ? (
        <span key={index} className={cls}>
          {text}
        </span>
      ) : (
        <span key={index}>{text}</span>
      ),
    );
    index += 1;
    cursor = end;
  }

  // A trailing newline needs a following character or the <pre> collapses it and
  // the highlight layer ends up one line shorter than the textarea.
  out.push(<span key="tail">{'\n '}</span>);
  return out;
}
