import {
  EPS, add, apply, distance, invert, signedDistance, sub, type Line, type Side, type Vec,
} from '../../vendor/origamio/src/geometry';
import type { PaperState } from '../../vendor/origamio/src/paper';
import { cornerPackets, type MaterialPacket } from '../lab';
import { packetHingeLanding } from '../lab/packets';
import { CORNER_HIT_RADIUS, cornerFold, foldMove, nearestPoint, paperGeometry, paperToScreen } from './geometry';

export type Tool = 'corner' | 'crease';
export interface Draft {
  readonly tool: Tool;
  readonly line: Line;
  readonly side?: Side;
  readonly anchor: Vec;
  readonly destination: Vec;
  readonly snapped: readonly Vec[];
  readonly packet?: MaterialPacket;
}

export function draftMove(draft: Draft) {
  if (draft.side === undefined) return;
  const move = foldMove(draft.line, draft.side, draft.tool === 'corner' ? 'Corner drag' : 'Drawn crease');
  return draft.packet ? { ...move, packet: draft.packet } : move;
}

export interface CornerSelection {
  readonly corner: Vec;
  readonly packets: readonly MaterialPacket[];
  readonly count: number | 'all';
}

const TAP_INTERVAL = 3500; // Milliseconds between deliberate taps. Dragging has no deadline.

interface Drag {
  id: number;
  start: Vec;
  anchor: Vec;
  anchorSnapped: boolean;
  grabOffset: Vec;
  minimum: number;
  moved: boolean;
  hingeLanding?: Vec;
}

const client = (event: PointerEvent): Vec => ({x: event.clientX, y: event.clientY});

