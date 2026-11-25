import { add, clipPolygon, lineDirection, scale, type Line, type Polygon, type Vec } from '../../vendor/origamio/src/geometry';
import { currentPolygon, isFlipped } from '../../vendor/origamio/src/paper';
import { visibleMaterialMarks, type MaterialPacket, type PaperState, type PaperStyle } from '../lab';
import { facetCreases } from '../lab/crease-references';
import { CORNER_HIT_RADIUS, LINE_GRAB_RADIUS, type MarkOption } from './geometry';
import type { ConstraintIssue, CornerSelection, Draft } from './gestures';

type Face = 'front' | 'back';
type Ink = readonly [paper: string, motif: string];

const palette: Record<PaperStyle, Record<Face, Ink>> = {
  classic: { front: ['#fffdf6', '#ddd8cb'], back: ['#e8e3d9', '#c8bfb3'] },
  'two-tone': { front: ['#efab82', '#efab82'], back: ['#5d526e', '#5d526e'] },
  grid: { front: ['#f2f7ec', '#a6beab'], back: ['#c2d7c7', '#749a87'] },
  stripes: { front: ['#f5e3c8', '#a45740'], back: ['#e59877', '#782e37'] },
  dots: { front: ['#faf0dc', '#b487a5'], back: ['#d5b9d9', '#7a526e'] },
  checker: { front: ['#f5f0db', '#b1c1db'], back: ['#aebfda', '#5c7298'] },
  border: { front: ['#fae9d7', '#a15747'], back: ['#e6bdab', '#7c413d'] },
  waves: { front: ['#e1edea', '#648d94'], back: ['#91b4b6', '#385e73'] },
};

function pattern(style: PaperStyle, face: Face, width: number, height: number, prefix: string): string {
  const [paper, ink] = palette[style][face];
  const tile = Math.min(width, height) / 8;
  let w = tile;
  let h = tile;
  let marks = '';
  switch (style) {
    case 'grid':
      marks = `<path d="M0 ${tile}V0H${tile}" fill="none" stroke="${ink}" stroke-width="${tile * .055}"/>`;
      break;
    case 'stripes':
      marks = `<path d="M${-tile} 0 L0 ${tile} M0 0 L${tile} ${tile} M${tile} 0 L${2 * tile} ${tile}" stroke="${ink}" stroke-width="${tile * .23}"/>`;
      break;
    case 'dots':
      marks = `<circle cx="${tile / 2}" cy="${tile / 2}" r="${tile * .17}" fill="${ink}"/>`;
      break;
    case 'checker':
      marks = `<path d="M0 0h${tile / 2}v${tile / 2}H0Z M${tile / 2} ${tile / 2}h${tile / 2}v${tile / 2}H${tile / 2}Z" fill="${ink}"/>`;
      break;
    case 'border': {
      w = width;
      h = height;
      const border = (inset: number, weight: number) =>
        `<rect x="${inset}" y="${inset}" width="${w - 2 * inset}" height="${h - 2 * inset}" fill="none" stroke="${ink}" stroke-width="${weight}"/>`;
      marks = border(tile * .33, tile * .13) + border(tile * .54, tile * .038);
      break;
    }
    case 'waves':
      w = 2 * tile;
      marks = `<path d="M0 ${tile / 2} Q${tile / 2} 0 ${tile} ${tile / 2} T${w} ${tile / 2}" fill="none" stroke="${ink}" stroke-width="${tile * .11}"/>`;
      break;
  }
  return `<pattern id="${prefix}-${face}" patternUnits="userSpaceOnUse" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${paper}"/>${marks}</pattern>`;
}

export function styleSwatch(style: PaperStyle): string {
  const prefix = `swatch-${style}`;
  return `<svg viewBox="0 0 .55 .55" aria-hidden="true"><defs>${pattern(style, 'front', .55, .55, prefix)}</defs><rect width=".55" height=".55" fill="url(#${prefix}-front)"/></svg>`;
}

export const faceColor = (style: PaperStyle, face: Face) => palette[style][face][0];
const points = (poly: Polygon) => poly.map(({x, y}) => `${x},${y}`).join(' ');

/** Both the polygon and its fill are authored in the same original sheet coordinates. */
export function foldedFacets(state: PaperState, showCreases = false): string {
  return [...state.facets].sort((a, b) => a.z - b.z).map(facet => {
    const {a, b, c, d, e, f} = facet.transform;
    const face = isFlipped(facet) ? 'back' : 'front';
    return `<polygon class="paper-facet" data-id="${facet.id}" data-face="${face}" points="${points(facet.poly)}" transform="matrix(${a} ${b} ${c} ${d} ${e} ${f})" fill="url(#paper-${face})"/>` +
      (showCreases ? facetCreases(state, facet).map(({a, b}) => segment(a, b, 'paper-reference')).join('') : '');
  }).join('');
}

export function paperMarkup(state: PaperState, style: PaperStyle, unfolded: boolean): string {
  const defs = `<defs>${pattern(style, 'front', state.width, state.height, 'paper')}${pattern(style, 'back', state.width, state.height, 'paper')}` +
    `<clipPath id="paper-silhouette">${state.facets.map(facet => `<polygon points="${points(currentPolygon(facet))}"/>`).join('')}</clipPath></defs>`;
  if (!unfolded) return defs + foldedFacets(state, true);
  const surface = `<rect class="paper-facet" data-face="front" width="${state.width}" height="${state.height}" fill="url(#paper-front)"/>`;
  return defs + surface + state.creases.map(({a, b}) => segment(a, b, 'crease')).join('');
}

