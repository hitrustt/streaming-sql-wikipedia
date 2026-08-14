import {
  type AggCall, type Expr, type Query, type SelectItem,
  children, hasAggregate, keyOf, walk,
} from './ast';
import { SqlError } from './lexer';
import { COLUMNS, COLUMNS_BY_NAME, type CellValue } from './schema';

/**
 * Validation, optimization, and compilation of a parsed query.
 *
 * Three jobs before a single row is touched:
 *
 * 1. Validate against the schema, so an unknown column is caught with a
 *    suggestion instead of blowing up mid-scan on row 40,000.
 * 2. Optimize: constant-fold literal subtrees, and order the WHERE conjuncts so
 *    cheap predicates reject rows before expensive ones run (a LIKE over
 *    `comment` costs far more than `is_bot = false`).
 * 3. Compile each expression into a closure over the column arrays. Walking the
 *    AST per row costs a dispatch on every node for every row; compiling once
 *    removes that from the inner loop entirely, which is the difference between
 *    a query feeling instant and feeling broken.
 */

export const TABLES = new Set(['edits']);

/** Relative cost weights, used only to order conjuncts. */
const COST = { column: 1, literal: 0, compare: 2, like: 20, func: 5, in: 3 } as const;

export type Columns = Record<string, CellValue[]>;

/** Compiled expression: row index plus finished aggregate values. */
export type CompiledExpr = (i: number, aggs: unknown[]) => unknown;

/** Compiled expression that cannot reference aggregates. */
export type RowFn = (i: number) => unknown;

export interface AggSpec {
  name: string;
  arg: RowFn | null;
  extra: number | null;
}

export interface Plan {
  query: Query;
  where: ((i: number) => boolean) | null;
  groupKeys: Array<{ name: string; fn: RowFn }>;
  aggs: AggSpec[];
  projections: Array<{ name: string; fn: CompiledExpr }>;
  orderBy: Array<{ fn: CompiledExpr; descending: boolean }>;
  limit: number | null;
  windowSeconds: number | null;
  isAggregate: boolean;
  columnsUsed: Set<string>;
}

const NO_AGGS: unknown[] = [];

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Levenshtein distance, for "did you mean" suggestions on unknown columns. */
function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

function checkColumn(name: string, start: number, end: number): void {
  if (COLUMNS_BY_NAME.has(name)) return;

  let best: string | null = null;
  let bestScore = Infinity;
  for (const column of COLUMNS) {
    const distance = editDistance(name.toLowerCase(), column.name.toLowerCase());
    if (distance < bestScore) {
      bestScore = distance;
      best = column.name;
    }
  }

  // Only suggest when the guess is genuinely close; a wrong suggestion is
  // worse than none.
  const hint = best && bestScore <= Math.max(2, Math.floor(name.length / 3))
    ? `Did you mean '${best}'?`
    : `Available columns: ${COLUMNS.map((c) => c.name).join(', ')}`;

  throw new SqlError(`Unknown column '${name}'.`, start, end, hint);
}

// ---------------------------------------------------------------------------
// Optimization
// ---------------------------------------------------------------------------

function fold(expr: Expr): Expr {
  if (expr.kind === 'binary') {
    const left = fold(expr.left);
    const right = fold(expr.right);
    if (left.kind === 'literal' && right.kind === 'literal') {
      try {
        return {
          kind: 'literal',
          value: applyBinary(expr.op, left.value, right.value) as CellValue,
          start: expr.start,
          end: expr.end,
        };
      } catch {
        // Leave it to fail at runtime against real values.
      }
    }
    return { ...expr, left, right };
  }

  if (expr.kind === 'unary') {
    const operand = fold(expr.operand);
    if (operand.kind === 'literal') {
      if (expr.op === '-' && typeof operand.value === 'number') {
        return { kind: 'literal', value: -operand.value, start: expr.start, end: expr.end };
      }
      if (expr.op === 'not') {
        return { kind: 'literal', value: !truthy(operand.value), start: expr.start, end: expr.end };
      }
    }
    return { ...expr, operand };
  }

  return expr;
}