export function connectGestures(svg: SVGSVGElement, callbacks: {
  snapping: () => boolean;
  show: (draft?: Draft, hover?: Vec) => void;
  commit: (draft: Draft) => void;
}) {
  let state: PaperState | undefined;
  let tool: Tool = 'corner';
  let geometry: ReturnType<typeof paperGeometry> | undefined;
  let targets: readonly Vec[] | undefined;
  let drag: Drag | undefined;
  let crease: Draft | undefined;
  let frame = 0;
  let selection: CornerSelection | undefined;
  let lastTap: number | undefined;
  const packetOptions = new Map<Vec, readonly MaterialPacket[]>();

  function chooseCorner(corner: Vec | undefined) {
    if (selection?.corner === corner) return;
    const packets = corner && state ? packetOptions.get(corner) ?? cornerPackets(state, corner) : [];
    if (corner) packetOptions.set(corner, packets);
    selection = corner && packets.length ? { corner, packets, count: packets[0].facetIds.length } : undefined;
    lastTap = undefined;
  }

  function packet() {
    return selection?.packets.find(choice => choice.facetIds.length === selection?.count);
  }

  function cycle(time: number) {
    if (!selection) return;
    const current = selection.packets.findIndex(choice => choice.facetIds.length === selection?.count);
    const next = lastTap !== undefined && time - lastTap <= TAP_INTERVAL
      ? (current + 1) % selection.packets.length : 0;
    selection = { ...selection, count: selection.packets[next].facetIds.length };
    lastTap = time;
  }

  function refreshCrease() {
    if (crease) crease = { ...crease, packet: packet() };
    callbacks.show(crease);
  }

  function transform() {
    const screen = svg.getScreenCTM();
    if (state && screen && Math.abs(screen.a * screen.d - screen.b * screen.c) > EPS) {
      return paperToScreen(screen, state.size);
    }
  }

  function snap(point: Vec, map: NonNullable<ReturnType<typeof transform>>, event: PointerEvent, hingeLanding?: Vec) {
    if (!geometry || !callbacks.snapping() || event.altKey) return;
    targets ??= geometry.snapPoints();
    return nearestPoint(hingeLanding ? [hingeLanding, ...targets] : targets, point, map, event.pointerType === 'touch' ? 18 : 13);
  }

  function release() {
    cancelAnimationFrame(frame);
    frame = 0;
    const id = drag?.id;
    drag = undefined;
    if (id !== undefined && svg.hasPointerCapture(id)) svg.releasePointerCapture(id);
  }

  function cancel() {
    release();
    crease = undefined;
    callbacks.show();
  }

  function projection(event: PointerEvent): Draft | undefined {
    const map = transform();
    if (!drag || !map || distance(drag.start, client(event)) < drag.minimum) return;
    const target = add(client(event), drag.grabOffset);
    const snapped = snap(target, map, event, drag.hingeLanding);
    const destination = snapped ?? apply(invert(map), target);
    const {anchor} = drag;
    const marks = [...(drag.anchorSnapped ? [anchor] : []), ...(snapped ? [snapped] : [])];
    if (tool === 'corner') {
      const fold = cornerFold(anchor, destination, map, drag.minimum);
      return fold && { ...fold, tool, anchor, destination, snapped: marks, packet: packet() };
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
    const anchor = tool === 'corner'
      ? nearestPoint(geometry.corners, start, map, CORNER_HIT_RADIUS)
      : snap(start, map, event);
    if (tool === 'corner' && !anchor) return;
    if (tool === 'corner') chooseCorner(anchor);
    const selected = packet();
    drag = {
      id: event.pointerId, start, anchor: anchor ?? apply(invert(map), start),
      anchorSnapped: tool === 'crease' && anchor !== undefined,
      grabOffset: tool === 'corner' && anchor ? sub(apply(map, anchor), start) : {x: 0, y: 0},
      minimum: touch ? 8 : 5,
      moved: false,
      hingeLanding: tool === 'corner' && state && selected && anchor ? packetHingeLanding(state, selected, anchor) : undefined,
    };
    svg.setPointerCapture(event.pointerId);
    event.preventDefault();
    callbacks.show(crease, tool === 'corner' ? anchor : undefined);
  });

  svg.addEventListener('pointermove', event => {
    if (drag && event.pointerId !== drag.id) return;
    if (drag && distance(drag.start, client(event)) >= drag.minimum) drag.moved = true;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (drag) {
        callbacks.show(projection(event) ?? crease, tool === 'corner' ? drag.anchor : undefined);
      } else if (tool === 'corner' && event.pointerType !== 'touch') {
        const map = transform();
        if (map && geometry) callbacks.show(undefined, nearestPoint(geometry.corners, client(event), map, CORNER_HIT_RADIUS));
      }
    });
  });

  svg.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const wasTap = !drag.moved && distance(drag.start, client(event)) < drag.minimum;
    const draft = projection(event);
    release();
    if (tool === 'corner') {
      if (draft) callbacks.commit(draft);
      else {
        if (wasTap) cycle(event.timeStamp);
        callbacks.show();
      }
      return;
    }
    if (draft) {
      crease = draft;
    } else if (wasTap && crease) {
      const map = transform();
      if (map) {
        const point = apply(invert(map), client(event));
        const offset = signedDistance(crease.line, point);
        const pixelScale = Math.hypot(map.a, map.b);
        if (geometry?.contains(point) && Math.abs(offset) * pixelScale >= 5) {
          crease = { ...crease, side: offset > 0 ? 1 : -1, packet: packet() };
        }
      }
    }
    callbacks.show(crease);
  });

  svg.addEventListener('pointerleave', () => {
    if (drag) return;
    cancelAnimationFrame(frame);
    callbacks.show(crease);
  });
  function cancelPointer(event: PointerEvent) {
    if (drag?.id === event.pointerId) cancel();
  }
  svg.addEventListener('pointercancel', cancelPointer);
  svg.addEventListener('lostpointercapture', cancelPointer);
  // Some browsers ignore touch-action on SVG shapes. Suppress scrolling only for a captured gesture.
  svg.addEventListener('touchmove', event => {
    if (drag && event.cancelable) event.preventDefault();
  }, { passive: false });

  return {
    setContext(next: PaperState | undefined, nextTool: Tool) {
      if (state === next && tool === nextTool) return;
      if (state !== next) {
        geometry = next && paperGeometry(next);
        targets = undefined;
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
    packet,
    availableCorners: () => geometry?.corners ?? [],
    corners: () => tool === 'corner' ? geometry?.corners ?? [] : [],
    selectCorner(corner: Vec | undefined) {
      release();
      chooseCorner(corner);
      refreshCrease();
    },
    selectCount(count: number | 'all') {
      if (!selection || (count !== 'all' && !selection.packets.some(choice => choice.facetIds.length === count))) return;
      release();
      selection = { ...selection, count };
      lastTap = undefined;
      refreshCrease();
    },
  };
}
