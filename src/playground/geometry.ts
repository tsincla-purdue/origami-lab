import {
  AREA_EPS, EPS, add, apply, applyToLine, area, bounds, compose, cross, distance, dot, intersectConvex, invert, length, lerp, orientCCW, perpendicularBisector,
  scale, sideOf, sub, type Line, type Mat, type Polygon, type Side, type Vec,
} from '../../vendor/origamio/src/geometry';
import { currentPolygon } from '../../vendor/origamio/src/paper';
import { snapTargets } from '../../vendor/origamio/src/snap';
import type { Move } from '../lab/engine';
import { paperInView, type PaperState } from '../lab/paper-pose';
import { clipCrease, facetCreaseSegments } from '../lab/crease-references';
import { materialIntersectionDetails, materialLine, segmentIntersection, visibleMaterialMarks, type IntersectionSources } from '../lab/material-points';
import { containsLinePoint, type LineReference } from '../lab/line-constraints';
import { CORNERS, squareVertices } from '../lab/proof-graph';
import type { CreaseReference, SelectedLine, SelectedPoint, VertexReference } from '../lab/geometry-intent';
import { lineKey, pointKey, releaseRadius, selectSnap } from './snap-selection';

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

/** Unlike a target segment hit, a pinned point can follow the extension of its own line. */
export function nearestSupportingLine(lines: readonly LineReference[], screen: Vec, transform: Mat, radius: number) {
  let closest: LineReference | undefined;
  let best = radius;
  for (const reference of lines) {
    const a = apply(transform, reference.line.a);
    const delta = sub(apply(transform, reference.line.b), a);
    const extent = length(delta);
    if (extent <= EPS) continue;
    const gap = Math.abs(cross(delta, sub(screen, a))) / extent;
    if (gap > best || (closest && gap === best)) continue;
    closest = reference;
    best = gap;
  }
  return closest;
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
  readonly facetId: number;
  readonly references: readonly Line[];
  readonly sources: IntersectionSources;
  readonly markId?: number;
}

export type SurfaceContact = 'surface' | 'edge' | 'crease' | 'intersection' | 'mark';