function cost(expr: Expr): number {
  switch (expr.kind) {
    case 'literal':
      return COST.literal;
    case 'column':
      return COST.column;
    case 'like':
      return COST.like + cost(expr.operand);
    case 'in':
      return COST.in + cost(expr.operand);
    case 'func':
      return COST.func + expr.args.reduce((sum, a) => sum + cost(a), 0);
    case 'binary':
      return COST.compare + cost(expr.left) + cost(expr.right);
    default:
      return children(expr).reduce((sum, c) => sum + cost(c), 0) + 1;
  }
}

function splitConjuncts(expr: Expr): Expr[] {
  if (expr.kind === 'binary' && expr.op === 'and') {
    return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
  }
  return [expr];
}

/** Cheapest conjunct first, so short-circuiting rejects rows sooner. */
export function reorderWhere(expr: Expr): Expr {
  const parts = splitConjuncts(expr);
  if (parts.length < 2) return expr;

  parts.sort((a, b) => cost(a) - cost(b));
  let out = parts[0]!;
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i]!;
    out = { kind: 'binary', op: 'and', left: out, right: part, start: out.start, end: part.end };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------

export function truthy(v: unknown): boolean {
  return Boolean(v);
}

export function applyBinary(op: string, a: unknown, b: unknown): unknown {
  switch (op) {
    case 'and':
      return truthy(a) && truthy(b);
    case 'or':
      return truthy(a) || truthy(b);
    case '=':
      return a === b;
    case '!=':
    case '<>':
      return a !== b;
    case '||':
      return `${a}${b}`;
    default:
      break;
  }

  if (op === '<' || op === '>' || op === '<=' || op === '>=') {
    // Comparing a string column against a number is a common typo; give a real
    // message rather than a silent `false` from JavaScript's coercion rules.
    if ((typeof a === 'string') !== (typeof b === 'string')) {
      throw new SqlError(`Cannot compare ${typeof a} with ${typeof b}.`);
    }
    const x = a as number;
    const y = b as number;
    if (op === '<') return x < y;
    if (op === '>') return x > y;
    if (op === '<=') return x <= y;
    return x >= y;
  }

  const x = Number(a);
  const y = Number(b);
  switch (op) {
    case '+':
      return x + y;
    case '-':
      return x - y;
    case '*':
      return x * y;
    // Division by zero yields 0 rather than Infinity or NaN: a live dashboard
    // showing "Infinity" reads as a crash.
    case '/':
      return y === 0 ? 0 : x / y;
    case '%':
      return y === 0 ? 0 : x % y;
    default:
      throw new SqlError(`Unsupported operator '${op}'.`);
  }
}

/**
 * Translate SQL LIKE into a predicate.
 *
 * Fast paths for the three shapes that cover nearly all real usage ('%x%',
 * 'x%', '%x') skip the regex engine entirely, which matters when the predicate
 * runs over tens of thousands of rows every second.
 */
export function likeMatcher(pattern: string): (s: string) => boolean {
  const hasUnderscore = pattern.includes('_');

  if (!hasUnderscore && pattern.startsWith('%') && pattern.endsWith('%') && pattern.length > 1
      && !pattern.slice(1, -1).includes('%')) {
    const needle = pattern.slice(1, -1).toLowerCase();
    return (s) => s.toLowerCase().includes(needle);
  }
  if (!hasUnderscore && pattern.endsWith('%') && !pattern.slice(0, -1).includes('%')) {
    const prefix = pattern.slice(0, -1).toLowerCase();
    return (s) => s.toLowerCase().startsWith(prefix);
  }
  if (!hasUnderscore && pattern.startsWith('%') && !pattern.slice(1).includes('%')) {
    const suffix = pattern.slice(1).toLowerCase();
    return (s) => s.toLowerCase().endsWith(suffix);
  }

  const source = [...pattern]
    .map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  const regex = new RegExp(`^${source}$`, 'is');
  return (s) => regex.test(s);
}

const SCALAR_IMPL: Record<string, (...args: any[]) => unknown> = {
  lower: (s) => String(s).toLowerCase(),
  upper: (s) => String(s).toUpperCase(),
  length: (s) => String(s).length,
  abs: (x) => Math.abs(Number(x)),
  round: (x, d = 0) => {
    const factor = 10 ** Number(d);
    return Math.round(Number(x) * factor) / factor;
  },
  coalesce: (...xs: unknown[]) => xs.find((x) => x !== null && x !== '') ?? null,
  substr: (s, start, n) =>
    n === undefined
      ? String(s).slice(Number(start))
      : String(s).slice(Number(start), Number(start) + Number(n)),
};

