import { distance, lerp, scale, type Mat, type Vec } from '../../vendor/origamio/src/geometry';
import { createGestureInterpreter, type ConstraintIssue, type Draft } from '../playground/gestures';
import type { Landmark, SurfaceContact } from '../playground/geometry';
import { commitInterpretation, interpretGesture, uniqueAccepted } from '../playground/intent';
import type { Validation } from './engine';
import {
  activeFoldAttempts, canFlip, canUnfold, openingMotions, recordFlip, recordMark, recordUnfold, type Experiment,
} from './experiment';
import { paperInView } from './paper-pose';
import { realizeMarkedPerpendicular } from './proof-geometry';

export type TactileContact = SurfaceContact;
export type TactileSnap = 'point' | 'line' | 'axis' | 'opening';
export type TactileEvent =
  | {readonly kind: 'contact'; readonly motor: Vec; readonly contact: TactileContact}
  | {readonly kind: 'contact-lost' | 'snap-lost'; readonly motor: Vec}
  | {readonly kind: 'snap-acquired'; readonly motor: Vec; readonly constraint: TactileSnap}
  | {readonly kind: 'resistance'; readonly motor: Vec; readonly validation: Validation};

export interface TactileFeedback {
  /** The probe or gripper position supplied by the controller, never a target position. */
  readonly motor: Vec;
  readonly proximity: number;
  readonly contact?: TactileContact;
  readonly landmark?: Landmark;
  readonly snapped: boolean;
  readonly events: readonly TactileEvent[];
  readonly validation?: Validation;
}

export interface TactileHand {
  beginDrag(at: Vec): TactileFeedback;
  beginTrace(at: Vec): TactileFeedback;
  move(to: Vec): TactileFeedback;
  release(): TactileFeedback;
  mark(): TactileFeedback;
  flip(): TactileFeedback;
  unfold(): TactileFeedback;
}

export type TactileCommand =
  | {readonly kind: 'drag' | 'trace' | 'move'; readonly at: Vec}
  | {readonly kind: 'release' | 'mark' | 'flip' | 'unfold'};

export interface TactileTrajectory {
  readonly version: 1 | 2;
  readonly pixelsPerUnit: number;
  readonly entries: readonly {readonly command: TactileCommand; readonly feedback: TactileFeedback}[];
  readonly truncated: boolean;
}

export interface TactileOptions {
  readonly sensoryVersion?: TactileTrajectory['version'];
  /** Similarity transform used for the shared screen-space gesture thresholds. */
  readonly pixelsPerUnit?: number;
  /** Retain this many commands in a separate replayable log, up to 2048. Defaults to zero. */
  readonly trajectoryLimit?: number;
}

type SurfaceSample = NonNullable<ReturnType<ReturnType<typeof createGestureInterpreter>['surfaceAt']>>;
const CONTACT_PIXELS = 3;
const WARM_PIXELS = 12;
const STEP_PIXELS = 2;
const MAX_MOVE_PIXELS = 4096;
const MAX_LOG_ENTRIES = 2048;
const MAX_LOG_EVENTS = 4096;
const rejected = (code: string, reason: string): Validation => ({status: 'rejected', code, reason});
const unverified = (code: string, reason: string): Validation => ({status: 'unverified', code, reason});
const historyFull = () => unverified('history-limit', 'The experiment has reached its history limit.');

function run(hand: TactileHand, command: TactileCommand): TactileFeedback {
  switch (command.kind) {
    case 'drag': return hand.beginDrag(command.at);
    case 'trace': return hand.beginTrace(command.at);
    case 'move': return hand.move(command.at);
    case 'release': return hand.release();
    case 'mark': return hand.mark();
    case 'flip': return hand.flip();
    case 'unfold': return hand.unfold();
  }
}

