import {
  EPS, add, apply, cross, distance, dot, length, lerp, lineDirection, reflection, scale, sideOf, signedDistance, sub,
  type Line, type Vec,
} from '../../vendor/origamio/src/geometry';
import type { ConstraintResult } from './constraints';

interface AxisResult {
  readonly status: 'solved' | 'underdetermined' | 'unverified';
  readonly axes: readonly Line[];
  readonly reason: string;
}

const finite = (p: Vec) => Number.isFinite(p?.x) && Number.isFinite(p?.y);
const normal = ({x, y}: Vec): Vec => ({x: -y, y: x});
const angularTolerance = 64 * Number.EPSILON;
const diagnostics = (reason: string, status: AxisResult['status'] = 'unverified'): AxisResult => ({status, reason, axes: []});

function direction(line: Line) {
  if (!finite(line?.a) || !finite(line?.b)) return;
  const d = sub(line.b, line.a);
  const extent = length(d);
  if (Number.isFinite(extent) && extent > EPS) return scale(d, 1 / extent);
}

function axisThrough(a: Vec, vector: Vec): Line | undefined {
  const b = add(a, vector);
  if (finite(a) && finite(b) && distance(a, b) > EPS) return {a, b};
}

/** O3 solves the equal and opposite signed-distance equations of the supporting lines. */
export function solveLineOntoLine(source: Line, target: Line): AxisResult {
  const first = direction(source);
  const second = direction(target);
  if (!first || !second) return diagnostics('Choose two lines with distinct finite endpoints.');
  const n1 = normal(first);
  const n2 = normal(dot(first, second) < 0 ? scale(second, -1) : second);
  const angle = cross(first, second);
  const offset = dot(n2, sub(source.a, target.a));
  if (angle !== 0 && Math.abs(angle) <= angularTolerance) {
    return diagnostics('The lines are too close to parallel to distinguish their bisectors reliably.');
  }
  if (angle === 0 && Math.abs(offset) <= EPS) {
    return offset === 0
      ? diagnostics('The lines coincide. Their alignment alone does not determine a crease.', 'underdetermined')
      : diagnostics('The parallel lines are too close to distinguish reliably.');
  }
  const axes: Line[] = [];
  for (const sign of angle === 0 ? [-1] : [-1, 1]) {
    const sum = sub(n1, scale(n2, sign));
    const unit = scale(sum, 1 / length(sum));
    const origin = add(source.a, scale(unit, sign * offset / length(sum)));
    const axis = axisThrough(origin, normal(unit));
    if (!axis || ![source.a, source.b].every(point =>
      Math.abs(signedDistance(target, apply(reflection(axis), point))) <= EPS)) {
      return diagnostics('The reflected source could not be verified on the target line.');
    }
    axes.push(axis);
  }
  return {status: 'solved', axes, reason: ''};
}

/** O4 uses the target direction rotated a quarter turn, anchored exactly at the pin. */
export function solvePerpendicularThroughPoint(point: Vec, line: Line): AxisResult {
  const along = direction(line);
  const axis = along && finite(point) ? axisThrough(point, normal(along)) : undefined;
  if (!axis || !along) return diagnostics('Choose a finite point and a line with distinct endpoints.');
  if (Math.abs(signedDistance(axis, point)) > EPS ||
      Math.abs(dot(lineDirection(axis), along)) > angularTolerance) {
    return diagnostics('The perpendicular through the point could not be verified.');
  }
  return {status: 'solved', axes: [axis], reason: ''};
}

export interface LineReference {
  readonly facetId: number;
  readonly line: Line;
}

export type LineFoldIntent = { readonly source: LineReference; readonly moving: Vec } & (
  { readonly kind: 'align-lines'; readonly target: LineReference } |
  { readonly kind: 'perpendicular'; readonly pin: Vec }
);

const parameter = (line: Line, point: Vec) => dot(sub(point, line.a), lineDirection(line));

/** Resolve a finite line-grab intent to the same axis and moving side for any caller. */
export function resolveLineFold(intent: LineFoldIntent): ConstraintResult {
  const source = intent.source.line;
  const target = intent.kind === 'align-lines' ? intent.target.line : source;
  const result = intent.kind === 'align-lines' ? solveLineOntoLine(source, target)
    : solvePerpendicularThroughPoint(intent.pin, source);
  if (result.status !== 'solved') {
    return {status: result.status === 'underdetermined' ? 'no-solution' : 'unverified', reason: result.reason, solutions: []};
  }
  const anchor = intent.moving;
  const span = distance(source.a, source.b);
  if (!finite(anchor) || Math.abs(signedDistance(source, anchor)) > EPS ||
      parameter(source, anchor) < -EPS || parameter(source, anchor) > span + EPS) {
    return {status: 'unverified', reason: 'Grab a point on the selected finite paper segment.', solutions: []};
  }
  const extent = distance(target.a, target.b);
  const solutions = result.axes.flatMap(line => {
    if (Math.abs(signedDistance(line, anchor)) <= EPS) return [];
    const side = sideOf(line, anchor);
    const flip = reflection(line);
    const destination = apply(flip, anchor);
    const landing = parameter(target, destination);
    if (intent.kind === 'perpendicular' && (landing < -EPS || landing > extent + EPS)) return [];
    const a = side * signedDistance(line, source.a);
    const b = side * signedDistance(line, source.b);
    const hinge = a * b < 0 ? lerp(source.a, source.b, a / (a - b)) : undefined;
    const ends = [a < 0 && hinge ? hinge : source.a, b < 0 && hinge ? hinge : source.b]
      .map(point => parameter(target, apply(flip, point)));
    if (Math.min(extent, Math.max(...ends)) - Math.max(0, Math.min(...ends)) <= EPS) return [];
    return [{line, destination, side}];
  });
  return solutions.length ? {status: 'solved', solutions, reason: ''}
    : {status: 'no-solution', solutions, reason: 'This grab has no moving reflection onto the finite target. Try another point on the line.'};
}
