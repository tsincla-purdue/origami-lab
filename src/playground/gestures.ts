import {
  EPS, add, apply, distance, dot, invert, signedDistance, sub, type Line, type Mat, type Side, type Vec,
} from '../../vendor/origamio/src/geometry';
import {
  cornerPackets, resolveLineFold, solvePointOntoLine,
  type ConstraintResult, type ConstraintSolution, type LineFoldIntent, type LineReference, type MaterialPacket, type PaperState,
} from '../lab';
import { packetHingeLanding } from '../lab/packets';
import type { CapturedGeometry } from '../lab/proof-geometry';
import { creasePairs, drawnMarkCandidates, sameAxis } from './crease-snap';
import { lineKey, pointKey, releaseRadius, selectSnap, snapRadius, type SnapCandidate } from './snap-selection';
import {
  CORNER_HIT_RADIUS, LINE_GRAB_RADIUS, MARK_HIT_RADIUS, cornerFold, foldMove, nearestLine,
  nearestPoint, nearestSupportingLine, paperGeometry, paperToScreen, type MarkOption,
} from './geometry';

export type Tool = 'corner' | 'crease';
export interface Draft {
  readonly tool: Tool;
  readonly line: Line;
  readonly side?: Side;
  readonly anchor: Vec;
  readonly destination: Vec;
  readonly snapped: readonly Vec[];
  readonly creaseSnapped?: boolean;
  readonly packet?: MaterialPacket;
  readonly inferFrom?: readonly MaterialPacket[];
  readonly constraint?: { readonly target: Line; readonly solutions: readonly ConstraintSolution[]; readonly index: number };
  readonly lineIntent?: LineFoldIntent;
  readonly source?: Line;
  readonly snapLabel?: string;
  readonly alternatives?: readonly Draft[];
  readonly capture?: CapturedGeometry;
}

export interface ConstraintIssue {
  readonly reason: string;
  readonly target?: Line;
  readonly source?: Line;
  readonly status?: 'unverified' | 'rejected';
}

export function draftMove(draft: Draft) {
  if (draft.side === undefined) return;
  const label = draft.lineIntent?.kind === 'align-lines' ? 'Align lines'
    : draft.lineIntent ? 'Perpendicular through point'
    : draft.constraint ? 'Point onto line' : draft.snapLabel ?? (draft.creaseSnapped ? 'Crease through two points'
    : draft.tool === 'corner' ? 'Point drag' : 'Drawn crease');
  const move = foldMove(draft.line, draft.side, label);
  return {...move, ...(draft.packet && {packet: draft.packet}), ...(draft.lineIntent && {intent: draft.lineIntent})};
}

export interface CornerSelection {
  readonly corner: Vec;
  readonly packets: readonly MaterialPacket[];
  readonly count: number | 'all';
}

const TAP_INTERVAL = 3500; // Milliseconds between deliberate taps. Dragging has no deadline.
const PIN_HOLD = 550;

interface Drag {
  id: number;
  start: Vec;
  anchor: Vec;
  tapAnchor: Vec;
  rawAnchor: Vec;
  grabOffset: Vec;
  minimum: number;
  moved: boolean;
  tapOnly: boolean;
  hingeLandings: readonly Vec[];
  source?: LineReference;
  pointSources: readonly LineReference[];
  snapKey?: string;
  holdTimer?: number;
  longPress?: boolean;
}

const client = (event: PointerEvent): Vec => ({x: event.clientX, y: event.clientY});

