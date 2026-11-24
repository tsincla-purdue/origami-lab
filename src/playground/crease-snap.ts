import {
  apply, applyToLine, cross, distance, dot, lineDirection, signedDistance, sub, type Line, type Mat, type Vec,
} from '../../vendor/origamio/src/geometry';
import { solveCreaseThroughPoints, type ConstraintSolution } from '../lab';

interface Candidate {
  solution: ConstraintSolution;
  screenLine: Line;
  score: number;
  span: number;
}

/** Interpret pointer proximity in CSS pixels and solve the chosen construction in paper coordinates. */
export function snapCrease(
  line: Line, moving: Vec, destination: Vec, points: readonly Vec[], screen: Mat, radius: number, locked?: Line,
): ConstraintSolution | undefined {
  const proposed = applyToLine(screen, line);
  const direction = lineDirection(proposed);
  const landing = apply(screen, destination);
  const reference = (point: Vec) => {
    const projected = apply(screen, point);
    return {point, projected, gap: Math.abs(cross(direction, sub(projected, proposed.a)))};
  };
  function candidate(a: ReturnType<typeof reference>, b: ReturnType<typeof reference>, limit: number): Candidate | undefined {
    if (a.gap > limit || b.gap > limit) return;
    // Screen separation along the intended crease keeps nearby clusters from defining its angle.
    const span = Math.abs(dot(direction, sub(b.projected, a.projected)));
    if (span < 3 * radius) return;
    const [solution] = solveCreaseThroughPoints(moving, a.point, b.point).solutions;
    if (!solution) return;
    // A pair near the far end of the crease can otherwise swing the landing far from the pointer.
    const score = Math.max(a.gap, b.gap, distance(apply(screen, solution.destination), landing) / 2);
    if (score <= limit) return {solution, score, span, screenLine: {a: a.projected, b: b.projected}};
  }

  if (locked) {
    const retained = candidate(reference(locked.a), reference(locked.b), radius * 1.5);
    if (retained) return retained.solution;
  }

  const nearby = points.map(reference).filter(({gap}) => gap <= radius);
  const candidates: Candidate[] = [];
  for (const [i, a] of nearby.entries()) {
    for (let j = i + 1; j < nearby.length; j++) {
      const match = candidate(a, nearby[j], radius);
      if (match) candidates.push(match);
    }
  }
  candidates.sort((a, b) => a.score - b.score || b.span - a.span);
  const best = candidates[0];
  if (!best) return;

  // Several pairs can identify the same exact line, for example on a retained crease.
  const rival = candidates.find(({screenLine: {a, b}}) =>
    Math.abs(signedDistance(best.screenLine, a)) > 1e-6 || Math.abs(signedDistance(best.screenLine, b)) > 1e-6);
  if (!rival || rival.score - best.score >= radius / 4) return best.solution;
}
