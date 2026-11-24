import {
  EPS, add, apply, bounds, compose, cross, distance, dot, invert, length, lerp, orientCCW, perpendicularBisector,
  scale, sideOf, sub, type Line, type Mat, type Polygon, type Side, type Vec,
} from '../../vendor/origamio/src/geometry';
import { currentPolygon } from '../../vendor/origamio/src/paper';
import { snapTargets } from '../../vendor/origamio/src/snap';
import type { LineReference, Move, PaperState } from '../lab';
import { clipCrease, facetCreases } from '../lab/crease-references';
import { materialIntersections, segmentIntersection, visibleMaterialMarks } from '../lab/material-points';

export const CORNER_HIT_RADIUS = 22;
export const MARK_HIT_RADIUS = 15;
export const LINE_GRAB_RADIUS = 8;

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

export function nearestLine<T extends {readonly line: Line}>(
  lines: readonly T[], screen: Vec, transform: Mat, radius: number, visible?: (reference: T, point: Vec) => boolean,
) {
  let closest: {reference: T; point: Vec} | undefined;
  let best = radius;
  for (const reference of lines) {
    const {a, b} = reference.line;
    const start = apply(transform, a);
    const delta = sub(apply(transform, b), start);
    const squared = dot(delta, delta);
    if (squared <= EPS) continue;
    const t = Math.min(1, Math.max(0, dot(sub(screen, start), delta) / squared));
    const gap = distance(screen, add(start, scale(delta, t)));
    if (gap > best || (closest && gap === best)) continue;
    const point = lerp(a, b, t);
    if (visible && !visible(reference, point)) continue;
    best = gap;
    closest = {reference, point};
  }
  return closest;
}

function subtractCover(line: Line, poly: Polygon): Line[] {
  const covered = clipCrease(line, poly);
  if (!covered) return [line];
  const remaining: Line[] = [];
  if (distance(line.a, covered.a) > EPS) remaining.push({a: line.a, b: covered.a});
  if (distance(covered.b, line.b) > EPS) remaining.push({a: covered.b, b: line.b});
  return remaining;
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

export interface MarkOption {
  readonly point: Vec;
  readonly position: Vec;
  readonly rank: number;
  readonly markId?: number;
}

/** Stack order decides which projected corner can be picked at a shared screen position. */
export function paperGeometry(state: PaperState) {
  const faces = [...state.facets].sort((a, b) => b.z - a.z).map(facet => ({
    facet, poly: orientCCW(currentPolygon(facet)), creases: facetCreases(state, facet),
  }));
  const marked = visibleMaterialMarks(state).map(({position}) => position);
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
  let exposed: LineReference[] | undefined;
  return {
    corners,
    marked,
    contains: (point: Vec) => hit(point) !== undefined,
    markOptions(screen: Vec, transform: Mat, radius: number): MarkOption[] {
      const world = apply(invert(transform), screen);
      const reach = radius / Math.hypot(transform.a, transform.b);
      const options: (MarkOption & {visible: boolean})[] = [];
      for (const [layer, {facet}] of faces.entries()) {
        const local = apply(invert(facet.transform), world);
        for (const point of materialIntersections(state, local, reach)) {
          if (!location(facet.poly, point) || options.some(option => distance(option.point, point) <= EPS)) continue;
          const position = apply(facet.transform, point);
          const markId = state.marks?.find(mark => distance(mark.point, point) <= EPS)?.id;
          const visible = !faces.slice(0, layer).some(({poly}) => location(poly, position));
          options.push({point, position, rank: faces.length - layer, markId, visible});
        }
      }
      const closest = nearestPoint(options.filter(option => option.visible).map(({position}) => position), screen, transform, radius);
      return closest ? options.filter(option => distance(option.position, closest) <= EPS) : [];
    },
    snapPoints() {
      const { minX, maxX, minY, maxY } = bounds(faces.flatMap(({poly}) => poly));
      const center = scale(add({ x: minX, y: minY }, { x: maxX, y: maxY }), 0.5);
      const targets = snapTargets(state).points.filter(({kind, point}) => kind !== 'vertex' && hit(point) === 'edge');
      const endpoints = faces.flatMap(({creases}, layer) => creases.flatMap(({a, b}) =>
        [a, b, scale(add(a, b), .5)].filter(point => visibleAt(point, layer))));
      return [...marked, ...corners, ...targets.map(({point}) => point), ...endpoints, center];
    },
    creasePoints() {
      if (references) return references;
      const points: Vec[] = [];
      const include = (point: Vec) => {
        if (!points.some(existing => distance(existing, point) <= EPS)) points.push(point);
      };
      for (const point of marked) include(point);
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
    grabLines(): readonly LineReference[] {
      return exposed ??= lines.flatMap(({line, layer}) => {
        let segments = distance(line.a, line.b) > EPS ? [line] : [];
        for (let upper = 0; upper < layer && segments.length; upper++) {
          segments = segments.flatMap(segment => subtractCover(segment, faces[upper].poly));
        }
        return segments.map(line => ({line, facetId: faces[layer].facet.id}));
      });
    },
    snapLine(screen: Vec, transform: Mat, radius: number) {
      const hit = nearestLine(lines, screen, transform, radius, ({layer}, point) => visibleAt(point, layer));
      if (hit) return {line: hit.reference.line, point: hit.point};
    },
  };
}
