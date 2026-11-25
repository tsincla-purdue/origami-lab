import { EPS, distance, type Vec } from '../../vendor/origamio/src/geometry';
import {
  ENGINE_REVISION, NUMERICS, apply, canReverseFold, deepFreeze, initialState, reverseFold, turnPaper,
  withMaterialMarks, type Move, type PaperState, type Validation,
} from './engine';
import { materialIntersections } from './material-points';
import { DEFAULT_PAPER_STYLE, isPaperStyle, type PaperStyle } from './paper-style';
import { inspectGeometry, type CapturedGeometry, type GeometryCheckOptions, type GeometryReport } from './proof-geometry';

export type Attempt = {
  readonly validation: Validation;
  readonly state: PaperState;
} & ({
  readonly operation?: never;
  readonly move: Move;
  /** Preserve a historical clearance decision while later attempts use the current validator. */
  readonly validatorVersion?: 1;
} | {
  readonly operation: 'unfold';
  readonly move: { readonly foldAttempt: number; readonly label: 'Unfold' };
  readonly validatorVersion?: never;
} | {
  readonly operation: 'flip';
  readonly move: { readonly axisX: number; readonly label: 'Flip over' };
  readonly validatorVersion?: never;
} | {
  readonly operation: 'mark';
  readonly move: { readonly point: Vec; readonly label: 'Mark point' };
  readonly validatorVersion?: never;
} | {
  readonly operation: 'remove-mark';
  readonly move: { readonly markAttempt: number; readonly label: 'Remove mark' };
  readonly validatorVersion?: never;
});

export interface Experiment {
  readonly format: 'origami-lab';
  readonly version: 1;
  readonly engine: { readonly name: 'Origamio'; readonly revision: string };
  readonly numerics: typeof NUMERICS;
  readonly appearance: { readonly paperStyle: PaperStyle };
  readonly initial: PaperState;
  readonly attempts: readonly Attempt[];
  readonly final: PaperState;
}

const MAX_ATTEMPTS = 256;
export const MAX_EXPERIMENT_LENGTH = 32_000_000;

export function createExperiment(paperStyle: PaperStyle = DEFAULT_PAPER_STYLE): Experiment {
  const state = initialState();
  return deepFreeze({
    format: 'origami-lab',
    version: 1,
    engine: { name: 'Origamio', revision: ENGINE_REVISION },
    numerics: NUMERICS,
    appearance: { paperStyle },
    initial: state,
    attempts: [],
    final: state,
  });
}

export function setPaperStyle(experiment: Experiment, paperStyle: PaperStyle): Experiment {
  return deepFreeze({ ...experiment, appearance: { paperStyle } });
}

/** Record an attempted action. Only an accepted action changes the paper. */
export function recordMove(experiment: Experiment, move: Move): Experiment {
  const next = appendMove(experiment, move);
  if (move.geometry !== undefined) requireGeometry(inspectGeometry(next).at(-1)!, next.attempts.length);
  return next;
}

/** Record what the gesture selected independently of the proof result. */
export function recordGestureMove(experiment: Experiment, move: Move, capture: CapturedGeometry | undefined): Experiment {
  if (!capture) return recordMove(experiment, move);
  const geometry = capture.kind === 'freehand' ? {version: 1 as const, ...capture}
    : {version: 1 as const, ...capture, projection: {axis: move.line, side: move.side}};
  return appendMove(experiment, {...move, geometry});
}

function requireGeometry(report: GeometryReport, attempt: number) {
  if (report.status === 'invalid') {
    throw new Error(`Geometric evidence at attempt ${attempt}: ${report.detail}`);
  }
}

function requireHistorySpace(experiment: Experiment) {
  if (experiment.attempts.length >= MAX_ATTEMPTS) {
    throw new Error(`An experiment can contain up to ${MAX_ATTEMPTS} attempts.`);
  }
}

function appendMove(experiment: Experiment, move: Move, validatorVersion?: 1): Experiment {
  requireHistorySpace(experiment);
  const snapshot = deepFreeze(JSON.parse(JSON.stringify(move)) as Move);
  const result = apply(experiment.final, snapshot, validatorVersion);
  const retainsClearance = validatorVersion === 1 && result.validation.code === 'hinge-cover';
  const attempt: Attempt = { move: snapshot, ...result, ...(retainsClearance && {validatorVersion}) };
  return appendAttempt(experiment, attempt);
}

