import {
  apply as mapPoint, area, clipPolygon, distance, dot, intersectConvex, orientCCW, signedDistance, sub,
  type Vec,
} from '../../vendor/origamio/src/geometry';
import { currentPolygon, isFlipped } from '../../vendor/origamio/src/paper';
import { NUMERICS, type PaperState } from './engine';
import { clipCrease } from './crease-references';
import { paperTransform } from './paper-pose';

type IndexPair = [number, number];
type FaceOrder = [number, number, 1 | -1];
type FrameKind = 'creasePattern' | 'foldedForm';
type Assignment = 'B' | 'F' | 'M' | 'V';
const { auditDistance, auditArea } = NUMERICS;
const coords = ({ x, y }: Vec): [number, number] => [x, y];

/** Represent retained creases as flat edges without changing the physical fold state. */
function exportMesh(state: PaperState) {
  let facets = state.facets;
  for (const crease of state.creases) {
    const refined = facets.flatMap(facet => {
      if (!clipCrease(crease, facet.poly)) return [facet];
      const {positive, negative} = clipPolygon(facet.poly, crease);
      if (positive.length && negative.length) return [{...facet, poly: positive}, {...facet, poly: negative}];
      return [facet];
    });
    if (refined.length !== facets.length) facets = refined;
  }
  return facets;
}

/** Export a single interoperable frame or a crease pattern with a folded child. */
export function exportFold(state: PaperState, kind: FrameKind | 'both' = 'both') {
  const facets = exportMesh(state);
  const material: Vec[] = [];
  const vertex = (point: Vec) => {
    const index = material.findIndex(other => distance(point, other) <= auditDistance);
    if (index >= 0) return index;
    return material.push(point) - 1;
  };
  // Collect vertex IDs in material coordinates before building conforming edges.
  const polygons = facets.map(facet => orientCCW(facet.poly).map(vertex));
  if (facets !== state.facets) {
    for (const {a, b} of state.creases) {
      vertex(a);
      vertex(b);
    }
  }
  const faces_vertices = polygons.map(ids => ids.flatMap((id, i) => {
    const next = ids[(i + 1) % ids.length];
    const a = material[id];
    const b = material[next];
    const dir = sub(b, a);
    const between = material.flatMap((point, candidate) => {
      if (candidate === id || candidate === next) return [];
      const t = dot(sub(point, a), dir) / dot(dir, dir);
      return t > 0 && t < 1 && Math.abs(signedDistance({a, b}, point)) <= auditDistance
        ? [{ candidate, t }]
        : [];
    });
    return [id, ...between.sort((x, y) => x.t - y.t).map(entry => entry.candidate)];
  }));
  const folded: Vec[] = [];
  const edges = new Map<string, { vertices: IndexPair; faces: number[] }>();
  faces_vertices.forEach((vertices, face) => {
    if (vertices.length < 3 || new Set(vertices).size !== vertices.length) {
      throw new Error('The material mesh contains a degenerate face.');
    }
    const facet = facets[face];
    vertices.forEach((id, index) => {
      const image = mapPoint(facet.transform, material[id]);
      if (folded[id] && distance(folded[id], image) > auditDistance) {
        throw new Error('The folded positions disagree at a shared material vertex.');
      }
      folded[id] ??= image;
      const next = vertices[(index + 1) % vertices.length];
      const key = id < next ? `${id},${next}` : `${next},${id}`;
      if (!edges.has(key)) edges.set(key, { vertices: [id, next], faces: [] });
      edges.get(key)!.faces.push(face);
    });
  });

  const edges_vertices: IndexPair[] = [];
  const edges_assignment: Assignment[] = [];
  const edges_foldAngle: number[] = [];
  for (const edge of edges.values()) {
    const [p, q] = edge.faces.map(index => facets[index]);
    if (edge.faces.length > 2) throw new Error('An edge has more than two incident faces.');
    edges_vertices.push(edge.vertices);
    const assignment = !q ? 'B' : isFlipped(p) === isFlipped(q) ? 'F' :
      (q.z > p.z) === !isFlipped(p) ? 'V' : 'M';
    edges_assignment.push(assignment);
    edges_foldAngle.push(assignment === 'V' ? 180 : assignment === 'M' ? -180 : 0);
  }

  const faceOrders: FaceOrder[] = [];
  const projected = facets.map(currentPolygon);
  for (const [i, a] of facets.entries()) {
    for (let j = i + 1; j < projected.length; j++) {
      if (area(intersectConvex(projected[i], projected[j])) <= auditArea) continue;
      const b = facets[j];
      if (a.z === b.z) throw new Error('An overlapping face pair has no distinct stack order.');
      const sign = (a.z > b.z) === !isFlipped(b) ? 1 : -1;
      faceOrders.push([i, j, sign]);
    }
  }

  const base = {
    file_spec: 1.1,
    file_creator: 'Origami Lab',
    file_classes: ['singleModel'],
    frame_unit: 'unit',
    frame_attributes: ['2D', 'orientable', 'manifold', 'convexFaces'],
    edges_vertices,
    edges_assignment,
    faces_vertices,
  };
  const crease = { frame_classes: ['creasePattern'], vertices_coords: material.map(coords) };
  const pose = paperTransform(state.pose);
  // A turnover reverses both face normals and stack order, preserving their relative FOLD signs.
  const form = {
    frame_classes: ['foldedForm'], vertices_coords: folded.map(point => coords(mapPoint(pose, point))),
    edges_foldAngle, faceOrders,
  };
  if (kind === 'creasePattern') return { ...base, ...crease };
  if (kind === 'foldedForm') return { ...base, ...form };
  return { ...base, ...crease, file_frames: [{ ...form, frame_parent: 0, frame_inherit: true }] };
}
