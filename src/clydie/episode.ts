import {
  createExperiment, createTactileSession, importExperiment, replayTactileTrajectory, serializeExperiment,
  type Experiment, type TactileCommand, type TactileFeedback, type TactileHand, type TactileTrajectory,
} from '../lab';
import {integer, ProviderError} from './controllers';
import {observe, parseChoice, type Action, type Choice, type Controller, type Point, type View} from './protocol';

export {ollamaController, randomController} from './controllers';
export {importExperiment, serializeExperiment};
export const defaults = {
  maxCommands: 100, maxDecisions: 100, durationMs: 600000, timeoutMs: 30000, step: .125,
  pixelsPerUnit: 400, trajectoryLimit: 2048, recentLimit: 6, notebookLimit: 6,
};
type Settings = typeof defaults;

function settings(options: Partial<Settings>): Settings {
  const c = {...defaults, ...options};
  integer('maxCommands', c.maxCommands, 1, 2048);
  integer('maxDecisions', c.maxDecisions, 1, 2048);
  integer('durationMs', c.durationMs, 1, 86400000);
  integer('timeoutMs', c.timeoutMs, 1, 600000);
  integer('trajectoryLimit', c.trajectoryLimit, 0, 2048);
  integer('recentLimit', c.recentLimit, 1, 16);
  integer('notebookLimit', c.notebookLimit, 0, 16);
  integer('pixelsPerUnit', c.pixelsPerUnit, 32, 4096);
  if (!Number.isFinite(c.step) || c.step < .01 || c.step > 1) throw new RangeError('Motor step must be in [.01, 1].');
  return c;
}

function* path(choice: Choice, start: Point, step: number): Generator<TactileCommand> {
  switch (choice.action) {
    case 'stop': return;
    case 'beginTrace': yield {kind: 'trace', at: choice.at}; return;
    case 'beginDrag': yield {kind: 'drag', at: choice.at}; return;
    case 'move': {
      const dx = choice.at.x - start.x, dy = choice.at.y - start.y;
      const count = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
      for (let i = 1; i <= count; i++) {
        yield {kind: 'move', at: i === count ? choice.at : {x: start.x + dx * i / count, y: start.y + dy * i / count}};
      }
      return;
    }
    default: yield {kind: choice.action};
  }
}
function execute(hand: TactileHand, command: TactileCommand): TactileFeedback {
  switch (command.kind) {
    case 'drag': return hand.beginDrag(command.at);
    case 'trace': return hand.beginTrace(command.at);
    case 'move': return hand.move(command.at);
    default: return hand[command.kind]();
  }
}
function asAction(c: TactileCommand): Action {
  if ('at' in c) return {action: c.kind === 'drag' ? 'beginDrag' : c.kind === 'trace' ? 'beginTrace' : 'move', at: c.at};
  return {action: c.kind};
}

type Entry = TactileTrajectory['entries'][number];
type Decision = {
  view: View; raw?: string; generatedTokens?: number; choice?: Choice; error?: string;
  providerResponse?: {body: string; truncated: boolean};
  motorStart: number; motorCount: number;
};
type Ending = 'motor-limit' | 'decision-limit' | 'duration' | 'model-timeout' | 'provider-error' | 'host-stop' | 'agent-stop';
export interface Episode {
  version: 1; started: string; elapsedMs: number; controller: Controller['metadata']; settings: Settings;
  initial: Experiment; decisions: Decision[]; trajectory: TactileTrajectory; overflow: Entry[];
  ending: Ending; notebook: View['notebook']; experiment: Experiment;
}

