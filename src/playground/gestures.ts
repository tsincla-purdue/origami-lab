import {
  EPS, add, apply, distance, dot, invert, signedDistance, sub, type Line, type Mat, type Side, type Vec,
} from '../../vendor/origamio/src/geometry';
import {
  cornerPackets, resolveLineFold, solvePointOntoLine,
  type ConstraintResult, type ConstraintSolution, type LineFoldIntent, type LineReference, type MaterialPacket, type PaperState,
} from '../lab';
import { packetHingeLanding } from '../lab/packets';
import { snapCrease } from './crease-snap';
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
    : draft.constraint ? 'Point onto line' : draft.creaseSnapped ? 'Crease through two points'
    : draft.tool === 'corner' ? 'Point drag' : 'Drawn crease';
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
  anchorSnapped: boolean;
  grabOffset: Vec;
  minimum: number;
  moved: boolean;
  tapOnly: boolean;
  hingeLandings: readonly Vec[];
  source?: LineReference;
  pointSources: readonly LineReference[];
  creaseSnap?: Line;
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
    return nearestPoint(hingeLandings.length ? [...hingeLandings, ...targets] : targets, point, map, event.pointerType === 'touch' ? 18 : 13);
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

  function projection(event: PointerEvent): Draft | undefined {
    const map = transform();
    if (!drag || drag.tapOnly || drag.longPress || !map || distance(drag.start, client(event)) < drag.minimum) return;
    const target = add(client(event), drag.grabOffset);
    const {anchor} = drag;
    issue = undefined;
    const radius = event.pointerType === 'touch' ? 24 : 17;
    const source = drag.source;
    const sameLine = source && nearestLine([source], target, map, radius);
    if (source && geometry && (!pin || sameLine)) {
      const hit = pin ? sameLine : nearestLine(geometry.grabLines(), target, map, radius);
      if (!hit) {
        issue = {source: source.line, reason: 'Drag toward a visible edge or crease to align the lines.'};
        return;
      }
      const lineIntent: LineFoldIntent = pin
        ? {kind: 'perpendicular', source, moving: anchor, pin}
        : {kind: 'align-lines', source, moving: anchor, target: hit.reference};
      return constrainedDraft(resolveLineFold(lineIntent), anchor, target, map, hit.reference.line, lineIntent);
    }
    if (tool === 'corner' && pin && geometry) {
      const nearby = geometry.snapLine(target, map, radius);
      // At a junction, favor the grabbed line on a tie. A closer distinct target still uses O5.
      const reach = nearby ? Math.min(radius, distance(target, apply(map, nearby.point)) + 1) : radius;
      const pointSource = nearestSupportingLine(drag.pointSources, target, map, reach);
      if (pointSource) {
        const lineIntent: LineFoldIntent = {kind: 'perpendicular-point', source: pointSource, moving: anchor, pin};
        return constrainedDraft(resolveLineFold(lineIntent), anchor, target, map, pointSource.line, lineIntent);
      }
      if (!nearby) {
        issue = {reason: 'Drag toward a visible crease or edge while the pin stays fixed.'};
        return;
      }
      return constrainedDraft(solvePointOntoLine(pin, anchor, nearby.line, true), anchor, target, map, nearby.line);
    }
    const snapped = snap(target, map, event, drag.hingeLandings);
    const destination = snapped ?? apply(invert(map), target);
    const marks = [...(drag.anchorSnapped ? [anchor] : []), ...(snapped ? [snapped] : [])];
    if (tool === 'corner') {
      const fold = cornerFold(anchor, destination, map, drag.minimum);
      if (fold && !snapped && geometry && callbacks.snapping() && !event.altKey) {
        const radius = event.pointerType === 'touch' ? 13 : event.pointerType === 'pen' ? 10 : 8;
        const solution = snapCrease(fold.line, anchor, destination, geometry.creasePoints(), map, radius, drag.creaseSnap);
        if (solution) {
          drag.creaseSnap = solution.line;
          return {...solution, tool, anchor, snapped: [], creaseSnapped: true, ...material()};
        }
      }
      drag.creaseSnap = undefined;
      return fold && { ...fold, tool, anchor, destination, snapped: marks, ...material() };
    }
    if (distance(anchor, destination) <= EPS ||
        distance(apply(map, anchor), apply(map, destination)) < drag.minimum) return;
    return { line: {a: anchor, b: destination}, tool, anchor, destination, snapped: marks };
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
    const anchor = tool === 'corner' ? grab ?? (pin && snap(start, map, event)) : snap(start, map, event);
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
      anchorSnapped: tool === 'crease' && anchor !== undefined,
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
        if (map && geometry) callbacks.show(held, nearestPoint(geometry.corners, client(event), map, CORNER_HIT_RADIUS), issue);
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
            offeredMarks = geometry.markOptions(client(event), map, event.pointerType === 'touch' ? 18 : MARK_HIT_RADIUS);
          }
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
          held = { ...held, side: offset > 0 ? 1 : -1, packet: packet() };
        }
      }
    }
    callbacks.show(held);
  });

  svg.addEventListener('pointerleave', () => {
    if (drag && (!drag.tapOnly || drag.longPress)) return;
    if (drag) release();
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
