import { AREA_EPS, EPS, apply, area, clipPolygon, intersectConvex, signedDistance, type Line, type Side } from '../../vendor/origamio/src/geometry';
import { currentPolygon, type PaperState } from '../../vendor/origamio/src/paper';
import { hinges } from '../../vendor/origamio/src/rigid';
import type { MaterialPacket } from './packets';
import { paperInView } from './paper-pose';

type Link = {to: number; kind: 'moving-weld' | 'on-axis-weld' | 'cover'};

/** Hypotheses for a grab swinging toward the exposed face of the current view. */
export function packetCandidates(paper: PaperState, local: readonly MaterialPacket[], axis: Line, side: Side): MaterialPacket[] {
  if (!local.length) return [];
  const state = paperInView(paper);
  const top = local[0].facetIds[0];
  const facets = new Map(state.facets.map(facet => [facet.id, facet]));
  const moving = state.facets.flatMap(facet => {
    const cut = clipPolygon(currentPolygon(facet), axis);
    const poly = side === 1 ? cut.positive : cut.negative;
    return poly.length ? [{id: facet.id, z: facet.z, poly}] : [];
  });
  const active = new Set(moving.map(facet => facet.id));
  const links = new Map<number, Link[]>();
  function link(from: number, to: number, kind: Link['kind']) {
    const outgoing = links.get(from);
    if (outgoing) outgoing.push({to, kind});
    else links.set(from, [{to, kind}]);
  }
  function expand(seeds: Iterable<number>, scope: 'forced' | 'with-axis-joins', within?: ReadonlySet<number>) {
    const found = new Set(seeds);
    for (const id of found) {
      for (const {to, kind} of links.get(id) ?? []) {
        if (kind === 'on-axis-weld' && scope === 'forced') continue;
        if (!within || within.has(to)) found.add(to);
      }
    }
    return found;
  }
  for (const {p, q, a, b} of hinges(state)) {
    if (!active.has(p) || !active.has(q)) continue;
    const transform = facets.get(p)!.transform;
    const reach = [a, b].map(point => signedDistance(axis, apply(transform, point)) * side);
    // An attachment off the axis must move with the packet. A hinge on the axis
    // can connect a larger interpretation, but need not move with the first flap.
    if (reach.some(value => value > EPS)) {
      link(p, q, 'moving-weld');
      link(q, p, 'moving-weld');
    } else if (reach.every(value => Math.abs(value) <= EPS)) {
      link(p, q, 'on-axis-weld');
      link(q, p, 'on-axis-weld');
    }
  }
  // An overlying ply can obstruct the swing even when its old weld lies
  // entirely on the fixed side. Propose carrying it with the lower paper.
  // The reverse dependency would incorrectly pick up lower, stationary plies.
  for (const lower of moving) {
    for (const upper of moving) {
      if (upper.z > lower.z && area(intersectConvex(lower.poly, upper.poly)) > AREA_EPS) {
        link(lower.id, upper.id, 'cover');
      }
    }
  }

  const candidates = new Map<string, MaterialPacket>();
  function add(ids: ReadonlySet<number>) {
    if (!ids.has(top) || expand([top], 'with-axis-joins', ids).size !== ids.size) return;
    const facetIds = [...ids].sort((a, b) => a - b);
    candidates.set(facetIds.join(), {facetIds});
  }
  // Keep the user's initial grab so a failed search can explain its verdict.
  add(new Set([top]));
  for (const {facetIds} of local) {
    if (!facetIds.every(id => active.has(id))) continue;
    add(expand(facetIds, 'forced'));
  }
  add(expand([top], 'with-axis-joins'));
  return [...candidates.values()].sort((a, b) => a.facetIds.length - b.facetIds.length);
}
