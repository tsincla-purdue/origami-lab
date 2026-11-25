// The exact kernel has no dependency on the paper engine or its numerical tolerances.
interface Scalar { readonly a: bigint; readonly b: bigint; readonly d: bigint }
type Coordinates = readonly [number, number];
type Point = readonly [Scalar, Scalar];
type Axis = { readonly point: Point; readonly direction: Point };
type Value = Point | Axis;
export const CORNERS = ['A', 'B', 'C', 'D'] as const;
export type SquareCorner = typeof CORNERS[number];

type Rule =
  | { readonly kind: 'vertex'; readonly corner: SquareCorner }
  | { readonly kind: 'midpoint' | 'bisector' | 'through'; readonly from: string; readonly to: string }
  | { readonly kind: 'intersection'; readonly first: string; readonly second: string }
  | { readonly kind: 'parameter-line'; readonly from: Coordinates; readonly to: Coordinates; readonly assumption: string }
  | { readonly kind: 'circle-line'; readonly pin: string; readonly moving: string;
      readonly target: string; readonly branch: -1 | 0 | 1 }
  | { readonly kind: 'equilateral-apex'; readonly pin: string; readonly moving: string;
      readonly target: string; readonly branch: 'above-pin' }
  | { readonly kind: 'perpendicular' | 'reflection'; readonly point: string; readonly line: string };

export class ProofBudget extends Error {}
export class ProofUnsupported extends Error {}

const abs = (value: bigint) => value < 0n ? -value : value;
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return abs(a);
}

function scalar(a: bigint, b = 0n, d = 1n): Scalar {
  if (d === 0n) throw new Error('Division by zero in a geometric construction.');
  const factor = gcd(gcd(a, b), d) * (d < 0n ? -1n : 1n);
  a /= factor;
  b /= factor;
  d /= factor;
  if ([a, b, d].some(value => abs(value).toString(2).length > 2048)) {
    throw new ProofBudget('The exact coefficient budget was exceeded.');
  }
  return {a, b, d};
}

const binary = new DataView(new ArrayBuffer(8));
function exactDouble(value: number) {
  if (!Number.isFinite(value)) throw new Error('A geometric parameter must be finite.');
  binary.setFloat64(0, value);
  const bits = binary.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  const significand = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
  const shift = BigInt((exponent || 1) - 1075);
  const signed = bits >> 63n ? -significand : significand;
  return shift >= 0n ? scalar(signed << shift) : scalar(signed, 0n, 1n << -shift);
}

const neg = ({a, b, d}: Scalar) => scalar(-a, -b, d);
const plus = (p: Scalar, q: Scalar) => scalar(p.a * q.d + q.a * p.d, p.b * q.d + q.b * p.d, p.d * q.d);
const times = (p: Scalar, q: Scalar) =>
  scalar(p.a * q.a + 3n * p.b * q.b, p.a * q.b + p.b * q.a, p.d * q.d);
const over = (p: Scalar, q: Scalar) => times(p, scalar(q.a * q.d, -q.b * q.d, q.a * q.a - 3n * q.b * q.b));
const difference = (p: Scalar, q: Scalar) => plus(p, neg(q));
const zero = ({a, b}: Scalar) => a === 0n && b === 0n;
const coordinates = ([x, y]: Coordinates): Point => [exactDouble(x), exactDouble(y)];
const add = (p: Point, q: Point): Point => [plus(p[0], q[0]), plus(p[1], q[1])];
const sub = (p: Point, q: Point): Point => [difference(p[0], q[0]), difference(p[1], q[1])];
const scale = (p: Point, multiplier: Scalar): Point => [times(p[0], multiplier), times(p[1], multiplier)];
const mid = (p: Point, q: Point): Point => scale(add(p, q), scalar(1n, 0n, 2n));
const turn = ([x, y]: Point): Point => [neg(y), x];
const dot = (p: Point, q: Point) => plus(times(p[0], q[0]), times(p[1], q[1]));
const cross = (p: Point, q: Point) => difference(times(p[0], q[1]), times(p[1], q[0]));
const nonzero = ([x, y]: Point) => !zero(x) || !zero(y);

