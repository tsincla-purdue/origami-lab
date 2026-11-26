import {
  add, apply, applyToLine, cross, distance, dot, lineDirection, signedDistance, sub,
  type Line, type Mat, type Vec,
} from '../../vendor/origamio/src/geometry';
import { solveCreaseThroughPoints, type ConstraintSolution } from '../lab/constraints';
import { lineKey, pointKey, releaseRadius, type SnapCandidate } from './snap-selection';

/** Candidates share screen-space scores. The smallest useful reference separation avoids unstable axes. */
export function creasePairs(line: Line, points: readonly Vec[], screen: Mat, radius: number, moving?: Vec, landing?: Vec) {
  const proposed = applyToLine(screen, line);
  const direction = lineDirection(proposed);
  const limit = releaseRadius(radius);
  const nearby = points.map(point => {
    const projected = apply(screen, point);
    return {point, projected, gap: Math.abs(cross(direction, sub(projected, proposed.a)))};
  }).filter(({gap}) => gap <= limit);
  const pairs: (SnapCandidate<Line> & {span: number; solution?: ConstraintSolution})[] = [];
  for (const [i, a] of nearby.entries()) {
    for (const b of nearby.slice(i + 1)) {
      const span = Math.abs(dot(direction, sub(b.projected, a.projected)));
      if (span < 3 * radius) continue;
      const value = {a: a.point, b: b.point};
      const solution = moving && solveCreaseThroughPoints(moving, value.a, value.b).solutions[0];
      if (moving && !solution) continue;
      const score = Math.max(a.gap, b.gap, landing && solution ? distance(apply(screen, solution.destination), landing) / 2 : 0);
      if (score <= limit) pairs.push({key: `axis/${lineKey(value)}`, value, score, span, solution});
    }
  }
  return pairs.sort((a, b) => a.score - b.score || b.span - a.span);
}

export function sameAxis(a: Line, b: Line) {
  return Math.max(Math.abs(signedDistance(a, b.a)), Math.abs(signedDistance(a, b.b)),
    Math.abs(signedDistance(b, a.a)), Math.abs(signedDistance(b, a.b))) <= 1e-8;
}

export function drawnMarkCandidates(line: Line, marks: readonly Vec[], screen: Mat, radius: number) {
  const pairs = creasePairs(line, marks, screen, radius).map(({key, score, value}) =>
    ({key, score, value, points: [value.a, value.b]}));
  const proposed = applyToLine(screen, line);
  const singles = marks.map(point => ({
    key: `mark/${pointKey(point)}`, score: Math.abs(signedDistance(proposed, apply(screen, point))),
    value: {a: point, b: add(point, sub(line.b, line.a))}, points: [point],
  }));
  return {pairs, singles};
}
