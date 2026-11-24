import {
  EPS, add, apply, bounds, compose, cross, distance, dot, length, lerp, orientCCW, perpendicularBisector,
  scale, sideOf, sub, type Line, type Mat, type Polygon, type Side, type Vec,
} from '../../vendor/origamio/src/geometry';
import { currentPolygon, type PaperState } from '../../vendor/origamio/src/paper';
import { snapTargets } from '../../vendor/origamio/src/snap';
import type { Move } from '../lab';
import { facetCreases } from '../lab/crease-references';

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

function segmentIntersection(first: Line, second: Line): Vec | undefined {
  const ab = sub(first.b, first.a);
  const cd = sub(second.b, second.a);
  const offset = sub(second.a, first.a);
  const determinant = cross(ab, cd);
  if (Math.abs(determinant) <= EPS * length(ab) * length(cd)) return;
  const t = cross(offset, cd) / determinant;
  const u = cross(offset, ab) / determinant;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return lerp(first.a, first.b, t);
}

/** Stack order decides which projected corner can be picked at a shared screen position. */
export function paperGeometry(state: PaperState) {
  const faces = [...state.facets].sort((a, b) => b.z - a.z).map(facet => ({
    poly: orientCCW(currentPolygon(facet)), creases: facetCreases(state, facet),
  }));
  const corners: Vec[] = [];
  for (const [index, {poly}] of faces.entries()) {
    const above = faces.slice(0, index);
    for (const point of poly) {
      const covered = above.some(face => location(face.poly, point));
      if (!covered && !corners.some(corner => distance(corner, point) <= EPS)) corners.push(point);
    }
  }
  const hit = (point: Vec) => {
    for (const {poly} of faces) {
      const where = location(poly, point);
      if (where) return where;
    }
  };
  const visibleAt = (point: Vec, layer: number) =>
    !faces.slice(0, layer).some(({poly}) => location(poly, point) === 'inside');
  const edges = faces.flatMap(({poly}, layer) =>
    poly.map((a, i) => ({line: {a, b: poly[(i + 1) % poly.length]}, layer})));
  const creaseLines = faces.flatMap(({creases}, layer) => creases.map(line => ({line, layer})));
  // Keep the original per-layer search order so equal-distance O5 targets stay stable.
  const lines = [...creaseLines, ...edges].sort((a, b) => a.layer - b.layer);
  let references: Vec[] | undefined;
  return {
    corners,
    contains: (point: Vec) => hit(point) !== undefined,
    snapPoints() {
      const { minX, maxX, minY, maxY } = bounds(faces.flatMap(({poly}) => poly));
      const center = scale(add({ x: minX, y: minY }, { x: maxX, y: maxY }), 0.5);
      const targets = snapTargets(state).points.filter(({kind, point}) => kind !== 'vertex' && hit(point) === 'edge');
      const marks = faces.flatMap(({creases}, layer) => creases.flatMap(({a, b}) =>
        [a, b, scale(add(a, b), .5)].filter(point => visibleAt(point, layer))));
      return [...corners, ...targets.map(({point}) => point), ...marks, center];
    },
    creasePoints() {
      if (references) return references;
      const points: Vec[] = [];
      const include = (point: Vec) => {
        if (!points.some(existing => distance(existing, point) <= EPS)) points.push(point);
      };
      for (const {line: {a, b}, layer} of lines) {
        for (const point of [a, b, lerp(a, b, .5)]) {
          if (visibleAt(point, layer)) include(point);
        }
      }
      const includeIntersection = (first: typeof lines[number], second: typeof lines[number]) => {
        const point = segmentIntersection(first.line, second.line);
        if (point && visibleAt(point, Math.max(first.layer, second.layer))) include(point);
      };
      for (const [i, first] of creaseLines.entries()) {
        for (const second of edges) includeIntersection(first, second);
        for (let j = i + 1; j < creaseLines.length; j++) includeIntersection(first, creaseLines[j]);
      }
      references = points;
      return references;
    },
    snapLine(screen: Vec, transform: Mat, radius: number) {
      let closest: {line: Line; point: Vec} | undefined;
      let best = radius;
      for (const {line, layer} of lines) {
        const a = apply(transform, line.a);
        const delta = sub(apply(transform, line.b), a);
        const squared = dot(delta, delta);
        if (squared <= EPS) continue;
        const t = Math.min(1, Math.max(0, dot(sub(screen, a), delta) / squared));
        const gap = distance(screen, add(a, scale(delta, t)));
        if (gap > best || (closest && gap === best)) continue;
        const point = add(line.a, scale(sub(line.b, line.a), t));
        if (!visibleAt(point, layer)) continue;
        closest = {line, point};
        best = gap;
      }
      return closest;
    },
  };
}