function positive({a, b}: Scalar) {
  if (a >= 0n && b >= 0n) return a > 0n || b > 0n;
  if (a <= 0n && b <= 0n) return false;
  return a > 0n ? a * a > 3n * b * b : 3n * b * b > a * a;
}

function squareRoot(value: bigint): bigint | undefined {
  if (value <= 1n) return value;
  let upper = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  for (;;) {
    const next = (upper + value / upper) / 2n;
    if (next >= upper) return upper * upper === value ? upper : undefined;
    upper = next;
  }
}

function exactRoot(value: Scalar) {
  if (zero(value)) return scalar(0n);
  if (!positive(value)) throw new Error('The circle does not intersect the selected line.');
  if (value.b === 0n) {
    for (const radicand of [1n, 3n]) {
      const ratio = scalar(value.a, 0n, value.d * radicand);
      const n = squareRoot(ratio.a), d = squareRoot(ratio.d);
      if (n !== undefined && d !== undefined) return radicand === 1n ? scalar(n, 0n, d) : scalar(0n, n, d);
    }
  }
  throw new ProofUnsupported('This square root is outside the supported exact arithmetic.');
}

function circleLine(pin: Point, moving: Point, axis: Axis, branch: -1 | 0 | 1) {
  const relative = sub(pin, axis.point);
  const squared = dot(axis.direction, axis.direction);
  const foot = add(axis.point, scale(axis.direction, over(dot(relative, axis.direction), squared)));
  const offset = sub(pin, foot), radius = sub(pin, moving);
  const root = exactRoot(over(difference(dot(radius, radius), dot(offset, offset)), squared));
  if (zero(root) !== (branch === 0)) throw new Error('The recorded branch does not match the line intersection.');
  return add(foot, scale(axis.direction, times(root, scalar(BigInt(branch)))));
}

export const squareVertices = {A: [0, 0], B: [1, 0], C: [1, 1], D: [0, 1]} as const;
const onLine = (point: Point, line: Axis) => zero(cross(line.direction, sub(point, line.point)));
const samePoint = (a: Point, b: Point) => !nonzero(sub(a, b));

function reflect(point: Point, axis: Axis): Point {
  const normal = turn(axis.direction);
  const twice = times(scalar(2n), over(dot(sub(point, axis.point), normal), dot(normal, normal)));
  return sub(point, scale(normal, twice));
}

function ratio(numerator: bigint, denominator: bigint) {
  const shift = (n: bigint) => Math.max(0, abs(n).toString(2).length - 53);
  const a = shift(numerator), b = shift(denominator);
  if (numerator === 0n) return 0;
  const result = Number(abs(numerator) >> BigInt(a)) / Number(denominator >> BigInt(b)) * 2 ** (a - b);
  return numerator < 0n ? -result : result;
}

export function project(point: Point): [number, number] {
  function asNumber({a, b, d}: Scalar) {
    const rational = ratio(a, d), radical = ratio(b, d) * Math.sqrt(3);
    const result = rational + radical;
    if (!Number.isFinite(result) || ((a !== 0n || b !== 0n) && result === 0) ||
        (rational * radical < 0 && Math.abs(result) < 1e-10 * Math.max(Math.abs(rational), Math.abs(radical)))) {
      throw new ProofUnsupported('The exact value has no reliable numerical projection.');
    }
    return result;
  }
  return [asNumber(point[0]), asNumber(point[1])];
}

function operands(rule: Rule): readonly string[] {
  switch (rule.kind) {
    case 'vertex':
    case 'parameter-line': return [];
    case 'through':
    case 'bisector':
    case 'midpoint': return [rule.from, rule.to];
    case 'perpendicular':
    case 'reflection': return [rule.point, rule.line];
    case 'intersection': return [rule.first, rule.second];
    case 'circle-line':
    case 'equilateral-apex': return [rule.pin, rule.moving, rule.target];
  }
}

/** Keep rules shared by ID and evaluate exact values only when requested. */
export class ProofGraph {
  private readonly nodes = new Map<string, {rule: Rule; value?: Value; assumptions?: readonly string[]}>();
  constructor(private readonly budget = 768) {}