const ARITY: Record<string, [number, number]> = {
  lower: [1, 1], upper: [1, 1], length: [1, 1], abs: [1, 1],
  round: [1, 2], coalesce: [1, 8], substr: [2, 3], now: [0, 0],
};

const AGG_ARITY: Record<string, [number, number]> = {
  count: [0, 1], count_distinct: [1, 1], sum: [1, 1], avg: [1, 1],
  min: [1, 1], max: [1, 1], percentile: [2, 2], top_k: [1, 2],
};

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Compiles AST nodes into closures over a column map.
 *
 * Each closure takes a row index and the finished aggregate values. Non-
 * aggregate expressions ignore the second argument; aggregate references read
 * their slot from it. That single uniform signature is what lets projections
 * mix grouped columns and aggregates (`SELECT lang, count(*) / 60`) without a
 * second code path.
 */
class Compiler {
  readonly aggSpecs: AggSpec[] = [];
  readonly columnsUsed = new Set<string>();
  private readonly aggSlots = new Map<string, number>();

  constructor(private readonly columns: Columns, private readonly now: number) {}

  private aggSlot(node: AggCall): number {
    // Keyed structurally so `count(*)` in both SELECT and ORDER BY is computed
    // once rather than twice.
    const key = `${node.name}|${node.distinct}|${node.args.map(keyOf).join(',')}`;
    const existing = this.aggSlots.get(key);
    if (existing !== undefined) return existing;

    const [lo, hi] = AGG_ARITY[node.name] ?? [0, 0];
    if (node.args.length < lo || node.args.length > hi) {
      throw new SqlError(
        `${node.name}() takes ${lo} to ${hi} arguments, got ${node.args.length}.`,
        node.start,
        node.end,
      );
    }
    for (const arg of node.args) {
      if (hasAggregate(arg)) {
        throw new SqlError('Aggregates cannot be nested.', node.start, node.end);
      }
    }

    let extra: number | null = null;
    let arg: RowFn | null = null;

    if (node.name === 'percentile') {
      const pct = node.args[1]!;
      if (pct.kind !== 'literal' || typeof pct.value !== 'number') {
        throw new SqlError(
          'percentile() needs a constant percentile, e.g. percentile(delta, 95).',
          node.start,
          node.end,
        );
      }
      if (pct.value < 0 || pct.value > 100) {
        throw new SqlError('Percentile must be between 0 and 100.', node.start, node.end);
      }
      extra = pct.value / 100;
      arg = this.wrap(this.compile(node.args[0]!));
    } else if (node.name === 'top_k') {
      extra = 10;
      if (node.args.length === 2) {
        const k = node.args[1]!;
        if (k.kind !== 'literal' || typeof k.value !== 'number' || !Number.isInteger(k.value)) {
          throw new SqlError('top_k() needs a constant whole-number k.', node.start, node.end);
        }
        extra = Math.max(1, Math.min(k.value, 100));
      }
      arg = this.wrap(this.compile(node.args[0]!));
    } else if (node.args.length > 0) {
      arg = this.wrap(this.compile(node.args[0]!));
    }

    const slot = this.aggSpecs.length;
    this.aggSlots.set(key, slot);
    this.aggSpecs.push({ name: node.name, arg, extra });
    return slot;
  }

  /** Aggregate arguments can never contain aggregates, so drop the slot list. */
  private wrap(fn: CompiledExpr): RowFn {
    return (i) => fn(i, NO_AGGS);
  }