export function connectGestures(svg: SVGSVGElement, callbacks: {
  snapping: () => boolean;
  show: (draft?: Draft, hover?: Vec, issue?: ConstraintIssue) => void;
  commit: (draft: Draft) => void;
}) {
  let state: PaperState | undefined;
  let tool: Tool = 'corner';
  let geometry: ReturnType<typeof paperGeometry> | undefined;
  let targets: readonly Vec[] | undefined;
  let drag: Drag | undefined;
  let held: Draft | undefined;
  let pin: Vec | undefined;
  let confirmPin = false;
  let issue: ConstraintIssue | undefined;
  let frame = 0;
  let selection: CornerSelection | undefined;
  let lastTap: number | undefined;
  let wholeStack = false;
  let explicit = false;
  let offeredMarks: readonly MarkOption[] = [];
  let ghost: MarkOption | undefined;
  const packetOptions = new Map<Vec, readonly MaterialPacket[]>();

  function chooseCorner(corner: Vec | undefined) {
    if (selection?.corner === corner) return;
    const packets = corner && state ? packetOptions.get(corner) ?? cornerPackets(state, corner) : [];
    if (corner) packetOptions.set(corner, packets);
    selection = corner && packets.length ? { corner, packets, count: wholeStack ? 'all' : packets[0].facetIds.length } : undefined;
    lastTap = undefined;
    explicit = wholeStack;
  }

  function packet() {
    return selection?.packets.find(choice => choice.facetIds.length === selection?.count);
  }

  function material() {
    return { packet: packet(), inferFrom: tool === 'corner' && !explicit ? selection?.packets : undefined };
  }

  function cycle(time: number) {
    if (!selection) return;
    const current = selection.packets.findIndex(choice => choice.facetIds.length === selection?.count);
    const next = lastTap !== undefined && time - lastTap <= TAP_INTERVAL
      ? (current + 1) % selection.packets.length : 0;
    selection = { ...selection, count: selection.packets[next].facetIds.length };
    wholeStack = false;
    explicit = true;
    lastTap = time;
  }

  function refreshHeld() {
    if (held) held = { ...held, ...material() };
    callbacks.show(held, undefined, issue);
  }

  function transform() {
    const screen = svg.getScreenCTM();
    if (state && screen && Math.abs(screen.a * screen.d - screen.b * screen.c) > EPS) {
      return paperToScreen(screen, state.size);
    }
  }

  function snap(point: Vec, map: NonNullable<ReturnType<typeof transform>>, event: PointerEvent, hingeLandings: readonly Vec[] = []) {
    if (!geometry || !callbacks.snapping() || event.altKey) return;
    targets ??= geometry.snapPoints();
    return nearestPoint(hingeLandings.length ? [...hingeLandings, ...targets] : targets, point, map, snapRadius(event.pointerType));
  }

  function release() {
    cancelAnimationFrame(frame);
    frame = 0;
    const id = drag?.id;
    window.clearTimeout(drag?.holdTimer);
    drag = undefined;
    if (id !== undefined && svg.hasPointerCapture(id)) svg.releasePointerCapture(id);
  }

  function cancel() {
    release();
    held = undefined;
    pin = undefined;
    confirmPin = false;
    issue = undefined;
    offeredMarks = [];
    ghost = undefined;
    callbacks.show();
  }

  function constrainedDraft(
    result: ConstraintResult, anchor: Vec, target: Vec, map: Mat, targetLine: Line, lineIntent?: LineFoldIntent,
  ): Draft | undefined {
    const source = lineIntent?.source.line;
    if (result.status !== 'solved') {
      issue = {source, target: targetLine, reason: result.reason, status: result.status === 'unverified' ? 'unverified' : 'rejected'};
      return;
    }
    const candidates = result.solutions.map(solution => solution.destination);
    const landing = nearestPoint(candidates, target, map, Infinity)!;
    const start = apply(map, anchor);
    if (lineIntent && lineIntent.kind !== 'align-lines' &&
        dot(sub(target, start), sub(apply(map, landing), start)) <= 0) {
      issue = {source, reason: 'Drag along the line toward the reflected landing.'};
      return;
    }
    const index = candidates.indexOf(landing);
    return {...result.solutions[index], tool, anchor, snapped: [landing], ...material(), lineIntent,
      constraint: {target: targetLine, solutions: result.solutions, index}};
  }

  function pinnedDraft(reference: LineReference, anchor: Vec, target: Vec, map: Mat, fixed: Vec) {
    const result = solvePointOntoLine(fixed, anchor, reference.line, true);
    const draft = constrainedDraft(result, anchor, target, map, reference.line);
    if (!draft || !geometry) return draft;
    const pin = geometry.vertexReference(fixed);
    const moving = geometry.vertexReference(anchor);
    const crease = geometry.creaseReference(reference);
    // The supported finite construction has exactly one branch. Other solves keep their numerical choices.
    if (!pin || !moving || !crease || result.solutions.length !== 1 || draft.destination.y <= fixed.y) return draft;
    return {...draft, capture: {kind: 'equilateral-o5', pin, moving, target: crease, branch: 'above-pin'} as const};
  }

  function previewSnap(options: readonly SnapCandidate<Draft>[], radius: number, press: Drag): Draft | undefined {
    const [primary, ...nearby] = selectSnap(options, radius, press.snapKey);
    press.snapKey = primary?.key;
    if (!primary) return;
    const candidates = [primary, ...nearby];
    const distinct: Draft[] = [];
    const targetFacet = (draft: Draft) => draft.lineIntent?.kind === 'align-lines' ? draft.lineIntent.target.facetId : undefined;
    for (const {value} of candidates) {
      // The same motion may hit a mark and align its line. Keep the alignment's material reference.
      const alignment = value.source && candidates.find(({value: option}) =>
        option.lineIntent?.kind === 'align-lines' && sameAxis(value.line, option.line));
      const draft = alignment ? alignment.value : value;
      if (!distinct.some(other => targetFacet(draft) === targetFacet(other) && sameAxis(draft.line, other.line))) distinct.push(draft);
    }
    return distinct.length > 1 ? {...distinct[0], alternatives: distinct.slice(1)} : distinct[0];
  }

  function pointDrafts(press: Drag, target: Vec, map: Mat, points: readonly Vec[], radius: number) {
    return points.flatMap(destination => {
      const score = distance(apply(map, destination), target);
      if (score > releaseRadius(radius)) return [];
      const fold = cornerFold(press.anchor, destination, map, press.minimum);
      if (!fold) return [];
      const source = press.source?.line;
      const snapLabel = source ? 'Grabbed point onto mark'
        : geometry?.marked.includes(destination) ? 'Point onto mark' : undefined;
      const moving = geometry?.vertexReference(press.anchor);
      const vertex = geometry?.vertexReference(destination);
      const capture = moving && vertex ? {kind: 'vertex-bisector', moving, target: vertex} as const : undefined;
      const value: Draft = {...fold, tool, anchor: press.anchor, destination, snapped: [destination], source, snapLabel, capture, ...material()};
      return [{key: `point/${pointKey(destination)}`, score, value}];
    });
  }

  function projection(event: PointerEvent): Draft | undefined {
    const map = transform();
    if (!drag || drag.tapOnly || drag.longPress || !map || distance(drag.start, client(event)) < drag.minimum) return;
    const target = add(client(event), drag.grabOffset);
    const {anchor} = drag;
    issue = undefined;
    const magnet = snapRadius(event.pointerType);
    const radius = event.pointerType === 'touch' ? 24 : 17;
    const snapping = callbacks.snapping() && !event.altKey;
    if (!snapping) drag.snapKey = undefined;
    if (tool === 'corner' && pin && !snapping) {
      issue = {reason: 'Enable snapping to continue the pinned fold.'};
      return;
    }
    const source = drag.source;
    const sameLine = source && nearestLine([source], target, map, radius);
    if (source && geometry && (!pin || sameLine)) {
      if (!pin) {
        if (!snapping) {
          issue = {source: source.line, reason: 'Enable snapping to align an edge or bring its grabbed point onto a mark.'};
          return;
        }
        const lines = geometry.grabLines().flatMap(reference => {
          if (reference === source || sameAxis(source.line, reference.line)) return [];
          const hit = nearestLine([reference], target, map, releaseRadius(magnet));
          if (!hit) return [];
          const intent: LineFoldIntent = {kind: 'align-lines', source, moving: anchor, target: reference};
          const value = constrainedDraft(resolveLineFold(intent), anchor, target, map, reference.line, intent);
          if (!value) return [];
          const lineGap = distance(target, apply(map, hit.point));
          const landingGap = distance(target, apply(map, value.destination));
          // The reflected grab gives the expected drag direction. Allow more leeway along a line than toward a point.
          const score = Math.max(lineGap, landingGap / 2);
          return [{key: `line/${reference.facetId}/${lineKey(reference.line)}`, score, value}];
        });
        const points = pointDrafts(drag, target, map, geometry.marked, magnet);
        const snapped = previewSnap([...lines, ...points], magnet, drag);
        if (snapped) issue = undefined;
        else issue ??= {source: source.line, reason: 'Drag toward a visible line or marked point.'};
        return snapped;
      }
      const lineIntent: LineFoldIntent = {kind: 'perpendicular', source, moving: anchor, pin};
      return constrainedDraft(resolveLineFold(lineIntent), anchor, target, map, source.line, lineIntent);
    }
    if (tool === 'corner' && pin && geometry) {
      const choices = selectSnap(geometry.lineCandidates(target, map, radius), radius, drag.snapKey);
      const nearby = choices[0];
      // At a junction, favor the grabbed line on a tie. A closer distinct target still uses O5.
      const reach = nearby ? Math.min(radius, nearby.score + 1) : radius;
      const pointSource = nearestSupportingLine(drag.pointSources, target, map, reach);
      if (pointSource) {
        const lineIntent: LineFoldIntent = {kind: 'perpendicular-point', source: pointSource, moving: anchor, pin};
        const draft = constrainedDraft(resolveLineFold(lineIntent), anchor, target, map, pointSource.line, lineIntent);
        const source = geometry.creaseReference(pointSource);
        const vertex = geometry.vertexReference(pin);
        return draft && source && vertex
          ? {...draft, capture: {kind: 'perpendicular-through', pin: vertex, source}} : draft;
      }
      if (!nearby) {
        drag.snapKey = undefined;
        issue = {reason: 'Drag toward a visible crease or edge while the pin stays fixed.'};
        return;
      }
      drag.snapKey = nearby.key;
      const fixed = pin;
      const primary = pinnedDraft(nearby.value, anchor, target, map, fixed);
      if (!primary) return;
      const alternatives = choices.slice(1).flatMap(({value}) => {
        if (sameAxis(nearby.value.line, value.line)) return [];
        const draft = pinnedDraft(value, anchor, target, map, fixed);
        return draft ? [draft] : [];
      });
      issue = undefined;
      return alternatives.length ? {...primary, alternatives} : primary;
    }
    const destination = apply(invert(map), target);
    if (tool === 'corner') {
      const fold = cornerFold(anchor, destination, map, drag.minimum);
      if (fold && geometry && snapping) {
        targets ??= geometry.snapPoints();
        const points = pointDrafts(drag, target, map, [...drag.hingeLandings, ...targets], magnet);
        const radius = event.pointerType === 'touch' ? 13 : event.pointerType === 'pen' ? 10 : 8;
        const creases = creasePairs(fold.line, geometry.creasePoints(), map, radius, anchor, target)
          .map(({key, score, solution}) => ({key, score: score * magnet / radius,
            value: {...solution!, tool, anchor, snapped: [], creaseSnapped: true, ...material()}}));
        // A close aim declares a direct landing. At the outer edge of the hit band,
        // compare both constraints and let an already acquired axis hold through jitter.
        const candidates = points.some(({score}) => score <= magnet / 2) && !drag.snapKey?.startsWith('axis/')
          ? points : [...points, ...creases];
        const snapped = previewSnap(candidates, magnet, drag);
        if (snapped) return snapped;
      }
      return fold && {...fold, tool, anchor, destination, snapped: [], capture: {kind: 'freehand'}, ...material()};
    }
    const raw = {a: drag.rawAnchor, b: destination};
    if (distance(raw.a, raw.b) <= EPS) return;
    if (snapping && geometry) {
      const {pairs, singles} = drawnMarkCandidates(raw, geometry.marked, map, magnet);
      const previews = (candidates: typeof pairs) => candidates.map(({key, score, value: line, points}) => ({key, score,
        value: {tool, line, anchor, destination, snapped: points.length === 1 ? points : [], creaseSnapped: points.length === 2,
          snapLabel: points.length === 1 ? 'Drawn crease through mark' : 'Drawn crease through two marks'}}));
      const matchingPair = pairs.some(({score}) => score <= magnet) || drag.snapKey?.startsWith('axis/');
      const draft = (matchingPair && previewSnap(previews(pairs), magnet, drag)) || previewSnap(previews(singles), magnet, drag);
      if (draft) return draft;
      const start = snap(drag.start, map, event) ?? raw.a;
      const end = snap(target, map, event) ?? raw.b;
      if (distance(start, end) > EPS) return {line: {a: start, b: end}, tool, anchor: start, destination: end, snapped: []};
    }
    return {line: raw, tool, anchor: raw.a, destination, snapped: [], capture: {kind: 'freehand'}};
  }

  svg.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || drag || !geometry) return;
    const map = transform();
    if (!map) return;
    const start = client(event);
    const touch = event.pointerType === 'touch';
    const grab = nearestPoint([
      ...geometry.marked, ...geometry.corners, ...(selection ? [selection.corner] : []),
    ], start, map, CORNER_HIT_RADIUS);
    const anchor = tool === 'corner' ? grab ?? (pin && snap(start, map, event)) : undefined;
    const lineGrab = tool === 'corner' && !anchor
      ? nearestLine(geometry.grabLines(), start, map, LINE_GRAB_RADIUS) : undefined;
    const point = apply(invert(map), start);
    const edgePoint = callbacks.snapping() && !event.altKey ? geometry.snapLine(start, map, touch ? 18 : 13)?.point : undefined;
    if (tool === 'corner' && !anchor && !lineGrab && !edgePoint && !geometry.contains(point) &&
        !geometry.markOptions(start, map, touch ? 18 : MARK_HIT_RADIUS).length) return;
    const tapOnly = tool === 'corner' && !anchor && !lineGrab;
    const referencePoint = anchor ?? (tool === 'corner' ? snap(start, map, event) ?? edgePoint : undefined) ?? point;
    const selectedPoint = lineGrab?.point ?? referencePoint;
    if (tool === 'corner' && !tapOnly) chooseCorner(selectedPoint);
    const facetId = selection?.packets[0].facetIds[0];
    const pointSources = tool === 'corner' && pin && anchor && facetId !== undefined
      ? geometry.pointSources(anchor, facetId) : [];
    const {packet: selected, inferFrom} = material();
    const current = state;
    const hingeLandings = tool === 'corner' && current && anchor
      ? (inferFrom ?? (selected ? [selected] : [])).flatMap(packet => {
        const landing = packetHingeLanding(current, packet, anchor);
        return landing ? [landing] : [];
      })
      : [];
    drag = {
      id: event.pointerId, start, anchor: selectedPoint, tapAnchor: referencePoint,
      rawAnchor: point,
      grabOffset: tool === 'corner' && (anchor || lineGrab) ? sub(apply(map, selectedPoint), start) : {x: 0, y: 0},
      minimum: touch ? 8 : 5,
      moved: false,
      tapOnly,
      hingeLandings,
      source: lineGrab?.reference,
      pointSources,
    };
    if (!tapOnly) {
      svg.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
    if (tool === 'corner') {
      held = undefined;
      issue = undefined;
      offeredMarks = [];
      ghost = geometry.markOptions(start, map, snapRadius(event.pointerType), ghost)[0];
      const press = drag;
      press.holdTimer = window.setTimeout(() => {
        if (drag !== press || press.moved) return;
        press.longPress = true;
        chooseCorner(referencePoint);
        const map = transform();
        const same = pin && map && distance(apply(map, pin), apply(map, referencePoint)) <= CORNER_HIT_RADIUS;
        pin = same ? undefined : referencePoint;
        confirmPin = false;
        lastTap = undefined;
        ghost = undefined;
        callbacks.show();
      }, PIN_HOLD);
    }
    if (lineGrab) issue = {source: lineGrab.reference.line, reason: pin
      ? 'Drag along this line to fold it back through the pin.' : 'Drag this line toward another visible edge or crease.'};
    callbacks.show(held, tool === 'corner' ? anchor : undefined, issue);
  });

  svg.addEventListener('pointermove', event => {
    if (drag && event.pointerId !== drag.id) return;
    if (drag && distance(drag.start, client(event)) >= drag.minimum) {
      drag.moved = true;
      ghost = undefined;
      window.clearTimeout(drag.holdTimer);
    }
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (drag) {
        if (drag.longPress) return;
        callbacks.show(projection(event) ?? held, tool === 'corner' && !drag.tapOnly ? drag.anchor : undefined, issue);
      } else if (tool === 'corner' && event.pointerType !== 'touch') {
        const map = transform();
        if (map && geometry) {
          ghost = !held && !offeredMarks.length
            ? geometry.markOptions(client(event), map, snapRadius(event.pointerType), ghost)[0] : undefined;
          callbacks.show(held, nearestPoint(geometry.corners, client(event), map, CORNER_HIT_RADIUS), issue);
        }
      }
    });
  });

  svg.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.longPress) {
      release();
      return;
    }
    const wasTap = !drag.moved && distance(drag.start, client(event)) < drag.minimum;
    const draft = projection(event);
    const anchor = drag.tapAnchor;
    release();
    if (tool === 'corner') {
      if (draft) {
        held = draft;
        callbacks.show(held);
        callbacks.commit(draft);
      } else {
        if (wasTap) {
          chooseCorner(anchor);
          cycle(event.timeStamp);
          const map = transform();
          if (map && geometry) {
            offeredMarks = geometry.markOptions(client(event), map, snapRadius(event.pointerType), ghost);
          }
          ghost = undefined;
        }
        callbacks.show(undefined, undefined, issue);
      }
      return;
    }
    if (draft) {
      held = draft;
    } else if (wasTap && held) {
      const map = transform();
      if (map) {
        const point = apply(invert(map), client(event));
        const offset = signedDistance(held.line, point);
        const pixelScale = Math.hypot(map.a, map.b);
        if (geometry?.contains(point) && Math.abs(offset) * pixelScale >= 5) {
          const alternatives = held.alternatives?.flatMap(option => {
            const side = signedDistance(option.line, point);
            return Math.abs(side) * pixelScale >= 5 ? [{...option, side: side > 0 ? 1 as const : -1 as const, packet: packet()}] : [];
          });
          held = {...held, side: offset > 0 ? 1 : -1, packet: packet(), alternatives};
        }
      }
    }
    callbacks.show(held);
  });

  svg.addEventListener('pointerleave', () => {
    if (drag && (!drag.tapOnly || drag.longPress)) return;
    if (drag) release();
    ghost = undefined;
    cancelAnimationFrame(frame);
    callbacks.show(held, undefined, issue);
  });
  function cancelPointer(event: PointerEvent) {
    if (drag?.id === event.pointerId) {
      if (drag.tapOnly || drag.longPress) release();
      else cancel();
    }
  }
  svg.addEventListener('pointercancel', cancelPointer);
  svg.addEventListener('lostpointercapture', cancelPointer);
  svg.addEventListener('contextmenu', event => {
    if (drag && tool === 'corner') event.preventDefault();
  });
  // Some browsers ignore touch-action on SVG shapes. Suppress scrolling only for a captured gesture.
  svg.addEventListener('touchmove', event => {
    if (drag && (!drag.tapOnly || drag.longPress) && event.cancelable) event.preventDefault();
  }, { passive: false });

  return {
    setContext(next: PaperState | undefined, nextTool: Tool) {
      if (state === next && tool === nextTool) return;
      if (state !== next) {
        geometry = next && paperGeometry(next);
        targets = undefined;
        wholeStack = false;
        explicit = false;
        chooseCorner(undefined);
        packetOptions.clear();
      }
      state = next;
      tool = nextTool;
      svg.dataset.tool = next ? tool : 'none';
      cancel();
    },
    cancel,
    selection: () => selection,
    hasExplicitPacket: () => explicit,
    pinned: () => pin,
    pinNeedsConfirmation: () => confirmPin,
    wholeStack: () => wholeStack,
    togglePin() {
      release();
      pin = pin ? undefined : selection?.corner;
      confirmPin = Boolean(pin);
      held = undefined;
      issue = undefined;
      callbacks.show();
    },
    canConfirm: (draft: Draft) => draft === held,
    packet,
    availableCorners: () => geometry?.corners ?? [],
    markedPoints: () => tool === 'corner' ? geometry?.marked ?? [] : [],
    grabLines: () => tool === 'corner' ? geometry?.grabLines() ?? [] : [],
    markOptions: () => offeredMarks,
    markGhost: () => ghost,
    corners: () => tool === 'corner' ? geometry?.corners ?? [] : [],
    selectCorner(corner: Vec | undefined) {
      release();
      chooseCorner(corner);
      explicit = Boolean(selection) || wholeStack;
      refreshHeld();
    },
    selectCount(count: number | 'all' | undefined) {
      if (typeof count === 'number' && !selection?.packets.some(choice => choice.facetIds.length === count)) return;
      release();
      wholeStack = count === 'all';
      explicit = count !== undefined;
      if (selection) selection = { ...selection, count: count ?? selection.packets[0].facetIds.length };
      lastTap = undefined;
      refreshHeld();
    },
  };
}
