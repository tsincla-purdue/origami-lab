import { ENGINE_REVISION, NUMERICS, apply, deepFreeze, initialState, type Move, type PaperState, type Validation } from './engine';
import { DEFAULT_PAPER_STYLE, isPaperStyle, type PaperStyle } from './paper-style';

export interface Attempt {
  readonly move: Move;
  readonly validation: Validation;
  readonly state: PaperState;
}

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
  if (experiment.attempts.length >= MAX_ATTEMPTS) {
    throw new Error(`An experiment can contain up to ${MAX_ATTEMPTS} attempts.`);
  }
  const snapshot = deepFreeze(JSON.parse(JSON.stringify(move)) as Move);
  const result = apply(experiment.final, snapshot);
  return deepFreeze({
    ...experiment,
    attempts: [...experiment.attempts, { move: snapshot, ...result }],
    final: result.state,
  });
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
  if (!matches(replay.engine, file.engine) || !matches(replay.numerics, file.numerics)) {
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
    replay = recordMove(replay, entry.move);
    const actual = replay.attempts[index];
    if (!matches(actual.validation, entry.validation) || !matches(actual.state, entry.state)) {
      throw new Error(`Validation or state mismatch at attempt ${index + 1}.`);
    }
  }
  if (!matches(replay.final, file.final)) throw new Error('The saved final state does not match replay.');
  return replay;
}