  compile(expr: Expr): CompiledExpr {
    switch (expr.kind) {
      case 'literal': {
        const { value } = expr;
        return () => value;
      }

      case 'column': {
        checkColumn(expr.name, expr.start, expr.end);
        this.columnsUsed.add(expr.name);
        const col = this.columns[expr.name]!;
        return (i) => col[i];
      }

      case 'agg': {
        const slot = this.aggSlot(expr);
        return (_i, aggs) => aggs[slot];
      }

      case 'binary': {
        const { op, start, end } = expr;
        const left = this.compile(expr.left);
        const right = this.compile(expr.right);
        if (op === 'and') return (i, a) => truthy(left(i, a)) && truthy(right(i, a));
        if (op === 'or') return (i, a) => truthy(left(i, a)) || truthy(right(i, a));
        return (i, a) => {
          try {
            return applyBinary(op, left(i, a), right(i, a));
          } catch (err) {
            if (err instanceof SqlError) throw new SqlError(err.message, start, end, err.hint);
            throw err;
          }
        };
      }

      case 'unary': {
        const operand = this.compile(expr.operand);
        if (expr.op === '-') return (i, a) => -Number(operand(i, a));
        return (i, a) => !truthy(operand(i, a));
      }

      case 'like': {
        const operand = this.compile(expr.operand);
        if (expr.pattern.kind !== 'literal' || typeof expr.pattern.value !== 'string') {
          throw new SqlError(
            'LIKE needs a constant string pattern.',
            expr.start,
            expr.end,
            "Example: title LIKE '%Climate%'",
          );
        }
        const matcher = likeMatcher(expr.pattern.value);
        const { negated } = expr;
        return (i, a) => {
          const hit = matcher(String(operand(i, a)));
          return negated ? !hit : hit;
        };
      }

      case 'in': {
        const operand = this.compile(expr.operand);
        const { negated } = expr;
        if (expr.values.every((v) => v.kind === 'literal')) {
          // Set membership instead of a linear chain of comparisons.
          const members = new Set(expr.values.map((v) => (v as { value: unknown }).value));
          return (i, a) => {
            const hit = members.has(operand(i, a) as never);
            return negated ? !hit : hit;
          };
        }
        const valueFns = expr.values.map((v) => this.compile(v));
        return (i, a) => {
          const value = operand(i, a);
          const hit = valueFns.some((fn) => fn(i, a) === value);
          return negated ? !hit : hit;
        };
      }

      case 'isnull': {
        const operand = this.compile(expr.operand);
        const { negated } = expr;
        // There are no true NULLs in the stream; absent values normalize to the
        // column's zero value, so IS NULL means "empty".
        return (i, a) => {
          const value = operand(i, a);
          const empty = value === null || value === undefined || value === '';
          return negated ? !empty : empty;
        };
      }

      case 'case': {
        const branches = expr.whens.map(({ cond, then }) => ({
          cond: this.compile(cond),
          then: this.compile(then),
        }));
        const otherwise = expr.otherwise ? this.compile(expr.otherwise) : null;
        return (i, a) => {
          for (const branch of branches) {
            if (truthy(branch.cond(i, a))) return branch.then(i, a);
          }
          return otherwise ? otherwise(i, a) : null;
        };
      }

      case 'func': {
        const { name, start, end } = expr;
        const [lo, hi] = ARITY[name] ?? [0, 0];
        if (expr.args.length < lo || expr.args.length > hi) {
          throw new SqlError(
            `${name}() takes ${lo} to ${hi} arguments, got ${expr.args.length}.`,
            start,
            end,
          );
        }
        if (name === 'now') {
          const now = this.now;
          return () => now;
        }
        const impl = SCALAR_IMPL[name]!;
        const argFns = expr.args.map((arg) => this.compile(arg));
        return (i, a) => {
          try {
            return impl(...argFns.map((fn) => fn(i, a)));
          } catch (err) {
            if (err instanceof SqlError) throw err;
            throw new SqlError(`${name}() failed.`, start, end);
          }
        };
      }

      default:
        throw new SqlError('Cannot evaluate this expression.');
    }
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function displayName(item: SelectItem, index: number): string {
  if (item.alias) return item.alias;
  const { expr } = item;
  if (expr.kind === 'column') return expr.name;
  if (expr.kind === 'agg') {
    if (expr.name === 'count' && expr.args.length === 0) return 'count';
    const first = expr.args[0];
    if (first && first.kind === 'column') return `${expr.name}_${first.name}`;
    return expr.name;
  }
  return `col${index + 1}`;
}

/**
 * Let ORDER BY and GROUP BY reference a SELECT alias by name.
 *
 * `SELECT count(*) AS n ... ORDER BY n DESC` is the most common thing anyone
 * types, and rejecting it because `n` is not a column would be hostile. A bare
 * name that is neither an alias nor a column falls through to normal column
 * validation, which produces the better error message.
 */
function resolveAlias(expr: Expr, items: SelectItem[]): Expr {
  if (expr.kind === 'column' && !COLUMNS_BY_NAME.has(expr.name)) {
    for (const item of items) {
      if (item.alias === expr.name) return item.expr;
    }
  }
  return expr;
}

/**
 * Reject bare columns in a grouped SELECT that are not a grouping key.
 *
 * Walks top-down and prunes: an expression that *is* a grouping key, or is an
 * aggregate, is legal in its entirety and its children need no checking. Most
 * engines silently return an arbitrary row's value here; on a live query that
 * means a number flickering every tick, so it is better rejected outright.
 */
function checkGrouped(expr: Expr, groupKeys: Set<string>): void {
  if (groupKeys.has(keyOf(expr)) || expr.kind === 'agg') return;

  if (expr.kind === 'column') {
    throw new SqlError(
      `Column '${expr.name}' must appear in GROUP BY or inside an aggregate.`,
      expr.start,
      expr.end,
      `Either add it: GROUP BY ${expr.name}, or wrap it, e.g. max(${expr.name}).`,
    );
  }

  for (const child of children(expr)) checkGrouped(child, groupKeys);
}

export function plan(query: Query, columns: Columns, now: number): Plan {
  if (!TABLES.has(query.fromTable)) {
    throw new SqlError(
      `Unknown table '${query.fromTable}'.`,
      0,
      0,
      `The only table is ${[...TABLES].join(', ')}.`,
    );
  }

  const compiler = new Compiler(columns, now);

  // WHERE cannot contain aggregates; that would be HAVING, which this dialect
  // does not support.
  let where: ((i: number) => boolean) | null = null;
  if (query.where) {
    if (hasAggregate(query.where)) {
      throw new SqlError(
        'Aggregates are not allowed in WHERE.',
        query.where.start,
        query.where.end,
        "Filter on raw columns; aggregate filters aren't supported.",
      );
    }
    const compiled = compiler.compile(reorderWhere(fold(query.where)));
    where = (i) => truthy(compiled(i, NO_AGGS));
  }

  let selectItems = query.select;
  if (query.star) {
    selectItems = COLUMNS.map((c) => ({
      expr: { kind: 'column', name: c.name, start: 0, end: 0 } as Expr,
      alias: c.name,
    }));
  }

  const groupKeys: Array<{ name: string; fn: RowFn }> = [];
  const groupKeyStructs = new Set<string>();

  for (const expr of query.groupBy) {
    if (hasAggregate(expr)) {
      throw new SqlError('Aggregates are not allowed in GROUP BY.', expr.start, expr.end);
    }
    const resolved = resolveAlias(expr, selectItems);
    const folded = fold(resolved);
    const compiled = compiler.compile(folded);
    const name =
      expr.kind === 'column' ? expr.name :
      resolved.kind === 'column' ? resolved.name :
      keyOf(resolved);
    groupKeys.push({ name, fn: (i) => compiled(i, NO_AGGS) });
    // Structural key, so `GROUP BY who` where `who` aliases a CASE marks that
    // whole CASE as grouped, not merely the name `who`.
    groupKeyStructs.add(keyOf(folded));
  }

  const projections = selectItems.map((item, index) => ({
    name: displayName(item, index),
    fn: compiler.compile(fold(item.expr)),
  }));

  const orderBy = query.orderBy.map((order) => ({
    fn: compiler.compile(fold(resolveAlias(order.expr, selectItems))),
    descending: order.descending,
  }));

  const isAggregate = query.groupBy.length > 0 || compiler.aggSpecs.length > 0;

  if (isAggregate) {
    for (const item of selectItems) checkGrouped(fold(item.expr), groupKeyStructs);
  }

  return {
    query,
    where,
    groupKeys,
    aggs: compiler.aggSpecs,
    projections,
    orderBy,
    limit: query.limit,
    windowSeconds: query.windowSeconds,
    isAggregate,
    columnsUsed: compiler.columnsUsed,
  };
}

export { fold, cost, splitConjuncts };
export { walk };
