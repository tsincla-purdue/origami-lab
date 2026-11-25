import { apply, cross, distance, length, scale, sub, type Line, type Vec } from '../../vendor/origamio/src/geometry';
import type { PaperState } from './engine';
import type { SelectedPoint } from './geometry-intent';
import type { IntersectionSources, MaterialLineId } from './material-points';
import { paperInView } from './paper-pose';
import { CORNERS, ProofGraph, ProofUnsupported, project } from './proof-graph';

export const vertexId = (corner: typeof CORNERS[number]) => `square:${corner}`;
const markId = (attempt: number) => `step:${attempt}:mark`;
const vec = ([x, y]: readonly [number, number]): Vec => ({x, y});
const pair = ({x, y}: Vec) => [x, y] as const;

export interface MaterialAxis {
  readonly id: string;
  readonly facetId: number;
}

export function displayAxis(graph: ProofGraph, axis: string, state: PaperState, facetId: number): Line {
  const facet = paperInView(state).facets.find(({id}) => id === facetId);
  if (!facet) throw new Error('Missing projection facet.');
  return projectAxis(graph.axis(axis), facet.transform);
}

function projectAxis(axis: ReturnType<ProofGraph['axis']>, transform: PaperState['facets'][number]['transform']): Line {
  const point = vec(project(axis.point));
  const direction = vec(project(axis.direction));
  const extent = length(direction);
  if (!(extent > 0 && Number.isFinite(extent))) throw new ProofUnsupported('The line has no reliable numerical direction.');
  const along = scale(direction, 1 / extent);
  // Transform a unit direction separately so small exact directions survive translation.
  const start = apply(transform, point);
  const {a, b, c, d} = transform;
  return {a: start, b: {x: start.x + a * along.x + c * along.y, y: start.y + b * along.x + d * along.y}};
}

function liesInFacet(facet: PaperState['facets'][number], point: Vec) {
  const signed = facet.poly.map((a, i) => {
    const edge = sub(facet.poly[(i + 1) % facet.poly.length], a);
    return cross(edge, sub(point, a)) / length(edge);
  });
  return signed.every(value => value >= -1e-8) || signed.every(value => value <= 1e-8);
}

/** Persistent symbolic objects live in the original material frame. */
export class MaterialGeometry {
  private readonly edges = new Set<number>();
  private readonly midpoints = new Set<number>();
  private readonly marks = new Map<number, readonly [string, string]>();
  private readonly creases = new Map<number, string>();

  constructor(readonly graph: ProofGraph) {}

  line(ref: MaterialLineId): string | undefined {
    if ('crease' in ref) return this.creases.get(ref.crease);
    const id = `square:edge:${ref.edge}`;
    if (!this.edges.has(ref.edge)) {
      this.graph.add(id, {kind: 'through', from: vertexId(CORNERS[ref.edge]), to: vertexId(CORNERS[(ref.edge + 1) % 4])});
      this.edges.add(ref.edge);
    }
    return id;
  }

  point(ref: SelectedPoint): string | undefined {
    const material = ref.material;
    if (!material) return;
    if (material.corner !== undefined) return vertexId(material.corner);
    if (material.markId !== undefined && this.marks.has(material.markId)) return markId(material.markId);
    const edge = material.edgeMidpoint;
    if (edge === undefined) return;
    const id = `square:midpoint:${edge}`;
    if (!this.midpoints.has(edge)) {
      this.graph.add(id, {kind: 'midpoint', from: vertexId(CORNERS[edge]), to: vertexId(CORNERS[(edge + 1) % 4])});
      this.midpoints.add(edge);
    }
    return id;
  }

  mark(attempt: number, sources: IntersectionSources, point: Vec) {
    const first = this.line(sources[0]), second = this.line(sources[1]);
    if (!first || !second) return;
    const id = markId(attempt);
    this.graph.add(id, {kind: 'intersection', first, second});
    if (distance(vec(project(this.graph.point(id))), point) > 1e-8) {
      throw new ProofUnsupported('The exact intersection cannot be reliably bound to the material mark.');
    }
    this.marks.set(attempt, [first, second]);
    return id;
  }

  recordCreases(attempt: number, before: PaperState, after: PaperState, intrinsic?: MaterialAxis, freehand = false) {
    const facet = before.facets.find(({id}) => id === intrinsic?.facetId);
    const introduced: string[] = [];
    for (let index = before.creases.length; index < after.creases.length; index++) {
      const crease = after.creases[index];
      if (intrinsic && facet && [crease.a, crease.b].every(point => liesInFacet(facet, point))) {
        // The material segment comes from the selected facet's cut, verified by physical replay.
        const axis = this.graph.axis(intrinsic.id);
        const origin = vec(project(axis.point)), direction = vec(project(axis.direction));
        if ([crease.a, crease.b].every(point => Math.abs(cross(direction, sub(point, origin))) <= 2e-12 * length(direction))) {
          this.creases.set(index, intrinsic.id);
          continue;
        }
      }
      const id = `step:${attempt}:crease:${index}`;
      const assumption = `${id}:${freehand ? 'freehand' : 'unproved'}`;
      this.graph.add(id, {kind: 'parameter-line', from: pair(crease.a), to: pair(crease.b), assumption});
      this.creases.set(index, id);
      introduced.push(assumption);
    }
    return introduced;
  }

  perpendicular(state: PaperState, moving: number, through: number, crease: number, facetId: number) {
    const source = this.line({crease});
    const facet = paperInView(state).facets.find(({id}) => id === facetId);
    if (!source || !facet || !this.marks.has(moving) || !this.marks.has(through)) return;
    const marks = [moving, through].map(id => state.marks?.find(mark => mark.id === id));
    if (!marks.every(mark => mark && liesInFacet(facet, mark.point))) return;
    const p = markId(moving), q = markId(through);
    const dependencies = [p, q, source];
    const assumptions = [...new Set(dependencies.flatMap(id => this.graph.assumptions(id)))];
    if (assumptions.length && ![moving, through].every(id => this.marks.get(id)?.includes(source))) {
      throw new ProofUnsupported('A conditional perpendicular needs both intersections explicitly defined on its supporting line.');
    }
    const {axis, landing} = this.graph.markedPerpendicular(p, q, source);
    return {line: projectAxis(axis, facet.transform), landing: apply(facet.transform, vec(project(landing))),
      dependencies, assumptions};
  }
}