function appendAttempt(experiment: Experiment, attempt: Attempt): Experiment {
  return deepFreeze({ ...experiment, attempts: [...experiment.attempts, attempt], final: attempt.state });
}

/** Stable, one-based attempt IDs of the currently active folds, earliest first. */
export function activeFoldAttempts(experiment: Experiment): readonly number[] {
  const active: number[] = [];
  for (const [index, attempt] of experiment.attempts.entries()) {
    if (attempt.validation.status !== 'accepted') continue;
    if (!attempt.operation) active.push(index + 1);
    else if (attempt.operation === 'unfold' && active.at(-1) === attempt.move.foldAttempt) active.pop();
  }
  return active;
}

function unfoldSource(experiment: Experiment) {
  const foldAttempt = activeFoldAttempts(experiment).at(-1);
  if (foldAttempt === undefined) return;
  const source = stateAt(experiment, foldAttempt - 1);
  const folded = stateAt(experiment, foldAttempt);
  if (canReverseFold(experiment.final, source, folded)) return {foldAttempt, source, folded};
}

export function canUnfold(experiment: Experiment): boolean {
  return experiment.attempts.length < MAX_ATTEMPTS && unfoldSource(experiment) !== undefined;
}

export function recordUnfold(experiment: Experiment): Experiment {
  requireHistorySpace(experiment);
  const plan = unfoldSource(experiment);
  const state = plan && reverseFold(experiment.final, plan.source, plan.folded);
  if (!state || !plan) throw new Error('The latest state is not the result of a reversible fold.');
  return appendAttempt(experiment, {
    operation: 'unfold', move: { foldAttempt: plan.foldAttempt, label: 'Unfold' }, state,
    validation: { status: 'accepted', code: 'unfold', reason: 'Reversed the last fold and retained its material creases.' },
  });
}

export function canFlip(experiment: Experiment): boolean {
  return experiment.attempts.length < MAX_ATTEMPTS;
}

export function recordFlip(experiment: Experiment): Experiment {
  requireHistorySpace(experiment);
  const {state, axisX} = turnPaper(experiment.final);
  return appendAttempt(experiment, {
    operation: 'flip', move: {axisX, label: 'Flip over'}, state,
    validation: {status: 'accepted', code: 'flip', reason: 'Turned the entire sheet over around its vertical center.'},
  });
}

export function recordMark(experiment: Experiment, point: Vec): Experiment {
  requireHistorySpace(experiment);
  const current = experiment.final;
  const [exact] = materialIntersections(current, point, EPS);
  if (!exact) throw new Error('Choose a crease intersection on the original sheet.');
  const marks = current.marks ?? [];
  if (marks.some(({point}) => distance(point, exact) <= EPS)) {
    throw new Error('This material point is already marked.');
  }
  const state = withMaterialMarks(current, [...marks, {id: experiment.attempts.length + 1, point: exact}]);
  return appendAttempt(experiment, {
    operation: 'mark', move: {point: exact, label: 'Mark point'}, state,
    validation: {status: 'accepted', code: 'mark-point', reason: 'Marked an exact intersection on the material sheet.'},
  });
}

export function recordRemoveMark(experiment: Experiment, markAttempt: number): Experiment {
  requireHistorySpace(experiment);
  const current = experiment.final;
  const marks = current.marks ?? [];
  const remaining = marks.filter(({id}) => id !== markAttempt);
  if (remaining.length === marks.length) throw new Error('Choose an existing mark to remove.');
  return appendAttempt(experiment, {
    operation: 'remove-mark', move: {markAttempt, label: 'Remove mark'}, state: withMaterialMarks(current, remaining),
    validation: {status: 'accepted', code: 'remove-mark', reason: 'Removed the selected material mark.'},
  });
}

export function undoMove(experiment: Experiment): Experiment {
  if (!experiment.attempts.length) return experiment;
  const attempts = experiment.attempts.slice(0, -1);
  return deepFreeze({ ...experiment, attempts, final: stateAt(experiment, attempts.length) });
}