export async function runEpisode(controller: Controller, options: Partial<Settings> = {},
  initial = createExperiment(), signal?: AbortSignal): Promise<Episode> {
  const config = settings(options);
  const session = createTactileSession(initial, config);
  // Allow for interpolation roundoff at the native 4096-pixel movement boundary.
  const step = Math.min(config.step, (4096 - 1e-9) / config.pixelsPerUnit);
  const started = new Date().toISOString();
  const start = performance.now(), deadline = start + config.durationMs;
  const duration = AbortSignal.timeout(config.durationMs);
  const decisions: Decision[] = [], log: Entry[] = [];
  const memory: View = {motor: {x: 0, y: 0}, recent: [], notebook: []};
  function hostLimit(): Ending | undefined {
    if (signal?.aborted) return 'host-stop';
    if (performance.now() >= deadline || duration.aborted) return 'duration';
    if (log.length >= config.maxCommands) return 'motor-limit';
  }

  let ending: Ending | undefined;
  while (!(ending = hostLimit())) {
    if (decisions.length >= config.maxDecisions) { ending = 'decision-limit'; break; }
    const decision: Decision = {view: structuredClone(memory), motorStart: log.length, motorCount: 0};
    decisions.push(decision);
    const requestDeadline = performance.now() + config.timeoutMs;
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const request = AbortSignal.any(signal ? [duration, timeout, signal] : [duration, timeout]);
    let rejectOnAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(request.reason);
        request.addEventListener('abort', rejectOnAbort, {once: true});
      });
      // Controllers receive a detached observation. Session, host history and diagnostics stay here.
      const reply = await Promise.race([controller.decide(structuredClone(decision.view), request), cancelled]);
      decision.raw = reply.raw;
      decision.generatedTokens = reply.generatedTokens;
    } catch (err) {
      decision.error = err instanceof Error ? err.message : 'Controller failed.';
      if (err instanceof ProviderError) decision.providerResponse = {body: err.body, truncated: err.truncated};
      ending = hostLimit() ?? (timeout.aborted ? 'model-timeout' : 'provider-error');
      break;
    } finally {
      if (rejectOnAbort) request.removeEventListener('abort', rejectOnAbort);
    }
    if ((ending = hostLimit())) break;
    if (performance.now() >= requestDeadline) {
      decision.error = 'Controller exceeded its response deadline.';
      ending = 'model-timeout'; break;
    }
    try {
      decision.choice = parseChoice(decision.raw);
    } catch (err) {
      decision.error = err instanceof SyntaxError ? 'Expected one JSON object.' : (err as Error).message;
      memory.correction = decision.error;
      continue;
    }
    delete memory.correction;
    const choice = decision.choice;
    if (choice.note) {
      memory.notebook.push(choice.note);
      if (memory.notebook.length > config.notebookLimit) memory.notebook.shift();
    }
    if (choice.action === 'stop') { ending = 'agent-stop'; break; }
    for (const command of path(choice, memory.motor, step)) {
      if (hostLimit()) break;
      const feedback = execute(session.hand, command);
      log.push({command, feedback});
      decision.motorCount++;
      memory.motor = feedback.motor;
      memory.recent.push({action: asAction(command), sense: observe(feedback)});
      if (memory.recent.length > config.recentLimit) memory.recent.shift();
    }
  }
  const trajectory = session.trajectory() ?? {version: 1, pixelsPerUnit: config.pixelsPerUnit, entries: [], truncated: log.length > 0};
  return {version: 1, started, elapsedMs: Math.round(performance.now() - start), controller: controller.metadata,
    settings: config, initial, decisions, trajectory, overflow: log.slice(trajectory.entries.length),
    ending, notebook: memory.notebook, experiment: session.experiment()};
}

// JSON object key order can change when a saved record passes through another tool.
function sortedJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  });
}

export function replayEpisode(record: Episode) {
  if (record.version !== 1) throw new Error('Unsupported Clydie episode version.');
  const initial = importExperiment(JSON.stringify(record.initial));
  const {trajectory} = record;
  if (trajectory.truncated || record.overflow.length) return {status: 'incomplete' as const};
  const config = settings(record.settings);
  if (trajectory.pixelsPerUnit !== config.pixelsPerUnit || trajectory.entries.length > config.maxCommands ||
      record.decisions.length > config.maxDecisions) throw new Error('Trajectory exceeds recorded settings.');
  let count = 0;
  for (const d of record.decisions) {
    if (d.motorStart !== count || !Number.isSafeInteger(d.motorCount) || d.motorCount < 0) throw new Error('Invalid decision motor range.');
    count += d.motorCount;
  }
  if (count !== trajectory.entries.length) throw new Error('Decision log and trajectory length disagree.');
  let motor = {x: 0, y: 0};
  for (const {command} of trajectory.entries) {
    const {kind, ...args} = command;
    if (!['trace', 'drag', 'move', 'release', 'mark', 'flip', 'unfold'].includes(kind) || 'action' in args || 'note' in args) {
      throw new Error('Unknown recorded motor command.');
    }
    const action = kind === 'trace' ? 'beginTrace' : kind === 'drag' ? 'beginDrag' : kind;
    const choice = parseChoice(JSON.stringify({action, ...args}));
    if ('at' in choice) {
      if (action === 'move' && Math.hypot(choice.at.x - motor.x, choice.at.y - motor.y) * config.pixelsPerUnit > 4096) {
        throw new Error('Recorded movement exceeds the tactile step limit.');
      }
      motor = choice.at;
    }
  }
  const result = replayTactileTrajectory(initial, trajectory);
  if (sortedJSON(result.feedback) !== sortedJSON(trajectory.entries.map(entry => entry.feedback)) ||
      sortedJSON(result.experiment) !== sortedJSON(record.experiment)) {
    throw new Error('Replay disagrees with recorded feedback or canonical experiment.');
  }
  return {status: 'verified' as const};
}

export function summarize(record: Episode) {
  const entries = [...record.trajectory.entries, ...record.overflow];
  const contacts: Record<string, number> = {}, outcomes: Record<string, number> = {};
  let snaps = 0, resistance = 0;
  for (const {feedback} of entries) {
    if (feedback.validation) {
      const key = feedback.validation.status;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
    }
    for (const event of feedback.events) {
      if (event.kind === 'contact') contacts[event.contact] = (contacts[event.contact] ?? 0) + 1;
      if (event.kind === 'snap-acquired') snaps++;
      if (event.kind === 'resistance') resistance++;
    }
  }
  const attempts = record.experiment.attempts.slice(record.initial.attempts.length);
  return {decisions: record.decisions.length, motorCommands: entries.length, invalidChoices: record.decisions.filter(d => d.raw !== undefined && !d.choice && d.error).length,
    contacts, snaps, resistance, feedbackOutcomes: outcomes, recordedOperations: attempts.map(a => a.operation ?? 'fold'),
    finalFacets: record.experiment.final.facets.length, finalCreases: record.experiment.final.creases.length,
    finalMarks: record.experiment.final.marks?.length ?? 0, ending: record.ending};
}
