import type { Expr, OrderItem, Query, SelectItem } from './ast';
import { SqlError, type Token, type TokType, parseDuration, tokenize } from './lexer';

/**
 * Recursive-descent parser with precedence climbing for binary operators.
 *
 * Precedence climbing rather than one function per precedence level: adding an
 * operator becomes a table entry instead of a new function, and the expression
 * grammar stays a single readable function. Every node records source offsets so
 * errors can be underlined in the editor.
 */

const PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  '=': 3, '!=': 3, '<>': 3, '<': 3, '>': 3, '<=': 3, '>=': 3,
  '+': 4, '-': 4, '||': 4,
  '*': 5, '/': 5, '%': 5,
};

export const AGGREGATES = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'count_distinct', 'percentile', 'top_k',
]);

export const SCALAR_FUNCS = new Set([
  'lower', 'upper', 'length', 'abs', 'round', 'coalesce', 'substr', 'now',
]);

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(private readonly src: string) {
    this.tokens = tokenize(src);
  }

  // A method rather than a getter: TypeScript narrows a getter's type and does
  // not invalidate that narrowing across intervening calls, which made later
  // token comparisons look impossible to the compiler.
  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private atKeyword(...words: string[]): boolean {
    const tok = this.peek();
    return tok.type === 'keyword' && words.includes(tok.value.toLowerCase());
  }

  private advance(): Token {
    const tok = this.peek();
    if (tok.type !== 'eof') this.pos += 1;
    return tok;
  }

  private describe(tok: Token): string {
    return tok.type === 'eof' ? 'end of query' : `'${tok.value}'`;
  }

  private expectKeyword(word: string): Token {
    if (!this.atKeyword(word)) {
      throw new SqlError(
        `Expected ${word.toUpperCase()} but found ${this.describe(this.peek())}.`,
        this.peek().start,
        this.peek().end,
      );
    }
    return this.advance();
  }

  private expect(type: TokType, what: string): Token {
    if (this.peek().type !== type) {
      throw new SqlError(
        `Expected ${what} but found ${this.describe(this.peek())}.`,
        this.peek().start,
        this.peek().end,
      );
    }
    return this.advance();
  }

  parse(): Query {
    const query = this.parseQuery();
    if (this.peek().type !== 'eof') {
      throw new SqlError(
        `Unexpected ${this.describe(this.peek())} after end of query.`,
        this.peek().start,
        this.peek().end,
        'Riverbed runs one statement at a time.',
      );
    }
    return query;
  }

  private parseQuery(): Query {
    this.expectKeyword('select');

    let star = false;
    const items: SelectItem[] = [];
    if (this.peek().type === 'star') {
      this.advance();
      star = true;
    } else {
      items.push(this.parseSelectItem());
      while (this.peek().type === 'comma') {
        this.advance();
        items.push(this.parseSelectItem());
      }
    }

    this.expectKeyword('from');
    const fromTable = this.expect('ident', 'a table name').value;

    let where: Expr | null = null;
    if (this.atKeyword('where')) {
      this.advance();
      where = this.parseExpr();
    }

    const groupBy: Expr[] = [];
    if (this.atKeyword('group')) {
      this.advance();
      this.expectKeyword('by');
      groupBy.push(this.parseExpr());
      while (this.peek().type === 'comma') {
        this.advance();
        groupBy.push(this.parseExpr());
      }
    }

    const orderBy: OrderItem[] = [];
    if (this.atKeyword('order')) {
      this.advance();
      this.expectKeyword('by');
      orderBy.push(this.parseOrderItem());
      while (this.peek().type === 'comma') {
        this.advance();
        orderBy.push(this.parseOrderItem());
      }
    }

    let limit: number | null = null;
    if (this.atKeyword('limit')) {
      this.advance();
      const tok = this.expect('number', 'a row count after LIMIT');
      if (tok.value.includes('.')) {
        throw new SqlError('LIMIT must be a whole number.', tok.start, tok.end);
      }
      limit = Number(tok.value);
    }

    let windowSeconds: number | null = null;
    if (this.atKeyword('window')) {
      const kw = this.advance();
      if (this.peek().type !== 'duration') {
        const bad = this.peek().type === 'eof' ? kw : this.peek();
        throw new SqlError(
          'WINDOW needs a duration such as 30s, 5m, 1h, or 1d.',
          bad.start,
          bad.end,
          'Example: WINDOW 5m',
        );
      }
      windowSeconds = parseDuration(this.advance().value);
    }

    return {
      select: items,
      fromTable,
      where,
      groupBy,
      orderBy,
      limit,
      windowSeconds,
      star,
      src: this.src,
    };
  }

  private parseSelectItem(): SelectItem {
    const expr = this.parseExpr();
    let alias: string | null = null;
    if (this.atKeyword('as')) {
      this.advance();
      alias = this.expect('ident', 'an alias name').value;
    } else if (this.peek().type === 'ident') {
      // Bare alias: `count(*) edits`
      alias = this.advance().value;
    }
    return { expr, alias };
  }

  private parseOrderItem(): OrderItem {
    const expr = this.parseExpr();
    let descending = false;
    if (this.atKeyword('asc', 'desc')) {
      descending = this.advance().value.toLowerCase() === 'desc';
    }
    return { expr, descending };
  }

  private peekBinaryOp(): string | null {
    const tok = this.peek();
    if (tok.type === 'op' && tok.value in PRECEDENCE) return tok.value;
    if (tok.type === 'star') return '*';
    if (tok.type === 'keyword') {
      const word = tok.value.toLowerCase();
      if (word === 'and' || word === 'or') return word;
    }
    return null;
  }

  private parseExpr(minPrec = 0): Expr {
    // Postfix (IN / LIKE / IS NULL) binds to the operand, tighter than any
    // binary operator, so it is applied here rather than after the loop --
    // otherwise `a LIKE 'x' AND b` would stop parsing at the AND.
    let left = this.parsePostfix(this.parseUnary());

    for (;;) {
      const op = this.peekBinaryOp();
      if (op === null || PRECEDENCE[op]! < minPrec) break;
      this.advance();
      // Every supported binary operator is left-associative, so the right side
      // must bind strictly tighter.
      const right = this.parseExpr(PRECEDENCE[op]! + 1);
      left = { kind: 'binary', op, left, right, start: left.start, end: right.end };
    }

    return left;
  }

  private parsePostfix(expr: Expr): Expr {
    for (;;) {
      let negated = false;
      const save = this.pos;

      if (this.atKeyword('not')) {
        this.advance();
        negated = true;
        if (!this.atKeyword('in', 'like')) {
          this.pos = save;
          return expr;
        }
      }

      if (this.atKeyword('in')) {
        this.advance();
        this.expect('lparen', "'(' after IN");
        const values: Expr[] = [this.parseExpr()];
        while (this.peek().type === 'comma') {
          this.advance();
          values.push(this.parseExpr());
        }
        const close = this.expect('rparen', "')' to close the IN list");
        expr = { kind: 'in', operand: expr, values, negated, start: expr.start, end: close.end };
        continue;
      }

      if (this.atKeyword('like')) {
        this.advance();
        const pattern = this.parseUnary();
        expr = { kind: 'like', operand: expr, pattern, negated, start: expr.start, end: pattern.end };
        continue;
      }

      if (this.atKeyword('is')) {
        this.advance();
        let isNegated = false;
        if (this.atKeyword('not')) {
          this.advance();
          isNegated = true;
        }
        const tok = this.expectKeyword('null');
        expr = { kind: 'isnull', operand: expr, negated: isNegated, start: expr.start, end: tok.end };
        continue;
      }

      return expr;
    }
  }

  private parseUnary(): Expr {
    const tok = this.peek();
    if (tok.type === 'op' && tok.value === '-') {
      this.advance();
      const operand = this.parseUnary();
      return { kind: 'unary', op: '-', operand, start: tok.start, end: operand.end };
    }
    if (this.atKeyword('not')) {
      this.advance();
      const operand = this.parseExpr(PRECEDENCE.and! + 1);
      return { kind: 'unary', op: 'not', operand, start: tok.start, end: operand.end };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const tok = this.peek();

    if (tok.type === 'number') {
      this.advance();
      return { kind: 'literal', value: Number(tok.value), start: tok.start, end: tok.end };
    }

    if (tok.type === 'duration') {
      this.advance();
      return { kind: 'literal', value: parseDuration(tok.value), start: tok.start, end: tok.end };
    }

    if (tok.type === 'string') {
      this.advance();
      return { kind: 'literal', value: tok.value, start: tok.start, end: tok.end };
    }

    if (tok.type === 'lparen') {
      this.advance();
      const inner = this.parseExpr();
      this.expect('rparen', "')'");
      return inner;
    }

    if (this.atKeyword('true', 'false')) {
      this.advance();
      return {
        kind: 'literal',
        value: tok.value.toLowerCase() === 'true',
        start: tok.start,
        end: tok.end,
      };
    }

    if (this.atKeyword('null')) {
      this.advance();
      return { kind: 'literal', value: null, start: tok.start, end: tok.end };
    }

    if (this.atKeyword('case')) return this.parseCase();

    if (tok.type === 'ident') {
      this.advance();
      if (this.peek().type === 'lparen') return this.parseCall(tok);
      return { kind: 'column', name: tok.value, start: tok.start, end: tok.end };
    }

    throw new SqlError(
      `Expected a value or column but found ${this.describe(tok)}.`,
      tok.start,
      tok.end,
    );
  }

  private parseCall(nameTok: Token): Expr {
    const name = nameTok.value.toLowerCase();
    this.expect('lparen', "'('");

    let distinct = false;
    if (this.atKeyword('distinct')) {
      this.advance();
      distinct = true;
    }

    const args: Expr[] = [];
    if (this.peek().type === 'star') {
      const starTok = this.advance();
      if (name !== 'count') {
        throw new SqlError(
          `${name}(*) is not supported; only count(*) is.`,
          starTok.start,
          starTok.end,
        );
      }
      // count(*) is represented as a zero-argument aggregate.
    } else if (this.peek().type !== 'rparen') {
      args.push(this.parseExpr());
      while (this.peek().type === 'comma') {
        this.advance();
        args.push(this.parseExpr());
      }
    }

    const close = this.expect('rparen', `')' to close ${name}(`);

    if (distinct) {
      if (name !== 'count') {
        throw new SqlError(
          'DISTINCT is only supported inside count().',
          nameTok.start,
          close.end,
        );
      }
      return {
        kind: 'agg', name: 'count_distinct', args, distinct: true,
        start: nameTok.start, end: close.end,
      };
    }

    if (AGGREGATES.has(name)) {
      return { kind: 'agg', name, args, distinct: false, start: nameTok.start, end: close.end };
    }

    if (SCALAR_FUNCS.has(name)) {
      return { kind: 'func', name, args, start: nameTok.start, end: close.end };
    }

    const known = [...AGGREGATES, ...SCALAR_FUNCS].sort().join(', ');
    throw new SqlError(
      `Unknown function '${name}'.`,
      nameTok.start,
      close.end,
      `Available functions: ${known}.`,
    );
  }

  private parseCase(): Expr {
    const start = this.expectKeyword('case').start;
    const whens: Array<{ cond: Expr; then: Expr }> = [];

    while (this.atKeyword('when')) {
      this.advance();
      const cond = this.parseExpr();
      this.expectKeyword('then');
      whens.push({ cond, then: this.parseExpr() });
    }

    if (whens.length === 0) {
      throw new SqlError('CASE needs at least one WHEN branch.', start, this.peek().end);
    }

    let otherwise: Expr | null = null;
    if (this.atKeyword('else')) {
      this.advance();
      otherwise = this.parseExpr();
    }

    const end = this.expectKeyword('end').end;
    return { kind: 'case', whens, otherwise, start, end };
  }
}

export function parse(src: string): Query {
  if (!src.trim()) {
    throw new SqlError('Empty query.', 0, 0, 'Try: SELECT * FROM edits LIMIT 20');
  }
  return new Parser(src).parse();
}
