import { IDENTITY, compose, type Mat } from '../../vendor/origamio/src/geometry';
import type { PaperState as OrigamioState } from '../../vendor/origamio/src/paper';
import type { MaterialMark } from './material-points';

export interface PaperPose {
  readonly reversed: boolean;
  readonly materialAxisX: number;
  readonly frontOffset: number;
  readonly backOffset: number;
}

type DisplayPaper = OrigamioState & { readonly marks?: readonly MaterialMark[] };
export type PaperState = DisplayPaper & { readonly pose?: PaperPose };

export function paperTransform(pose: PaperPose | undefined): Mat {
  if (!pose) return IDENTITY;
  return pose.reversed ? {...IDENTITY, a: -1, e: pose.backOffset} : {...IDENTITY, e: pose.frontOffset};
}

const displayed = new WeakMap<PaperState, DisplayPaper>();

/** Project the model once for drawing and hit testing. Material polygons and marks stay local. */
export function paperInView(state: PaperState): DisplayPaper {
  if (!state.pose) return state;
  const cached = displayed.get(state);
  if (cached) return cached;
  const {pose, ...paper} = state;
  const transform = paperTransform(pose);
  const ranks = state.facets.map(({z}) => z);
  const extremes = Math.min(...ranks) + Math.max(...ranks);
  const facets = state.facets.map(facet => Object.freeze({
    ...facet,
    transform: Object.freeze(compose(transform, facet.transform)),
    z: pose.reversed ? extremes - facet.z : facet.z,
  })).sort((a, b) => a.z - b.z || a.id - b.id);
  const view = Object.freeze({...paper, facets: Object.freeze(facets)});
  displayed.set(state, view);
  return view;
}