const segment = (a: Vec, b: Vec, cls: string) =>
  `<line class="${cls}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
const circle = (p: Vec, radius: number, cls: string) =>
  `<circle class="${cls}" cx="${p.x}" cy="${p.y}" r="${radius}"/>`;

function perpendicularMarker(draft: Draft, source: Line, unit: number) {
  const foot = scale(add(draft.anchor, draft.destination), .5);
  const along = scale(lineDirection(source), 9 * unit);
  const across = scale(lineDirection(draft.line), 9 * unit);
  const corner = add(foot, along);
  return `<polyline class="perpendicular-marker" points="${points([corner, add(corner, across), add(foot, across)])}"/>`;
}

export function constraintMarkup(pin: Vec | undefined, draft: Draft | undefined, issue: ConstraintIssue | undefined, landings: readonly Vec[], unit: number) {
  const constraint = draft?.constraint;
  const line = constraint?.target ?? issue?.target;
  const source = draft?.lineIntent?.source.line ?? draft?.source ?? issue?.source;
  const others = new Set(landings);
  if (draft) others.delete(draft.destination);
  const alternatives = [...others].map(point => circle(point, 6 * unit, 'alternative-landing')).join('');
  return (line ? segment(line.a, line.b, 'constraint-target') : '') +
    (source ? segment(source.a, source.b, 'constraint-source') : '') +
    (source && draft && (draft.lineIntent?.kind === 'perpendicular-point' || draft.capture?.kind === 'marked-perpendicular')
      ? perpendicularMarker(draft, source, unit) : '') +
    alternatives + (pin ? circle(pin, 6 * unit, 'pin-anchor') : '');
}

export function cornerHandles(corners: readonly Vec[], unit: number): string {
  return corners.map(point =>
    circle(point, CORNER_HIT_RADIUS * unit, 'corner-touch') + circle(point, 3.75 * unit, 'corner-dot')).join('');
}

export function markHandles(points: readonly Vec[], unit: number): string {
  return points.map(point => circle(point, CORNER_HIT_RADIUS * unit, 'mark-touch')).join('');
}

export function lineHandles(lines: readonly Line[], unit: number): string {
  return lines.map(({a, b}) => `<line class="line-touch" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${2 * LINE_GRAB_RADIUS * unit}"/>`).join('');
}

export function markMarkup(state: PaperState, unit: number, unfolded = false): string {
  const marks = unfolded ? state.marks?.map(mark => ({...mark, position: mark.point})) : visibleMaterialMarks(state);
  return (marks ?? []).map(({id, position}) =>
    `<circle class="material-mark" data-mark-id="${id}" cx="${position.x}" cy="${position.y}" r="${3.5 * unit}"/>`).join('');
}

export function markSelection(option: MarkOption | undefined, unit: number, ghost = false): string {
  if (!option) return '';
  return `<g data-facet-id="${option.facetId}" data-layer="${option.rank}">` +
    option.references.map(({a, b}) => segment(a, b, 'intersection-reference')).join('') +
    circle(option.position, 8 * unit, ghost ? 'intersection-ghost' : 'intersection-selection') + '</g>';
}

export type FoldGuide = Pick<Draft, 'line' | 'side'> & Partial<Pick<Draft, 'anchor' | 'destination' | 'snapped' | 'creaseSnapped'>>;

export function packetMarkup(state: PaperState, selection: CornerSelection, draft: FoldGuide | undefined, unit: number, inferred?: MaterialPacket): string {
  const packet = inferred ?? selection.packets.find(choice => choice.facetIds.length === selection.count);
  const selected = new Set(packet?.facetIds ?? state.facets.map(facet => facet.id));
  const cutting = draft?.side !== undefined;
  const highlights = state.facets.filter(facet => selected.has(facet.id)).map(facet => {
    let poly = currentPolygon(facet);
    if (cutting) {
      const cut = clipPolygon(poly, draft.line);
      poly = draft.side === 1 ? cut.positive : cut.negative;
    }
    return poly.length
      ? `<polygon class="packet-highlight${cutting ? ' packet-moving' : ''}" data-facet-id="${facet.id}" points="${points(poly)}"/>`
      : '';
  }).join('');
  return highlights + circle(selection.corner, 6 * unit, 'packet-anchor');
}

export function previewMarkup(state: PaperState, draft: FoldGuide | undefined, result: PaperState | undefined, hover: Vec | undefined, unit: number, shadeWhole = true): string {
  if (!draft) return hover ? circle(hover, 7 * unit, 'corner-hover') : '';
  const {line, side, anchor, destination, snapped, creaseSnapped} = draft;
  const parts: string[] = [];
  if (result) parts.push(`<g class="fold-endpoint">${foldedFacets(result)}${markMarkup(result, unit)}</g>`);
  if (line) {
    const span = state.size * 16;
    const direction = scale(lineDirection(line), span);
    if (side !== undefined && shadeWhole) {
      const frame = [{x: -span, y: -span}, {x: span, y: -span}, {x: span, y: span}, {x: -span, y: span}];
      const cut = clipPolygon(frame, line);
      const moving = side === 1 ? cut.positive : cut.negative;
      parts.unshift(`<polygon class="preview-side" clip-path="url(#paper-silhouette)" points="${points(moving)}"/>`);
    }
    parts.push(segment(add(line.a, scale(direction, -1)), add(line.a, direction),
      creaseSnapped ? 'preview-line crease-snapped' : 'preview-line'));
  }
  if (anchor) parts.push(circle(anchor, 6 * unit, 'drag-anchor'));
  if (destination) parts.push(circle(destination, 5 * unit, 'drag-destination'));
  for (const p of snapped ?? []) parts.push(circle(p, 9 * unit, 'snap-active'));
  if (creaseSnapped) {
    for (const p of [line.a, line.b]) parts.push(circle(p, 9 * unit, 'snap-active crease-snap-reference'));
  }
  return parts.join('');
}
