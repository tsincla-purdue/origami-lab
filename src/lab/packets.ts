import {
  AREA_EPS, EPS, apply, area, containsPoint, intersectConvex, reflection, signedDistance,
  type Line, type Side, type Vec,
} from '../../vendor/origamio/src/geometry';
import { currentPolygon, fold, type FoldOptions, type FoldResult, type PaperState } from '../../vendor/origamio/src/paper';
import { hinges } from '../../vendor/origamio/src/rigid';

/** IDs in the material partition immediately before the operation. */
export interface MaterialPacket {
  readonly facetIds: readonly number[];
}

export function connected(ids: ReadonlySet<number>, state: PaperState): boolean {
  const first = ids.values().next().value;
  if (first === undefined) return false;
  if (ids.size === 1) return true;
  const neighbours = hinges(state);
  const remaining = new Set(ids);
  remaining.delete(first);
  const queue = [first];
  for (const id of queue) {
    for (const {p, q} of neighbours) {
      if (p === id && remaining.delete(q)) queue.push(q);
      if (q === id && remaining.delete(p)) queue.push(p);
    }
  }
  return remaining.size === 0;
}

/** Top prefixes that overlap in area near this point and are joined by material edges. */
export function cornerPackets(state: PaperState, point: Vec): MaterialPacket[] {
  const stack = [...state.facets].sort((a, b) => b.z - a.z || a.id - b.id)
    .map(facet => ({id: facet.id, poly: currentPolygon(facet)}))
    .filter(({poly}) => containsPoint(poly, point));
  if (!stack.length) return [];
  let common = stack[0].poly;
  const ids = new Set<number>([stack[0].id]);
  const choices: MaterialPacket[] = [{facetIds: [stack[0].id]}];
  for (const {id, poly} of stack.slice(1)) {
    const overlap = intersectConvex(common, poly);
    // A neighbour touching only at the corner is a different flap.
    if (area(overlap) <= AREA_EPS || !containsPoint(overlap, point)) continue;
    common = overlap;
    ids.add(id);
    if (connected(ids, state)) choices.push({facetIds: [...ids].sort((a, b) => a - b)});
  }
  return choices;
}

/** The exact opening destination of a corner when all packet attachments share an axis. */
export function packetHingeLanding(state: PaperState, packet: MaterialPacket, corner: Vec): Vec | undefined {
  const ids = new Set(packet.facetIds);
  const facets = new Map(state.facets.map(facet => [facet.id, facet]));
  const welds = hinges(state).filter(({p, q}) => ids.has(p) !== ids.has(q)).map(({p, a, b}) => {
    const transform = facets.get(p)!.transform;
    return { a: apply(transform, a), b: apply(transform, b) };
  });
  const axis = welds[0];
  if (!axis || Math.abs(signedDistance(axis, corner)) <= EPS ||
      welds.some(({a, b}) => [a, b].some(point => Math.abs(signedDistance(axis, point)) > EPS))) return;
  return apply(reflection(axis), corner);
}

/** Use Origamio to split and reflect the selected material, then restore the stationary stack. */
export function foldPacket(state: PaperState, axis: Line, side: Side, ids: ReadonlySet<number>, options: FoldOptions): FoldResult {
  const trial = fold({ ...state, facets: state.facets.filter(facet => ids.has(facet.id)) }, axis, side, options);
  if (!trial.movedIds.length) return { ...trial, state };
  const moving = new Set(trial.movedIds);
  const before = new Map(state.facets.map(facet => [facet.id, facet]));
  const stationary = [
    ...state.facets.filter(facet => !ids.has(facet.id)),
    ...trial.state.facets.filter(facet => !moving.has(facet.id)).map(facet => ({ ...facet, z: before.get(facet.id)!.z })),
  ];
  // The local result already reverses the packet. Keep that order at the chosen exterior surface.
  const packet = trial.state.facets.filter(facet => moving.has(facet.id));
  const offset = options.placement === 'bottom'
    ? Math.min(...stationary.map(facet => facet.z)) - 1 - packet[packet.length - 1].z
    : Math.max(...stationary.map(facet => facet.z)) + 1 - packet[0].z;
  const combined = [...stationary, ...packet.map(facet => ({ ...facet, z: facet.z + offset }))]
    .sort((a, b) => a.z - b.z || a.id - b.id);
  const ranks = new Map<number, number>();
  const facets = combined.map(facet => {
    if (!ranks.has(facet.z)) ranks.set(facet.z, ranks.size);
    return { ...facet, z: ranks.get(facet.z)! };
  });
  return { ...trial, state: { ...trial.state, facets } };
}
