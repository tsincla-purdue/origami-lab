import {
  EPS, add, apply, bounds, compose, cross, distance, length, orientCCW, perpendicularBisector,
  scale, sideOf, sub, type Line, type Mat, type Polygon, type Side, type Vec,
} from '../../vendor/origamio/src/geometry';
import { currentPolygon, type PaperState } from '../../vendor/origamio/src/paper';
import { snapTargets } from '../../vendor/origamio/src/snap';
import type { Move } from '../lab';

export const CORNER_HIT_RADIUS = 22;

/** Include the paper's y-up to SVG y-down conversion in the screen transform. */
export function paperToScreen(svgToScreen: Mat, size: number): Mat {
  return compose(svgToScreen, { a: 1, b: 0, c: 0, d: -1, e: 0, f: size });
}

/** Nearest target in screen pixels. Return the exact geometry of that target. */
export function nearestPoint(points: readonly Vec[], screen: Vec, transform: Mat, radius: number): Vec | undefined {
  let best: Vec | undefined;
  let limit = radius;
  for (const point of points) {
    const gap = distance(apply(transform, point), screen);
    if (gap <= radius && (!best || gap < limit)) {
      best = point;
      limit = gap;
    }
  }
  return best;
}

export function foldMove(line: Line, side: Side, label: string): Move {
  return { line: [[line.a.x, line.a.y], [line.b.x, line.b.y]], side, label };
}

export function cornerFold(anchor: Vec, destination: Vec, screen: Mat, minimumPixels: number) {
  if (distance(anchor, destination) <= EPS ||
      distance(apply(screen, anchor), apply(screen, destination)) < minimumPixels) return;
  const line = perpendicularBisector(anchor, destination);
  return { line, side: sideOf(line, anchor) };
}

function location(poly: Polygon, point: Vec): 'edge' | 'inside' | undefined {
  let onEdge = false;
  for (const [i, a] of poly.entries()) {
    const edge = sub(poly[(i + 1) % poly.length], a);
    const tolerance = EPS * length(edge);
    const offset = cross(edge, sub(point, a));
    if (offset < -tolerance) return;
    if (offset <= tolerance) onEdge = true;
  }
  return onEdge ? 'edge' : 'inside';
}

/** Stack order decides which projected corner can be picked at a shared screen position. */
export function paperGeometry(state: PaperState) {
  const faces = [...state.facets].sort((a, b) => b.z - a.z).map(facet => orientCCW(currentPolygon(facet)));
  const corners: Vec[] = [];
  for (const [index, poly] of faces.entries()) {
    const above = faces.slice(0, index);
    for (const point of poly) {
      const covered = above.some(face => location(face, point));
      if (!covered && !corners.some(corner => distance(corner, point) <= EPS)) corners.push(point);
    }
  }
  const hit = (point: Vec) => {
    for (const poly of faces) {
      const where = location(poly, point);
      if (where) return where;
    }
  };
  return {
    corners,
    contains: (point: Vec) => hit(point) !== undefined,
    snapPoints() {
      const { minX, maxX, minY, maxY } = bounds(faces.flat());
      const center = scale(add({ x: minX, y: minY }, { x: maxX, y: maxY }), 0.5);
      const targets = snapTargets(state).points.filter(({kind, point}) => kind !== 'vertex' && hit(point) === 'edge');
      return [...corners, ...targets.map(({point}) => point), center];
    },
  };
}
