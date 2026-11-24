import {
  EPS, add, applyToLine, chord, dot, length, scale, sub, type Line, type Polygon,
} from '../../vendor/origamio/src/geometry';
import type { Facet, PaperState } from '../../vendor/origamio/src/paper';

/** Intersect a finite crease with one convex material facet. */
export function clipCrease(segment: Line, material: Polygon): Line | undefined {
  const delta = sub(segment.b, segment.a);
  const extent = length(delta);
  if (extent <= EPS) return;
  const span = chord(material, segment);
  if (!span) return;
  const direction = scale(delta, 1 / extent);
  const first = dot(sub(span[0], segment.a), direction);
  const second = dot(sub(span[1], segment.a), direction);
  const low = Math.max(0, Math.min(first, second));
  const high = Math.min(extent, Math.max(first, second));
  if (high - low > EPS) return {
    a: add(segment.a, scale(direction, low)),
    b: add(segment.a, scale(direction, high)),
  };
}

export function facetCreases(state: PaperState, facet: Facet): Line[] {
  return state.creases.flatMap(crease => {
    const clipped = clipCrease(crease, facet.poly);
    return clipped ? [applyToLine(facet.transform, clipped)] : [];
  });
}
