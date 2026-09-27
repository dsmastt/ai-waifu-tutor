/**
 * Safe math expression evaluation for graph windows.
 *
 * The LLM may request graphs of functions expressed as strings like
 * "x^2 + sin(x)". We NEVER eval those strings: instead we run them through
 * a small recursive-descent parser that only understands a fixed grammar of
 * arithmetic, the variable x, and a whitelist of math functions.
 */

const ALLOWED_CHARS = /^[0-9a-zA-Z_.+\-*/^(),\s]+$/;

const FUNCTIONS: Record<string, (x: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  exp: Math.exp, log: Math.log, ln: Math.log, sqrt: Math.sqrt,
  abs: Math.abs, cbrt: Math.cbrt,
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI, e: Math.E, tau: Math.PI * 2,
};

export class MathExprError extends Error {}

class Parser {
  private pos = 0;

  constructor(private src: string) {}

  parse(): (x: number) => number {
    if (!ALLOWED_CHARS.test(this.src)) {
      throw new MathExprError(`disallowed characters in expression`);
    }
    const fn = this.parseExpr();
    this.skipWs();
    if (this.pos < this.src.length) {
      throw new MathExprError(`unexpected '${this.src[this.pos]}'`);
    }
    return fn;
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  private peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? '';
  }

  private parseExpr(): (x: number) => number {
    let left = this.parseTerm();
    for (;;) {
      const op = this.peek();
      if (op === '+') {
        this.pos++;
        const right = this.parseTerm();
        const l = left;
        left = (x) => l(x) + right(x);
      } else if (op === '-') {
        this.pos++;
        const right = this.parseTerm();
        const l = left;
        left = (x) => l(x) - right(x);
      } else {
        return left;
      }
    }
  }

  private parseTerm(): (x: number) => number {
    let left = this.parsePower();
    for (;;) {
      const op = this.peek();
      if (op === '*') {
        this.pos++;
        const right = this.parsePower();
        const l = left;
        left = (x) => l(x) * right(x);
      } else if (op === '/') {
        this.pos++;
        const right = this.parsePower();
        const l = left;
        left = (x) => l(x) / right(x);
      } else {
        return left;
      }
    }
  }

  private parsePower(): (x: number) => number {
    const base = this.parseUnary();
    if (this.peek() === '^') {
      this.pos++;
      const exp = this.parsePower(); // right-assoc, allows x^2 and 2^-x
      return (x) => Math.pow(base(x), exp(x));
    }
    return base;
  }

  private parseUnary(): (x: number) => number {
    const op = this.peek();
    if (op === '-') {
      this.pos++;
      const inner = this.parseUnary();
      return (x) => -inner(x);
    }
    if (op === '+') {
      this.pos++;
      return this.parseUnary();
    }
    return this.parseAtom();
  }

  private parseAtom(): (x: number) => number {
    this.skipWs();
    const c = this.src[this.pos];
    if (c === undefined) throw new MathExprError('unexpected end of expression');

    if (c === '(') {
      this.pos++;
      const inner = this.parseExpr();
      if (this.peek() !== ')') throw new MathExprError("missing ')'");
      this.pos++;
      return inner;
    }

    if (/[0-9.]/.test(c)) {
      let num = '';
      while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos])) {
        num += this.src[this.pos++];
      }
      // scientific notation tail (e.g. 1e-3)
      if (this.pos < this.src.length && /[eE]/.test(this.src[this.pos])) {
        const rest = this.src.slice(this.pos);
        const m = /^[eE][+-]?[0-9]+/.exec(rest);
        if (m) {
          num += m[0];
          this.pos += m[0].length;
        }
      }
      const value = Number(num);
      if (!Number.isFinite(value)) throw new MathExprError(`bad number '${num}'`);
      return () => value;
    }

    if (/[a-zA-Z_]/.test(c)) {
      let name = '';
      while (this.pos < this.src.length && /[a-zA-Z0-9_]/.test(this.src[this.pos])) {
        name += this.src[this.pos++];
      }
      const lower = name.toLowerCase();
      if (lower === 'x') return (x) => x;
      if (lower in CONSTANTS) {
        const v = CONSTANTS[lower];
        return () => v;
      }
      if (lower in FUNCTIONS) {
        if (this.peek() !== '(') throw new MathExprError(`'${name}' needs '('`);
        this.pos++;
        const arg = this.parseExpr();
        if (this.peek() !== ')') throw new MathExprError(`missing ')' after ${name}`);
        this.pos++;
        const f = FUNCTIONS[lower];
        return (x) => f(arg(x));
      }
      throw new MathExprError(`unknown symbol '${name}'`);
    }

    throw new MathExprError(`unexpected '${c}'`);
  }
}

/** Compile an expression string to a safe evaluator, or null if invalid. */
export function compileFunction(expr: string): ((x: number) => number) | null {
  try {
    return new Parser(expr).parse();
  } catch {
    return null;
  }
}

export function isFinitePoint(y: number): boolean {
  return Number.isFinite(y) && Math.abs(y) < 1e9;
}