export function stateAt(experiment: Experiment, cursor: number): PaperState {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > experiment.attempts.length) {
    throw new RangeError('History position is out of range.');
  }
  return cursor === 0 ? experiment.initial : experiment.attempts[cursor - 1].state;
}

export function serializeExperiment(experiment: Experiment): string {
  return JSON.stringify(experiment, null, 2);
}

/** Compare supplied JSON to known data, independent of object key order. */
function matches(expected: unknown, supplied: unknown): boolean {
  if (expected === supplied) return true;
  if (Array.isArray(expected)) {
    return Array.isArray(supplied) && expected.length === supplied.length &&
      expected.every((value, i) => matches(value, supplied[i]));
  }
  if (!expected || typeof expected !== 'object' || !supplied ||
      typeof supplied !== 'object' || Array.isArray(supplied)) return false;
  const entries = Object.entries(expected);
  const object = supplied as Record<string, unknown>;
  return entries.length === Object.keys(object).length &&
    entries.every(([key, value]) => Object.hasOwn(object, key) && matches(value, object[key]));
}

/** Replay and verify every attempt. Saved snapshots are assertions, never input to the engine. */
export function importExperiment(text: string, proofOptions?: GeometryCheckOptions): Experiment {
  if (text.length > MAX_EXPERIMENT_LENGTH) throw new Error('The experiment file is too large.');
  const file = JSON.parse(text) as Partial<Experiment> | null;
  if (!file || file.format !== 'origami-lab' || file.version !== 1) {
    throw new Error('Expected an Origami Lab v1 experiment.');
  }
  const paperStyle = file.appearance === undefined ? DEFAULT_PAPER_STYLE : file.appearance?.paperStyle;
  if (!isPaperStyle(paperStyle)) throw new Error('Unknown paper style.');
  let replay = createExperiment(paperStyle);
  const legacy = matches({ ...NUMERICS, validatorVersion: 1 }, file.numerics);
  if (!matches(replay.engine, file.engine) || (!legacy && !matches(replay.numerics, file.numerics))) {
    throw new Error('The engine revision or numerical policy differs from this build.');
  }
  if (!matches(replay.initial, file.initial) || !Array.isArray(file.attempts) ||
      file.attempts.length > MAX_ATTEMPTS) {
    throw new Error('Invalid initial state or attempt history.');
  }
  for (const [index, entry] of file.attempts.entries()) {
    if (!entry || !entry.move || typeof entry.move !== 'object' || Array.isArray(entry.move)) {
      throw new Error(`Invalid move at attempt ${index + 1}.`);
    }
    if (entry.validatorVersion !== undefined &&
        (entry.operation !== undefined || entry.validatorVersion !== 1 || entry.validation?.code !== 'hinge-cover')) {
      throw new Error(`Invalid validator version at attempt ${index + 1}.`);
    }
    if (entry.operation === 'unfold') {
      const plan = !legacy && unfoldSource(replay);
      if (!plan || plan.foldAttempt !== entry.move.foldAttempt) {
        throw new Error(`Invalid unfold source at attempt ${index + 1}.`);
      }
      replay = recordUnfold(replay);
    } else if (entry.operation === 'flip' && !legacy) {
      replay = recordFlip(replay);
    } else if (entry.operation === 'mark' && !legacy) {
      replay = recordMark(replay, entry.move.point);
    } else if (entry.operation === 'remove-mark' && !legacy) {
      replay = recordRemoveMark(replay, entry.move.markAttempt);
    } else {
      if (entry.operation !== undefined) throw new Error(`Unknown operation at attempt ${index + 1}.`);
      replay = appendMove(replay, entry.move, legacy ? 1 : entry.validatorVersion);
    }
    const actual = replay.attempts[index];
    if ((entry.operation && !matches(actual.move, entry.move)) ||
        !matches(actual.validation, entry.validation) || !matches(actual.state, entry.state)) {
      throw new Error(`Validation or state mismatch at attempt ${index + 1}.`);
    }
  }
  if (!matches(replay.final, file.final)) throw new Error('The saved final state does not match replay.');
  inspectGeometry(replay, proofOptions).forEach((report, index) => requireGeometry(report, index + 1));
  return replay;
}