/** Give the controller only `hand`. The host owns the experiment and diagnostic log. */
export function createTactileSession(initial: Experiment, options: TactileOptions = {}) {
  let experiment = initial;
  const version = options.sensoryVersion ?? 2;
  if (version !== 1 && version !== 2) throw new Error('Unsupported tactile sensory version.');
  const pixelsPerUnit = options.pixelsPerUnit ?? 400;
  const logLimit = options.trajectoryLimit ?? 0;
  if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit < 32 || pixelsPerUnit > 4096) {
    throw new RangeError('Virtual pixels per sheet unit must be between 32 and 4096.');
  }
  if (!Number.isInteger(logLimit) || logLimit < 0 || logLimit > MAX_LOG_ENTRIES) {
    throw new RangeError('Invalid tactile trajectory limit.');
  }
  const transform: Mat = {a: pixelsPerUnit, b: 0, c: 0, d: pixelsPerUnit, e: 0, f: 0};
  let position: Vec = {x: 0, y: 0};
  let mode: 'drag' | 'trace' | undefined;
  let surface: SurfaceSample = {proximity: 0};
  let lock: string | undefined;
  let draft: Draft | undefined;
  let issue: ConstraintIssue | undefined;
  let verdict: Validation | undefined;
  let events: TactileEvent[] = [];
  const entries: TactileTrajectory['entries'][number][] = [];
  let truncated = false;
  let loggedEvents = 0;

  const gestures = createGestureInterpreter({
    transform: () => transform,
    exposedOnly: true,
    snapping: () => true,
    openingMotions: () => openingMotions(experiment),
    show(next, _, problem) {
      draft = next;
      issue = problem;
    },
    commit(next) {
      const interpretations = interpretGesture(experiment, next);
      const proposal = uniqueAccepted(next, interpretations);
      if (proposal && canFlip(experiment)) {
        experiment = commitInterpretation(experiment, proposal);
        verdict = experiment.attempts.at(-1)!.validation;
      } else {
        verdict = proposal ? historyFull() : draftVerdict(interpretations[0]?.result.validation);
      }
    },
    markedPerpendicular: (...refs) => realizeMarkedPerpendicular(experiment, ...refs),
  });
  syncPaper();

  function draftVerdict(validation: Validation | undefined): Validation {
    if (validation?.status === 'accepted') {
      return unverified('competing-interpretations', 'The gesture has competing interpretations. Move to resolve the choice before release.');
    }
    return validation ?? (issue?.status === 'rejected'
      ? rejected('unsolved-gesture', issue.reason)
      : unverified('unsolved-gesture', issue?.reason ?? 'No fold or opening was proposed by this movement.'));
  }

  function syncPaper() {
    gestures.setContext(paperInView(experiment.final), 'corner');
  }

  function input(at: Vec) {
    return {point: scale(at, pixelsPerUnit), pointerType: 'mouse', id: 1, time: 0};
  }

  function trace(at: Vec) {
    const next = gestures.surfaceAt(at, WARM_PIXELS / pixelsPerUnit, CONTACT_PIXELS / pixelsPerUnit, version) ?? {proximity: 0};
    if (next.key !== surface.key) {
      if (next.contact) events.push({kind: 'contact', motor: at, contact: next.contact});
      else if (surface.contact) events.push({kind: 'contact-lost', motor: at});
    }
    surface = next;
  }

  function resistance(validation: Validation, at = position) {
    events.push({kind: 'resistance', motor: at, validation});
  }

  function drag(at: Vec, last: boolean) {
    const sample = input(at);
    gestures.noticeMovement(sample);
    gestures.move(sample);
    const next = gestures.snapObservation().key;
    if (lock !== next) {
      if (lock) events.push({kind: 'snap-lost', motor: at});
      if (next) {
        const constraint = next.startsWith('opening/') ? 'opening'
          : next.startsWith('point/') ? 'point' : next.startsWith('line/') ? 'line' : 'axis';
        events.push({kind: 'snap-acquired', motor: at, constraint});
      }
      lock = next;
      if (next && !last && draft) {
        const result = interpretGesture(experiment, draft)[0]?.result.validation;
        if (result && result.status !== 'accepted') resistance(result, at);
      }
    }
    if (last && draft) {
      const options = interpretGesture(experiment, draft);
      if (!uniqueAccepted(draft, options)) verdict = draftVerdict(options[0]?.result.validation);
    } else if (last && issue?.status) verdict = draftVerdict(undefined);
  }

  function end() {
    if (lock) events.push({kind: 'snap-lost', motor: position});
    if (surface.contact) events.push({kind: 'contact-lost', motor: position});
    lock = undefined;
    surface = {proximity: 0};
    mode = undefined;
    gestures.cancel();
  }

  function checkPosition(at: Vec) {
    if (!Number.isFinite(at?.x * pixelsPerUnit) || !Number.isFinite(at?.y * pixelsPerUnit)) {
      throw new RangeError('A motor position must be finite.');
    }
  }

  function command(action: TactileCommand): TactileFeedback {
    events = [];
    verdict = undefined;
    switch (action.kind) {
      case 'drag':
      case 'trace':
        checkPosition(action.at);
        end();
        position = action.at;
        if (action.kind === 'trace') {
          mode = 'trace';
          trace(position);
        } else if (gestures.press(input(position))) mode = 'drag';
        else verdict = rejected('no-grab', 'There is no accessible grab here.');
        break;
      case 'move': {
        checkPosition(action.at);
        const pixels = distance(position, action.at) * pixelsPerUnit;
        if (mode && pixels > MAX_MOVE_PIXELS) throw new RangeError('Divide this motion into shorter moves.');
        const steps = Math.max(1, Math.ceil(pixels / STEP_PIXELS));
        if (mode) for (let i = 1; i <= steps; i++) {
          const at = i === steps ? action.at : lerp(position, action.at, i / steps);
          if (mode === 'trace') trace(at);
          else drag(at, i === steps);
        }
        position = action.at;
        break;
      }
      case 'release':
        if (mode === 'drag') {
          gestures.finish(input(position));
          verdict ??= draftVerdict(undefined);
          if (verdict.status === 'accepted') syncPaper();
        }
        end();
        break;
      case 'mark': {
        const point = mode === 'trace' ? surface.intersection : undefined;
        if (!point) verdict = rejected('no-intersection', 'Trace an accessible intersection before marking.');
        else if (surface.contact === 'mark') verdict = rejected('already-marked', 'This material point is already marked.');
        else if (!canFlip(experiment)) verdict = historyFull();
        else {
          try {
            experiment = recordMark(experiment, point.point, point.sources);
            verdict = experiment.attempts.at(-1)!.validation;
            syncPaper();
            trace(position);
          } catch {
            verdict = unverified('mark-unverified', 'The contacted intersection could not be verified for marking.');
          }
        }
        break;
      }
      case 'flip':
        end();
        if (!canFlip(experiment)) verdict = historyFull();
        else {
          experiment = recordFlip(experiment);
          verdict = experiment.attempts.at(-1)!.validation;
          syncPaper();
        }
        break;
      case 'unfold':
        end();
        if (!canFlip(experiment)) verdict = historyFull();
        else if (canUnfold(experiment)) {
          experiment = recordUnfold(experiment);
          verdict = experiment.attempts.at(-1)!.validation;
          syncPaper();
        } else if (activeFoldAttempts(experiment).length) {
          verdict = unverified('unfold-unverified', 'The latest active fold could not be verified for reversal.');
        } else {
          verdict = rejected('no-active-fold', 'There is no active fold to unfold.');
        }
        break;
    }
    if (verdict && verdict.status !== 'accepted') resistance(verdict);
    const feedback = {motor: position, proximity: mode === 'trace' ? surface.proximity : gestures.snapObservation().proximity,
      ...(surface.landmark && {landmark: surface.landmark}), contact: surface.contact, snapped: lock !== undefined, events, validation: verdict};
    if (logLimit && !truncated) {
      if (entries.length >= logLimit || loggedEvents + events.length > MAX_LOG_EVENTS) truncated = true;
      else {
        entries.push(structuredClone({command: action, feedback}));
        loggedEvents += events.length;
      }
    }
    // The controller must not be able to mutate the motor position or feedback retained by the session.
    return structuredClone(feedback);
  }

  const hand: TactileHand = {
    beginDrag: at => command({kind: 'drag', at: {x: at.x, y: at.y}}),
    beginTrace: at => command({kind: 'trace', at: {x: at.x, y: at.y}}),
    move: at => command({kind: 'move', at: {x: at.x, y: at.y}}),
    release: () => command({kind: 'release'}),
    mark: () => command({kind: 'mark'}),
    flip: () => command({kind: 'flip'}),
    unfold: () => command({kind: 'unfold'}),
  };
  return {
    hand,
    experiment: () => experiment,
    trajectory: (): TactileTrajectory | undefined => logLimit
      ? structuredClone({version, pixelsPerUnit, entries, truncated})
      : undefined,
  };
}

/** Replay motor inputs from a log's starting experiment. Saved sensations are never authoritative. */
export function replayTactileTrajectory(initial: Experiment, trajectory: TactileTrajectory) {
  if ((trajectory.version !== 1 && trajectory.version !== 2) || trajectory.entries.length > MAX_LOG_ENTRIES) {
    throw new Error('Unsupported tactile trajectory.');
  }
  const session = createTactileSession(initial, {pixelsPerUnit: trajectory.pixelsPerUnit, sensoryVersion: trajectory.version});
  const feedback = trajectory.entries.map(({command}) => run(session.hand, command));
  return {experiment: session.experiment(), feedback};
}
