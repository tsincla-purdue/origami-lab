// This checker uses no numerical folding code. Values are dyadic coefficients of 1 and √3.
interface Scalar { readonly a: bigint; readonly b: bigint; readonly shift: number }
type Point = readonly [Scalar, Scalar];
type Axis = { readonly point: Point; readonly direction: Point };
type Value = Point | Axis;
export const CORNERS = ['A', 'B', 'C', 'D'] as const;
export type SquareCorner = typeof CORNERS[number];

type Rule =
  | { readonly kind: 'vertex'; readonly corner: SquareCorner }
  | { readonly kind: 'midpoint' | 'bisector'; readonly from: string; readonly to: string }
  | { readonly kind: 'equilateral-apex'; readonly pin: string; readonly moving: string;
      readonly target: string; readonly branch: 'above-pin' }
  | { readonly kind: 'perpendicular'; readonly point: string; readonly line: string };

export class ProofBudget extends Error {}

function scalar(a: bigint, b = 0n, shift = 0): Scalar {
  // Limit both evaluation cost and projection range before any dependent operation runs.
  if (shift > 512 || a.toString(2).length > 512 || b.toString(2).length > 512) {
    throw new ProofBudget('The exact coefficient budget was exceeded.');
  }
  if (a === 0n && b === 0n) return {a, b, shift: 0};
  while (shift && (a & 1n) === 0n && (b & 1n) === 0n) {
    a >>= 1n;
    b >>= 1n;
    shift--;
  }
  return {a, b, shift};
}
const neg = ({a, b, shift}: Scalar) => scalar(-a, -b, shift);
const half = ({a, b, shift}: Scalar) => scalar(a, b, shift + 1);

function plus(p: Scalar, q: Scalar) {
  const shift = Math.max(p.shift, q.shift);
  const left = BigInt(shift - p.shift);
  const right = BigInt(shift - q.shift);
  return scalar((p.a << left) + (q.a << right), (p.b << left) + (q.b << right), shift);
}

const times = (p: Scalar, q: Scalar) =>
  scalar(p.a * q.a + 3n * p.b * q.b, p.a * q.b + p.b * q.a, p.shift + q.shift);
const difference = (p: Scalar, q: Scalar) => plus(p, neg(q));
const zero = ({a, b}: Scalar) => a === 0n && b === 0n;
const sub = (p: Point, q: Point): Point => [difference(p[0], q[0]), difference(p[1], q[1])];
const mid = (p: Point, q: Point): Point => [half(plus(p[0], q[0])), half(plus(p[1], q[1]))];
const turn = ([x, y]: Point): Point => [neg(y), x];
const dot = (p: Point, q: Point) => plus(times(p[0], q[0]), times(p[1], q[1]));
const cross = (p: Point, q: Point) => difference(times(p[0], q[1]), times(p[1], q[0]));
const nonzero = ([x, y]: Point) => !zero(x) || !zero(y);

function positive({a, b}: Scalar) {
  if (a >= 0n && b >= 0n) return a > 0n || b > 0n;
  if (a <= 0n && b <= 0n) return false;
  return a > 0n ? a * a > 3n * b * b : 3n * b * b > a * a;
}

export const squareVertices = {A: [0, 0], B: [1, 0], C: [1, 1], D: [0, 1]} as const;
function square(corner: SquareCorner): Point {
  const [x, y] = squareVertices[corner];
  return [scalar(BigInt(x)), scalar(BigInt(y))];
}
const onLine = (point: Point, line: Axis) => zero(cross(line.direction, sub(point, line.point)));
const samePoint = (a: Point, b: Point) => !nonzero(sub(a, b));

export function project(point: Point): [number, number] {
  const asNumber = ({a, b, shift}: Scalar) => (Number(a) + Number(b) * Math.sqrt(3)) / 2 ** shift;
  return [asNumber(point[0]), asNumber(point[1])];
}

/** Entries reference earlier IDs. Cache each value once and retain its direct dependencies. */
export class ProofGraph {
  private readonly values = new Map<string, {value: Value; dependencies: readonly string[]}>();
  constructor(private readonly budget = 768) {}

  get size() { return this.values.size; }
  dependencies(id: string) { return this.values.get(id)?.dependencies ?? []; }

  point(id: string): Point {
    const value = this.values.get(id)?.value;
    if (!value || 'direction' in value) throw new Error(`Expected a proved point at ${id}.`);
    return value;
  }

  axis(id: string): Axis {
    const value = this.values.get(id)?.value;
    if (!value || !('direction' in value)) throw new Error(`Expected a proved line at ${id}.`);
    return value;
  }

  isCenter(id: string) {
    const axis = this.axis(id);
    return zero(axis.direction[0]) && zero(difference(axis.point[0], scalar(1n, 0n, 1)));
  }

  add(id: string, rule: Rule) {
    if (this.values.has(id)) throw new Error(`Duplicate geometry ID ${id}.`);
    if (this.values.size >= this.budget) throw new ProofBudget('The proof node budget was exceeded.');
    let value: Value;
    let dependencies: readonly string[];
    switch (rule.kind) {
      case 'vertex':
        value = square(rule.corner);
        dependencies = [];
        break;
      case 'midpoint':
      case 'bisector': {
        dependencies = [rule.from, rule.to];
        const a = this.point(rule.from), b = this.point(rule.to);
        const point = mid(a, b);
        const direction = turn(sub(b, a));
        if (rule.kind === 'bisector' && !nonzero(direction)) throw new Error('The bisector operands coincide.');
        value = rule.kind === 'midpoint' ? point : {point, direction};
        break;
      }
      case 'equilateral-apex': {
        dependencies = [rule.pin, rule.moving, rule.target];
        const pin = this.point(rule.pin), moving = this.point(rule.moving);
        const apex: Point = [scalar(1n, 0n, 1), scalar(0n, 1n, 1)];
        const radius = sub(moving, pin), landing = sub(apex, pin);
        // The named inputs and positive branch make this circle/line witness unique.
        if (rule.branch !== 'above-pin' || !samePoint(pin, square('A')) || !samePoint(moving, square('B')) ||
            !this.isCenter(rule.target) || !onLine(apex, this.axis(rule.target)) ||
            !zero(difference(dot(radius, radius), dot(landing, landing))) || !positive(landing[1])) {
          throw new Error('Invalid equilateral witness or branch.');
        }
        value = apex;
        break;
      }
      case 'perpendicular':
        dependencies = [rule.point, rule.line];
        value = {point: this.point(rule.point), direction: turn(this.axis(rule.line).direction)};
        break;
    }
    this.values.set(id, {value, dependencies});
  }
}
