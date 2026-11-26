import { EPS } from '../../vendor/origamio/src/geometry';
import type { PaperState } from '../lab/engine';
import { paperToScreen } from './geometry';
import { createGestureInterpreter, type GestureCallbacks, type Tool } from './gestures';

const PIN_HOLD = 550;
const input = (event: PointerEvent) => ({
  point: {x: event.clientX, y: event.clientY}, id: event.pointerId,
  time: event.timeStamp, pointerType: event.pointerType, altKey: event.altKey,
});

/** Browser scheduling and pointer capture. Geometry and gesture state live in the interpreter. */
export function connectGestures(svg: SVGSVGElement, callbacks: GestureCallbacks) {
  let state: PaperState | undefined;
  let tool: Tool = 'corner';
  let frame = 0;
  let holdTimer: number | undefined;
  function clearFrame() {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  const interpreter = createGestureInterpreter({
    ...callbacks,
    transform() {
      const screen = svg.getScreenCTM();
      if (state && screen && Math.abs(screen.a * screen.d - screen.b * screen.c) > EPS) {
        return paperToScreen(screen, state.size);
      }
    },
    ended(id) {
      clearFrame();
      window.clearTimeout(holdTimer);
      if (svg.hasPointerCapture(id)) svg.releasePointerCapture(id);
    },
  });

  svg.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const press = interpreter.press(input(event));
    if (!press) return;
    if (!press.tapOnly) {
      svg.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
    if (tool === 'corner') holdTimer = window.setTimeout(interpreter.hold, PIN_HOLD);
  });

  svg.addEventListener('pointermove', event => {
    const drag = interpreter.tracking();
    if (drag && drag.id !== event.pointerId) return;
    const sample = input(event);
    if (interpreter.noticeMovement(sample)) window.clearTimeout(holdTimer);
    clearFrame();
    frame = requestAnimationFrame(() => {
      frame = 0;
      interpreter.move(sample);
    });
  });

  svg.addEventListener('pointerup', event => interpreter.finish(input(event)));
  svg.addEventListener('pointerleave', () => {
    const drag = interpreter.tracking();
    if (drag && (!drag.tapOnly || drag.longPress)) return;
    clearFrame();
    interpreter.leave();
  });
  const cancelPointer = (event: PointerEvent) => interpreter.cancelPointer(event.pointerId);
  svg.addEventListener('pointercancel', cancelPointer);
  svg.addEventListener('lostpointercapture', cancelPointer);
  svg.addEventListener('contextmenu', event => {
    if (interpreter.tracking() && tool === 'corner') event.preventDefault();
  });
  // Some browsers ignore touch-action on SVG shapes. Suppress scrolling only for a captured gesture.
  svg.addEventListener('touchmove', event => {
    const drag = interpreter.tracking();
    if (drag && (!drag.tapOnly || drag.longPress) && event.cancelable) event.preventDefault();
  }, {passive: false});

  return {
    ...interpreter,
    cancel() {
      clearFrame();
      interpreter.cancel();
    },
    setContext(next: PaperState | undefined, nextTool: Tool) {
      if (state !== next || tool !== nextTool) clearFrame();
      state = next;
      tool = nextTool;
      svg.dataset.tool = next ? tool : 'none';
      interpreter.setContext(next, nextTool);
    },
  };
}
