/**
 * Hand-written tokenizer for the Riverbed SQL dialect.
 *
 * Deliberately not a regex soup: a single left-to-right scan that tracks source
 * offsets, so parse errors can point at the exact character the user typed. The
 * editor underlines the offending token using these offsets, which is the
 * difference between "syntax error" and a message someone can act on.
 */

export type TokType =
  | 'ident'
  | 'number'
  | 'string'
  | 'keyword'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'star'
  | 'duration'
  | 'eof';

export interface Token {
  type: TokType;
  value: string;
  start: number;
  end: number;
}

export const KEYWORDS = new Set([
  'select', 'from', 'where', 'group', 'by', 'order', 'limit', 'window',
  'and', 'or', 'not', 'as', 'asc', 'desc', 'distinct', 'like', 'in',
  'is', 'null', 'true', 'false', 'case', 'when', 'then', 'else', 'end',
]);

/** Longest-first, so '>=' is matched before '>'. */
const OPERATORS = ['>=', '<=', '!=', '<>', '||', '=', '<', '>', '+', '-', '*', '/', '%'];

const DURATION_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * A user-facing SQL error carrying source offsets for underlining.
 *
 * Everything the user can trigger by typing goes through this class, so the UI
 * can render a structured error instead of a stack trace.
 */
export class SqlError extends Error {
  readonly start: number;
  readonly end: number;
  readonly hint: string | null;

  constructor(message: string, start = 0, end = 0, hint: string | null = null) {
    super(message);
    this.name = 'SqlError';
    this.start = start;
    this.end = end;
    this.hint = hint;
  }

  toJSON() {
    return { message: this.message, start: this.start, end: this.end, hint: this.hint };
  }
}

const isDigit = (c: string) => c >= '0' && c <= '9';
const isAlpha = (c: string) => /[A-Za-z_]/.test(c);
const isAlnum = (c: string) => /[A-Za-z0-9_]/.test(c);

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src[i]!;

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i += 1;
      continue;
    }

    // Line comments.
    if (c === '-' && src[i + 1] === '-') {
      const j = src.indexOf('\n', i);
      i = j === -1 ? n : j + 1;
      continue;
    }

    // Single-quoted strings; '' escapes an embedded quote.
    if (c === "'") {
      let j = i + 1;
      const buf: string[] = [];
      for (;;) {
        if (j >= n) {
          throw new SqlError('Unterminated string literal.', i, n, 'Add a closing single quote.');
        }
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            buf.push("'");
            j += 2;
            continue;
          }
          break;
        }
        buf.push(src[j]!);
        j += 1;
      }
      tokens.push({ type: 'string', value: buf.join(''), start: i, end: j + 1 });
      i = j + 1;
      continue;
    }

    // Numbers, and durations such as 5m / 30s / 2h / 1d.
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i;
      let seenDot = false;
      while (j < n && (isDigit(src[j]!) || (src[j] === '.' && !seenDot))) {
        if (src[j] === '.') seenDot = true;
        j += 1;
      }
      // A bare unit letter directly after the digits makes it a duration.
      const unit = src[j] ?? '';
      if (!seenDot && unit in DURATION_UNITS) {
        const next = src[j + 1] ?? '';
        if (next === '' || !isAlnum(next)) {
          tokens.push({ type: 'duration', value: src.slice(i, j + 1), start: i, end: j + 1 });
          i = j + 1;
          continue;
        }
      }
      tokens.push({ type: 'number', value: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    // Identifiers and keywords.
    if (isAlpha(c)) {
      let j = i;
      while (j < n && isAlnum(src[j]!)) j += 1;
      const word = src.slice(i, j);
      tokens.push({
        type: KEYWORDS.has(word.toLowerCase()) ? 'keyword' : 'ident',
        value: word,
        start: i,
        end: j,
      });
      i = j;
      continue;
    }

    // Double-quoted identifiers, for names that collide with keywords.
    if (c === '"') {
      const j = src.indexOf('"', i + 1);
      if (j === -1) throw new SqlError('Unterminated quoted identifier.', i, n);
      tokens.push({ type: 'ident', value: src.slice(i + 1, j), start: i, end: j + 1 });
      i = j + 1;
      continue;
    }

    if (c === '(') { tokens.push({ type: 'lparen', value: c, start: i, end: i + 1 }); i += 1; continue; }
    if (c === ')') { tokens.push({ type: 'rparen', value: c, start: i, end: i + 1 }); i += 1; continue; }
    if (c === ',') { tokens.push({ type: 'comma', value: c, start: i, end: i + 1 }); i += 1; continue; }

    const op = OPERATORS.find((candidate) => src.startsWith(candidate, i));
    if (op) {
      // '*' gets its own type so `SELECT *` and `a * b` are distinguishable
      // without lookbehind hacks in the parser.
      tokens.push({ type: op === '*' ? 'star' : 'op', value: op, start: i, end: i + op.length });
      i += op.length;
      continue;
    }

    throw new SqlError(`Unexpected character '${c}'.`, i, i + 1);
  }

  tokens.push({ type: 'eof', value: '', start: n, end: n });
  return tokens;
}

/** '5m' -> 300. Assumes the lexer already validated the shape. */
export function parseDuration(text: string): number {
  const unit = text[text.length - 1]!;
  return Number(text.slice(0, -1)) * DURATION_UNITS[unit]!;
}
