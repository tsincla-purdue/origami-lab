import { EPS, apply, clipPolygon, signedDistance, type Line, type Side } from '../../vendor/origamio/src/geometry';
import { currentPolygon, type PaperState } from '../../vendor/origamio/src/paper';
import { hinges } from '../../vendor/origamio/src/rigid';
import type { MaterialPacket } from './packets';
import { paperInView } from './paper-pose';

function expand(seeds: Iterable<number>, links: ReadonlyMap<number, number[]>, within?: ReadonlySet<number>): Set<number> {
  const found = new Set(seeds);
  for (const id of found) {
    for (const neighbour of links.get(id) ?? []) {
      if (!within || within.has(neighbour)) found.add(neighbour);
    }
  }
  return found;
}

/** Material hypotheses for an unchanged axis and moving side. The validator decides which can fold. */
export function packetCandidates(paper: PaperState, local: readonly MaterialPacket[], axis: Line, side: Side): MaterialPacket[] {
  if (!local.length) return [];
  const state = paperInView(paper);
  const top = local[0].facetIds[0];
  const facets = new Map(state.facets.map(facet => [facet.id, facet]));
  const active = new Set(state.facets.filter(facet => {
    const cut = clipPolygon(currentPolygon(facet), axis);
    return (side === 1 ? cut.positive : cut.negative).length > 0;
  }).map(facet => facet.id));
  const required = new Map<number, number[]>();
  const joins = new Map<number, number[]>();
  function link(graph: Map<number, number[]>, p: number, q: number) {
    graph.set(p, [...(graph.get(p) ?? []), q]);
    graph.set(q, [...(graph.get(q) ?? []), p]);
  }
  for (const {p, q, a, b} of hinges(state)) {
    if (!active.has(p) || !active.has(q)) continue;
    const transform = facets.get(p)!.transform;
    const reach = [a, b].map(point => signedDistance(axis, apply(transform, point)) * side);
    // An attachment off the axis must move with the packet. A hinge on the axis
    // can connect a larger interpretation, but need not move with the first flap.
    if (reach.some(value => value > EPS)) {
      link(required, p, q);
      link(joins, p, q);
    } else if (reach.every(value => Math.abs(value) <= EPS)) {
      link(joins, p, q);
    }
  }

  const candidates = new Map<string, MaterialPacket>();
  function add(ids: ReadonlySet<number>) {
    if (!ids.has(top) || expand([top], joins, ids).size !== ids.size) return;
    const facetIds = [...ids].sort((a, b) => a - b);
    candidates.set(facetIds.join(), {facetIds});
  }
  // Keep the user's initial grab so a failed search can explain its verdict.
  add(new Set([top]));
  for (const {facetIds} of local) {
    if (!facetIds.every(id => active.has(id))) continue;
    add(expand(facetIds, required));
  }
  add(expand([top], joins));
  return [...candidates.values()].sort((a, b) => a.facetIds.length - b.facetIds.length);
}