  get size() { return this.nodes.size; }
  dependencies(id: string) { return operands(this.entry(id).rule); }
  assumptions(id: string): readonly string[] {
    const node = this.entry(id);
    return node.assumptions ??= node.rule.kind === 'parameter-line' ? [node.rule.assumption] :
      [...new Set(operands(node.rule).flatMap(dependency => this.assumptions(dependency)))];
  }

  private entry(id: string) {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Missing geometric operand ${id}.`);
    return node;
  }
  private value(id: string) {
    const node = this.entry(id);
    return node.value ??= this.evaluate(node.rule);
  }
  point(id: string): Point {
    const value = this.value(id);
    if ('direction' in value) throw new Error(`Expected a proved point at ${id}.`);
    return value;
  }
  axis(id: string): Axis {
    const value = this.value(id);
    if (!('direction' in value)) throw new Error(`Expected a proved line at ${id}.`);
    return value;
  }

  contains(line: string, point: string) { return onLine(this.point(point), this.axis(line)); }
  perpendicular(first: string, second: string) { return zero(dot(this.axis(first).direction, this.axis(second).direction)); }
  samePoint(first: string, second: string) { return samePoint(this.point(first), this.point(second)); }

  isCenter(id: string) {
    const axis = this.axis(id);
    return zero(axis.direction[0]) && zero(difference(axis.point[0], scalar(1n, 0n, 2n)));
  }

  add(id: string, rule: Rule) {
    if (this.nodes.has(id)) throw new Error(`Duplicate geometry ID ${id}.`);
    if (this.nodes.size >= this.budget) throw new ProofBudget('The proof node budget was exceeded.');
    for (const operand of operands(rule)) this.entry(operand);
    this.nodes.set(id, {rule});
  }

  /** The proposal and replay evaluate the same intrinsic construction from independently bound inputs. */
  markedPerpendicular(moving: string, through: string, source: string) {
    const p = this.point(moving), q = this.point(through), l = this.axis(source);
    if (samePoint(p, q) || !onLine(p, l) || !onLine(q, l)) {
      throw new ProofUnsupported('The distinct marks must be established on the same material crease.');
    }
    const axis: Axis = {point: q, direction: turn(l.direction)};
    const landing = reflect(p, axis);
    if (!samePoint(mid(p, landing), q) || !zero(dot(axis.direction, l.direction))) {
      throw new Error('The midpoint and perpendicular identities failed.');
    }
    return {axis, landing};
  }

  private evaluate(rule: Rule): Value {
    switch (rule.kind) {
      case 'vertex': return coordinates(squareVertices[rule.corner]);
      case 'parameter-line': {
        const point = coordinates(rule.from), direction = sub(coordinates(rule.to), point);
        if (!nonzero(direction)) throw new Error('A line needs distinct endpoints.');
        return {point, direction};
      }
      case 'midpoint':
      case 'bisector':
      case 'through': {
        const a = this.point(rule.from), b = this.point(rule.to);
        if (rule.kind === 'midpoint') return mid(a, b);
        const direction = sub(b, a);
        if (!nonzero(direction)) throw new Error('The line operands coincide.');
        return rule.kind === 'through' ? {point: a, direction} : {point: mid(a, b), direction: turn(direction)};
      }
      case 'intersection': {
        const a = this.axis(rule.first), b = this.axis(rule.second);
        const determinant = cross(a.direction, b.direction);
        if (zero(determinant)) throw new Error('Parallel or coincident lines have no unique intersection.');
        return add(a.point, scale(a.direction, over(cross(sub(b.point, a.point), b.direction), determinant)));
      }
      case 'circle-line':
        return circleLine(this.point(rule.pin), this.point(rule.moving), this.axis(rule.target), rule.branch);
      case 'equilateral-apex': {
        // Compatibility with the earlier named upper-branch witness.
        const axis = this.axis(rule.target);
        if (rule.branch !== 'above-pin' || !this.isCenter(rule.target)) throw new Error('Invalid legacy equilateral branch.');
        return circleLine(this.point(rule.pin), this.point(rule.moving), axis, positive(axis.direction[1]) ? 1 : -1);
      }
      case 'perpendicular': return {point: this.point(rule.point), direction: turn(this.axis(rule.line).direction)};
      case 'reflection': return reflect(this.point(rule.point), this.axis(rule.line));
    }
  }
}
