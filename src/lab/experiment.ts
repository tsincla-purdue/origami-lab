import { ENGINE_REVISION, NUMERICS, apply, deepFreeze, initialState, reverseFold, type Move, type PaperState, type Validation } from './engine';
import { DEFAULT_PAPER_STYLE, isPaperStyle, type PaperStyle } from './paper-style';

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
  return appendMove(experiment, move);
}

function appendMove(experiment: Experiment, move: Move, validatorVersion?: 1): Experiment {
  if (experiment.attempts.length >= MAX_ATTEMPTS) {
    throw new Error(`An experiment can contain up to ${MAX_ATTEMPTS} attempts.`);
  }
  const snapshot = deepFreeze(JSON.parse(JSON.stringify(move)) as Move);
  const result = apply(experiment.final, snapshot, validatorVersion);
  const retainsClearance = validatorVersion === 1 && result.validation.code === 'hinge-cover';
  const attempt: Attempt = { move: snapshot, ...result, ...(retainsClearance && {validatorVersion}) };
  return appendAttempt(experiment, attempt);
}

function appendAttempt(experiment: Experiment, attempt: Attempt): Experiment {
  return deepFreeze({ ...experiment, attempts: [...experiment.attempts, attempt], final: attempt.state });
}

function unfoldSource(experiment: Experiment): number | undefined {
  for (let i = experiment.attempts.length - 1; i >= 0; i--) {
    const attempt = experiment.attempts[i];
    if (attempt.validation.status !== 'accepted') continue;
    if (!attempt.operation && attempt.state === experiment.final) return i + 1;
    break;
  }
}

export function canUnfold(experiment: Experiment): boolean {
  return experiment.attempts.length < MAX_ATTEMPTS && unfoldSource(experiment) !== undefined;
}

export function recordUnfold(experiment: Experiment): Experiment {
  if (experiment.attempts.length >= MAX_ATTEMPTS) throw new Error(`An experiment can contain up to ${MAX_ATTEMPTS} attempts.`);
  const foldAttempt = unfoldSource(experiment);
  const state = foldAttempt === undefined ? undefined : reverseFold(experiment.final);
  if (!state || foldAttempt === undefined) throw new Error('The latest state is not the result of a reversible fold.');
  return appendAttempt(experiment, {
    operation: 'unfold', move: { foldAttempt, label: 'Unfold' }, state,
    validation: { status: 'accepted', code: 'unfold', reason: 'Reversed the last fold and retained its material creases.' },
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
export function importExperiment(text: string): Experiment {
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
        (entry.validatorVersion !== 1 || entry.validation?.code !== 'hinge-cover')) {
      throw new Error(`Invalid validator version at attempt ${index + 1}.`);
    }
    if (entry.operation === 'unfold') {
      if (legacy || unfoldSource(replay) !== entry.move.foldAttempt || !canUnfold(replay)) {
        throw new Error(`Invalid unfold source at attempt ${index + 1}.`);
      }
      replay = recordUnfold(replay);
      if (!matches(replay.attempts[index].move, entry.move)) throw new Error(`Invalid unfold at attempt ${index + 1}.`);
    } else {
      if (entry.operation !== undefined) throw new Error(`Unknown operation at attempt ${index + 1}.`);
      replay = appendMove(replay, entry.move, legacy ? 1 : entry.validatorVersion);
    }
    const actual = replay.attempts[index];
    if (!matches(actual.validation, entry.validation) || !matches(actual.state, entry.state)) {
      throw new Error(`Validation or state mismatch at attempt ${index + 1}.`);
    }
  }
  if (!matches(replay.final, file.final)) throw new Error('The saved final state does not match replay.');
  return replay;
}