/** Stack order decides which projected corner can be picked at a shared screen position. */
export function paperGeometry(paper: PaperState, exposedOnly = false) {
  const state = paperInView(paper);
  const faces = [...state.facets].sort((a, b) => b.z - a.z).map(facet => {
    const world = currentPolygon(facet);
    return {facet, world, poly: orientCCW(world), creases: facetCreaseSegments(state, facet)};
  });
  const topLayer = (point: Vec) => faces.findIndex(({poly}) => location(poly, point));
  const marks = visibleMaterialMarks(state).filter(({point, position}) => {
    if (!exposedOnly) return true;
    const face = faces[topLayer(position)];
    return face && location(orientCCW(face.facet.poly), point) &&
      distance(position, apply(face.facet.transform, point)) <= EPS;
  });
  const marked = marks.map(({position}) => position);
  const midpointRefs = new WeakMap<Vec, {facetId: number; edgeMidpoint: number; point: Vec}>();
  const corners: Vec[] = [];
  const vertexRefs = new Map<Vec, VertexReference>();
  for (const [index, {poly, facet, world}] of faces.entries()) {
    const above = faces.slice(0, index);
    for (const point of poly) {
      const covered = above.some(face => location(face.poly, point));
      if (covered || corners.some(corner => distance(corner, point) <= EPS)) continue;
      corners.push(point);
      const material = facet.poly[world.indexOf(point)];
      const corner = CORNERS.find(name => {
        const [x, y] = squareVertices[name];
        return material.x === x && material.y === y;
      });
      if (corner) vertexRefs.set(point, {facetId: facet.id, corner});
    }
  }
  const hit = (point: Vec) => {
    for (const {poly} of faces) {
      const where = location(poly, point);
      if (where) return where;
    }
  };
  const visibleAt = (point: Vec, layer: number) => exposedOnly
    ? topLayer(point) === layer
    : !faces.slice(0, layer).some(({poly}) => location(poly, point) === 'inside');
  const edges = faces.flatMap(({poly}, layer) =>
    poly.map((a, i) => ({line: {a, b: poly[(i + 1) % poly.length]}, layer})));
  const creaseLines = faces.flatMap(({creases}, layer) => creases.map(({line, index}) => ({line, layer, index})));
  // Keep the original per-layer search order so equal-distance O5 targets stay stable.
  const lines: {line: Line; layer: number; index?: number}[] = [...creaseLines, ...edges].sort((a, b) => a.layer - b.layer);
  let references: Vec[] | undefined;
  let exposed: LineReference[] | undefined;
  const creaseRefs = new WeakMap<LineReference, CreaseReference>();
  function lineReference(line: Line, layer: number, index: number | undefined): LineReference {
    const facetId = faces[layer].facet.id;
    const reference = {line, facetId};
    if (index !== undefined) creaseRefs.set(reference, {facetId, crease: index});
    return reference;
  }
  function grabLines(): readonly LineReference[] {
    return exposed ??= lines.flatMap(({line, layer, index}) => {
      let segments = distance(line.a, line.b) > EPS ? [line] : [];
      for (let upper = 0; upper < layer && segments.length; upper++) {
        segments = segments.flatMap(segment => subtractCover(segment, faces[upper].poly));
      }
      return segments.map(segment => lineReference(segment, layer, index));
    });
  }
  function pointReference(point: Vec, facetId?: number): SelectedPoint {
    const midpoint = midpointRefs.get(point);
    if (midpoint && (facetId === undefined || midpoint.facetId === facetId)) return {point, material: midpoint};
    const vertex = vertexRefs.get(point);
    const mark = marks.find(({position}) => position === point);
    const exposedFacet = exposedOnly ? faces[topLayer(point)]?.facet.id : undefined;
    const face = faces.find(({facet, poly}) =>
      (facetId ?? vertex?.facetId ?? exposedFacet ?? facet.id) === facet.id && location(poly, point) &&
      (!mark || location(orientCCW(facet.poly), mark.point)));
    if (!face) return {point};
    const corner = vertex?.facetId === face.facet.id ? vertex.corner : undefined;
    const material = corner ? {x: squareVertices[corner][0], y: squareVertices[corner][1]}
      : mark?.point ?? apply(invert(face.facet.transform), point);
    return {point, material: {facetId: face.facet.id, point: material,
      ...(corner && {corner}), ...(mark && {markId: mark.id})}};
  }
  function rememberMidpoint(point: Vec) {
    for (const {facet, poly} of faces) {
      if (!location(poly, point)) continue;
      for (let edge = 0; edge < 4; edge++) {
        const {a, b} = materialLine(state, {edge})!;
        if (![a, b].every(end => facet.poly.some(p => distance(p, end) === 0))) continue;
        const middle = lerp(a, b, .5);
        if (distance(apply(facet.transform, middle), point) <= EPS) {
          midpointRefs.set(point, {facetId: facet.id, edgeMidpoint: edge, point: middle});
          return;
        }
      }
      return;
    }
  }
  return {
    corners,
    marked,
    vertexReference: (point: Vec) => vertexRefs.get(point),
    creaseReference: (reference: LineReference) => creaseRefs.get(reference),
    lineReference: (reference: LineReference): SelectedLine => ({...reference, ...creaseRefs.get(reference)}),
    pointReference,
    contains: (point: Vec) => hit(point) !== undefined,
    exposedFacet: (point: Vec) => faces[topLayer(point)]?.facet.id,
    packetExposed(ids: ReadonlySet<number>) {
      return faces.every(({facet, poly}, layer) => !ids.has(facet.id) ||
        !faces.slice(0, layer).some(upper => !ids.has(upper.facet.id) && upper.facet.z > facet.z &&
          area(intersectConvex(poly, upper.poly)) > AREA_EPS));
    },
    lineVisible: exposedOnly ? (reference: LineReference, point: Vec) =>
      reference.facetId === faces[topLayer(point)]?.facet.id : undefined,
    sameSurface(candidate: Vec, probe: Vec) {
      const layer = topLayer(probe);
      return layer < 0 || topLayer(candidate) === layer;
    },
    /** Sample a single exposed face. Work in its material coordinates for intersections. */
    surfaceAt(probe: Vec, reach: number, contactRadius: number) {
      const layer = topLayer(probe);
      const face = faces[layer];
      if (!face) return {proximity: 0};
      const toMaterial = invert(face.facet.transform);
      const local = apply(toMaterial, probe);
      const visible = (point: Vec) => topLayer(point) === layer;
      const intersections = materialIntersectionDetails(state, local, reach).flatMap(result => {
        const position = apply(face.facet.transform, result.point);
        if (!visible(position) || result.references.some(line => !clipCrease(line, face.facet.poly))) return [];
        return [{...result, position}];
      });
      const nearbyMarks = marks.filter(({position}) => visible(position) && distance(probe, position) <= reach);
      let feature: {contact: SurfaceContact; key: string} = {contact: 'surface', key: 'surface'};
      let proximity = 0;
      const offer = (kind: SurfaceContact, id: string, point: Vec) => {
        const gap = distance(probe, point);
        proximity = Math.max(proximity, 1 - gap / reach);
        if (gap <= contactRadius) feature = {contact: kind, key: id};
      };
      const identity: Mat = {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0};
      const edge = nearestLine(edges.filter(ref => ref.layer === layer), probe, identity, reach, (_, point) => visible(point));
      const crease = nearestLine(creaseLines.filter(ref => ref.layer === layer), probe, identity, reach, (_, point) => visible(point));
      if (edge) offer('edge', lineKey(edge.reference.line), edge.point);
      if (crease) offer('crease', String(crease.reference.index), crease.point);
      const mark = nearbyMarks.reduce<typeof nearbyMarks[number] | undefined>((best, candidate) =>
        !best || distance(probe, candidate.position) < distance(probe, best.position) ? candidate : best, undefined);
      if (mark) offer('mark', String(mark.id), mark.position);
      const intersection = intersections[0];
      if (intersection && (!mark || distance(mark.point, intersection.point) > EPS)) {
        offer('intersection', pointKey(intersection.point), intersection.position);
      }
      return {contact: feature.contact, key: `${layer}/${feature.contact}/${feature.key}`, proximity,
        intersection: intersection && distance(probe, intersection.position) <= contactRadius ? intersection : undefined};
    },
    markOptions(screen: Vec, transform: Mat, radius: number, locked?: MarkOption): MarkOption[] {
      const world = apply(invert(transform), screen);
      const reach = releaseRadius(radius) / Math.hypot(transform.a, transform.b);
      const options: (MarkOption & {visible: boolean})[] = [];
      for (const [layer, {facet, poly}] of faces.entries()) {
        const local = apply(invert(facet.transform), world);
        for (const {point, references, sources} of materialIntersectionDetails(state, local, reach)) {
          const position = apply(facet.transform, point);
          // Containment uses the displayed polygon and the displayed intersection.
          if (!location(poly, position) || options.some(option => distance(option.point, point) <= EPS)) continue;
          const markId = state.marks?.find(mark => distance(mark.point, point) <= EPS)?.id;
          const visible = visibleAt(position, layer);
          options.push({point, position, rank: faces.length - layer, facetId: facet.id, markId, visible, sources,
            references: references.flatMap(line => {
              const local = clipCrease(line, facet.poly);
              return local ? [applyToLine(facet.transform, local)] : [];
            })});
        }
      }
      const key = (option: MarkOption) => `${option.facetId}/${pointKey(option.point)}`;
      const candidates = options.filter(option => option.visible ||
        options.some(other => other.visible && distance(option.position, other.position) <= EPS));
      return selectSnap(candidates.map(value => ({key: key(value), value,
        score: Math.round(distance(apply(transform, value.position), screen) * 1e6) / 1e6 + (value.visible ? 0 : 1e-6)
      })), radius, locked && key(locked))
        .map(({value}) => value);
    },
    snapPoints() {
      if (exposedOnly) {
        const targets = edges.flatMap(({line: {a, b}, layer}) => {
          const point = lerp(a, b, .5);
          if (!visibleAt(point, layer)) return [];
          rememberMidpoint(point);
          return [point];
        });
        const creasePoints = creaseLines.flatMap(({line: {a, b}, layer}) =>
          [a, b, lerp(a, b, .5)].filter(point => visibleAt(point, layer)));
        return [...marked, ...corners, ...targets, ...creasePoints];
      }
      const { minX, maxX, minY, maxY } = bounds(faces.flatMap(({poly}) => poly));
      const center = scale(add({ x: minX, y: minY }, { x: maxX, y: maxY }), 0.5);
      const targets = snapTargets(state).points.filter(({kind, point}) => kind !== 'vertex' && hit(point) === 'edge');
      for (const target of targets) if (target.kind === 'midpoint') rememberMidpoint(target.point);
      const endpoints = faces.flatMap(({creases}, layer) => creases.flatMap(({line: {a, b}}) =>
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
      for (const {line: {a, b}, layer, index} of lines) {
        const midpoint = lerp(a, b, .5);
        if (index === undefined && visibleAt(midpoint, layer)) rememberMidpoint(midpoint);
        for (const point of [a, b, midpoint]) {
          if (visibleAt(point, layer)) include(point);
        }
      }
      const includeIntersection = (first: typeof lines[number], second: typeof lines[number]) => {
        if (exposedOnly && first.layer !== second.layer) return;
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
    grabLines,
    pointSources(point: Vec, facetId: number) {
      return grabLines().filter(reference => reference.facetId === facetId && containsLinePoint(reference.line, point));
    },
    snapLine(screen: Vec, transform: Mat, radius: number) {
      const hit = nearestLine(lines, screen, transform, radius, ({layer}, point) => visibleAt(point, layer));
      if (hit) return {line: hit.reference.line, point: hit.point};
    },
    lineCandidates(screen: Vec, transform: Mat, radius: number) {
      return lines.flatMap(reference => {
        const hit = nearestLine([reference], screen, transform, releaseRadius(radius),
          ({layer}, point) => visibleAt(point, layer));
        if (!hit) return [];
        return [{key: `pin/${reference.layer}/${lineKey(reference.line)}`,
          score: distance(screen, apply(transform, hit.point)), value: lineReference(reference.line, reference.layer, reference.index)}];
      });
    },
  };
}
