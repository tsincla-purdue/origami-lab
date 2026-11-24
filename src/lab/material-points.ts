import {
  EPS, apply, containsPoint, cross, distance, length, lerp, sub, type Line, type Vec,
} from '../../vendor/origamio/src/geometry';
import { currentPolygon, type PaperState } from '../../vendor/origamio/src/paper';
import { paperInView, type PaperState as LabPaperState } from './paper-pose';

export interface MaterialMark {
  readonly id: number;
  readonly point: Vec;
}

/** Intersect finite, non-collinear segments, including their endpoints. */
export function segmentIntersection(first: Line, second: Line): Vec | undefined {
  const ab = sub(first.b, first.a);
  const cd = sub(second.b, second.a);
  const extent = length(ab);
  const otherExtent = length(cd);
  const determinant = cross(ab, cd);
  if (Math.abs(determinant) <= EPS * extent * otherExtent) return;
  const offset = sub(second.a, first.a);
  const t = cross(offset, cd) / determinant;
  const u = cross(offset, ab) / determinant;
  const firstTolerance = EPS / extent;
  const secondTolerance = EPS / otherExtent;
  if (t < -firstTolerance || t > 1 + firstTolerance || u < -secondTolerance || u > 1 + secondTolerance) return;
  return t <= firstTolerance ? first.a : 1 - t <= firstTolerance ? first.b : lerp(first.a, first.b, t);
}

/** Exact intersections on the original sheet, within a material-space search radius. */
export function materialIntersections(state: PaperState, near: Vec, radius: number): Vec[] {
  if (!near || !Number.isFinite(near.x) || !Number.isFinite(near.y) || radius < 0 || !Number.isFinite(radius)) return [];
  const {width, height} = state;
  const corners = [{x: 0, y: 0}, {x: width, y: 0}, {x: width, y: height}, {x: 0, y: height}];
  const edges = corners.map((a, index) => ({a, b: corners[(index + 1) % corners.length]}));
  const limit = radius + EPS;
  const creases = state.creases.filter(({a, b}) =>
    Math.min(a.x, b.x) <= near.x + limit && Math.max(a.x, b.x) >= near.x - limit &&
    Math.min(a.y, b.y) <= near.y + limit && Math.max(a.y, b.y) >= near.y - limit);
  const points: Vec[] = [];
  function include(first: Line, second: Line) {
    const point = segmentIntersection(first, second);
    if (point && distance(point, near) <= radius && !points.some(other => distance(other, point) <= EPS)) {
      points.push(point);
    }
  }
  // Prefer the coordinate on the actual paper edge when several pairs meet there.
  for (const edge of edges) for (const crease of creases) include(edge, crease);
  for (const [index, first] of creases.entries()) {
    for (let i = index + 1; i < creases.length; i++) include(first, creases[i]);
  }
  return points.sort((a, b) => distance(a, near) - distance(b, near));
}

/** A mark belongs to material, so splitting or restoring a facet does not change its identity. */
export function visibleMaterialMarks(paper: LabPaperState) {
  const state = paperInView(paper);
  if (!state.marks?.length) return [];
  const faces = [...state.facets].sort((a, b) => b.z - a.z).map(facet => ({facet, world: currentPolygon(facet)}));
  return state.marks.flatMap(mark => {
    const layer = faces.findIndex(({facet}) => containsPoint(facet.poly, mark.point));
    if (layer < 0) return [];
    const position = apply(faces[layer].facet.transform, mark.point);
    if (faces.slice(0, layer).some(({world}) => containsPoint(world, position))) return [];
    return [{...mark, position}];
  });
}
