import { EPS, dot, length, sub, type Vec } from '../../vendor/origamio/src/geometry';
import type { Move } from './engine';
import type { LineReference } from './line-constraints';
import type { SquareCorner } from './proof-graph';

export interface VertexReference { readonly facetId: number; readonly corner: SquareCorner }
export interface CreaseReference { readonly facetId: number; readonly crease: number }

export interface SelectedPoint {
  readonly point: Vec;
  readonly material?: {
    readonly facetId: number;
    readonly point: Vec;
    readonly corner?: SquareCorner;
    readonly markId?: number;
    readonly edgeMidpoint?: number;
  };
}

export interface SelectedLine extends LineReference {
  readonly crease?: number;
}

export type PointOnLine = {
  readonly kind: 'point-on-line';
  readonly moving: SelectedPoint;
  readonly pin: SelectedPoint;
  readonly target: SelectedLine;
};

type Branch = 'before-foot' | 'at-foot' | 'after-foot';

/** Branch of the circle/line solution along the oriented target segment. */
export function pointOnLineBranch(pin: Vec, landing: Vec, target: SelectedLine): Branch {
  const direction = sub(target.line.b, target.line.a);
  const offset = dot(sub(landing, pin), direction) / length(direction);
  return offset < -EPS ? 'before-foot' : offset > EPS ? 'after-foot' : 'at-foot';
}

export type CapturedGeometry =
  | { readonly kind: 'freehand' }
  | { readonly kind: 'vertex-bisector'; readonly moving: VertexReference; readonly target: VertexReference }
  | { readonly kind: 'equilateral-o5'; readonly moving: VertexReference; readonly pin: VertexReference;
      readonly target: CreaseReference; readonly branch: 'above-pin' }
  | { readonly kind: 'perpendicular-through'; readonly pin: VertexReference; readonly source: CreaseReference }
  | (PointOnLine & { readonly landing: Vec; readonly branch: Branch })
  | { readonly kind: 'point-to-point'; readonly moving: SelectedPoint; readonly target: SelectedPoint }
  | { readonly kind: 'through-points'; readonly points: readonly SelectedPoint[] }
  | { readonly kind: 'marked-perpendicular'; readonly moving: SelectedPoint; readonly through: SelectedPoint;
      readonly source: SelectedLine; readonly landing: Vec }
  | { readonly kind: 'line-fold'; readonly source: SelectedLine; readonly target?: SelectedLine; readonly pin?: SelectedPoint };

export type GeometryEvidence = { readonly version: 1 } & (
  Extract<CapturedGeometry, {kind: 'freehand'}> |
  (Exclude<CapturedGeometry, {kind: 'freehand'}> & {
    readonly projection: { readonly axis: Move['line']; readonly side: Move['side'] };
  })
);
