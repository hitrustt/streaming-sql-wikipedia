/**
 * AST node definitions.
 *
 * Plain data objects in a discriminated union rather than classes with `eval`
 * methods: keeping the tree dumb lets the planner rewrite it (constant folding,
 * predicate reordering) without nodes carrying execution state around.
 * Evaluation lives entirely in the planner's compiler.
 */

export interface Span {
  start: number;
  end: number;
}

export interface Literal extends Span {
  kind: 'literal';
  value: string | number | boolean | null;
}

export interface ColumnRef extends Span {
  kind: 'column';
  name: string;
}

export interface BinaryOp extends Span {
  kind: 'binary';
  op: string;
  left: Expr;
  right: Expr;
}

export interface UnaryOp extends Span {
  kind: 'unary';
  op: '-' | 'not';
  operand: Expr;
}

/** A scalar function: lower(), abs(), length(), ... */
export interface FuncCall extends Span {
  kind: 'func';
  name: string;
  args: Expr[];
}

/**
 * An aggregate: count/sum/avg/min/max/count_distinct/percentile/top_k.
 *
 * Held separately from FuncCall because the planner must hoist these out of the
 * projection list into the aggregation operator, and conflating the two makes
 * that pass easy to get wrong.
 */
export interface AggCall extends Span {
  kind: 'agg';
  name: string;
  args: Expr[];
  distinct: boolean;
}

export interface InList extends Span {
  kind: 'in';
  operand: Expr;
  values: Expr[];
  negated: boolean;
}

export interface Like extends Span {
  kind: 'like';
  operand: Expr;
  pattern: Expr;
  negated: boolean;
}

export interface IsNull extends Span {
  kind: 'isnull';
  operand: Expr;
  negated: boolean;
}

export interface Case extends Span {
  kind: 'case';
  whens: Array<{ cond: Expr; then: Expr }>;
  otherwise: Expr | null;
}

export type Expr =
  | Literal | ColumnRef | BinaryOp | UnaryOp | FuncCall | AggCall
  | InList | Like | IsNull | Case;

export interface SelectItem {
  expr: Expr;
  alias: string | null;
}

export interface OrderItem {
  expr: Expr;
  descending: boolean;
}

export interface Query {
  select: SelectItem[];
  fromTable: string;
  where: Expr | null;
  groupBy: Expr[];
  orderBy: OrderItem[];
  limit: number | null;
  /**
   * Rolling window in seconds. `WINDOW 5m` restricts the query to the last five
   * minutes and is what makes a query continuous rather than a one-shot scan.
   */
  windowSeconds: number | null;
  star: boolean;
  src: string;
}

/** Child expressions, for generic tree walks. */
export function children(expr: Expr): Expr[] {
  switch (expr.kind) {
    case 'binary':
      return [expr.left, expr.right];
    case 'unary':
      return [expr.operand];
    case 'func':
    case 'agg':
      return expr.args;
    case 'in':
      return [expr.operand, ...expr.values];
    case 'like':
      return [expr.operand, expr.pattern];
    case 'isnull':
      return [expr.operand];
    case 'case': {
      const out: Expr[] = [];
      for (const { cond, then } of expr.whens) out.push(cond, then);
      if (expr.otherwise) out.push(expr.otherwise);
      return out;
    }
    default:
      return [];
  }
}

export function* walk(expr: Expr): Generator<Expr> {
  yield expr;
  for (const child of children(expr)) yield* walk(child);
}

export function hasAggregate(expr: Expr): boolean {
  for (const node of walk(expr)) if (node.kind === 'agg') return true;
  return false;
}

/** Structural key, used to deduplicate identical aggregates and match GROUP BY keys. */
export function keyOf(expr: Expr): string {
  switch (expr.kind) {
    case 'literal':
      return `lit:${JSON.stringify(expr.value)}`;
    case 'column':
      return `col:${expr.name}`;
    case 'binary':
      return `(${keyOf(expr.left)}${expr.op}${keyOf(expr.right)})`;
    case 'unary':
      return `${expr.op}(${keyOf(expr.operand)})`;
    case 'func':
    case 'agg':
      return `${expr.name}(${expr.args.map(keyOf).join(',')})`;
    case 'in':
      return `${keyOf(expr.operand)} in(${expr.values.map(keyOf).join(',')})`;
    case 'like':
      return `${keyOf(expr.operand)} like ${keyOf(expr.pattern)}`;
    case 'isnull':
      return `${keyOf(expr.operand)} isnull${expr.negated}`;
    case 'case':
      return `case(${expr.whens.map((w) => `${keyOf(w.cond)}->${keyOf(w.then)}`).join(',')};${
        expr.otherwise ? keyOf(expr.otherwise) : ''
      })`;
    default:
      return 'unknown';
  }
}
