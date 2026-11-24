import {
  EPS, add, distance, dot, length, perpendicularBisector, scale, sideOf, signedDistance, sub,
  type Line, type Side, type Vec,
} from '../../vendor/origamio/src/geometry';

export interface ConstraintSolution {
  readonly destination: Vec;
  readonly line: Line;
  readonly side: Side;
}

export interface ConstraintResult {
  readonly status: 'solved' | 'no-solution' | 'unverified';
  readonly solutions: readonly ConstraintSolution[];
  readonly reason: string;
}

/** Intersect the circle centred at pin through moving with a line or its finite segment. */
export function solvePointOntoLine(pin: Vec, moving: Vec, target: Line, finite = false): ConstraintResult {
  const displacement = sub(target.b, target.a);
  const extent = length(displacement);
  const radius = distance(pin, moving);
  const empty = (status: 'no-solution' | 'unverified', reason: string): ConstraintResult =>
    ({ status, reason, solutions: [] });
  if (!Number.isFinite(extent) || !Number.isFinite(radius) || extent <= EPS || radius <= EPS) {
    return empty('unverified', 'Choose distinct paper points and a target with a nonzero length.');
  }
  const direction = scale(displacement, 1 / extent);
  const relative = sub(pin, target.a);
  const foot = dot(relative, direction);
  const normal = direction.x * relative.y - direction.y * relative.x;
  const gap = (radius - Math.abs(normal)) * (radius + Math.abs(normal));
  // Account for projection and cancellation near tangency in binary64.
  const tolerance = 64 * Number.EPSILON * Math.max(radius, Math.abs(normal)) *
    Math.max(radius, Math.abs(normal), extent, Math.abs(relative.x), Math.abs(relative.y));
  if (!Number.isFinite(gap) || !Number.isFinite(tolerance) || (gap !== 0 && Math.abs(gap) <= tolerance)) {
    return empty('unverified', 'The circle and target are too close to tangency to distinguish their intersections.');
  }
  if (gap < 0) return empty('no-solution', 'The moving point cannot reach this line while the pin stays fixed.');

  const offset = Math.sqrt(gap);
  const roots = offset === 0 ? [foot] : [foot - offset, foot + offset];
  const solutions: ConstraintSolution[] = [];
  let uncertainEndpoint = false;
  const endpointTolerance = 64 * Number.EPSILON * Math.max(extent, Math.abs(foot), offset);
  for (const t of roots) {
    if (!Number.isFinite(t)) return empty('unverified', 'The intersection is outside the numerical range.');
    if (finite && (t < 0 || t > extent)) {
      uncertainEndpoint ||= Math.min(Math.abs(t), Math.abs(t - extent)) <= endpointTolerance;
      continue;
    }
    const destination = t === 0 ? target.a : t === extent ? target.b : add(target.a, scale(direction, t));
    const travel = distance(destination, moving);
    if (!Number.isFinite(travel)) return empty('unverified', 'The landing point is outside the numerical range.');
    if (travel <= EPS) continue;
    try {
      const line = perpendicularBisector(moving, destination);
      if (Math.abs(signedDistance(line, pin)) <= EPS) {
        solutions.push({ destination, line, side: sideOf(line, moving) });
        continue;
      }
    } catch {
      // At large coordinate offsets, the endpoints of a unit axis may coincide.
    }
    return empty('unverified', 'The calculated fold axis could not be verified to pass through the pin.');
  }
  if (!solutions.length && uncertainEndpoint) return empty('unverified', 'The landing point is too close to a segment endpoint to verify.');
  return solutions.length
    ? { status: 'solved', solutions, reason: '' }
    : empty('no-solution', finite ? 'No distinct landing point lies on this segment.' : 'The intersection would leave the moving point in place.');
}
