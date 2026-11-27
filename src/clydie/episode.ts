import {
  TACTILE_VERSION, createExperiment, createTactileSession, importExperiment, replayTactileTrajectory, serializeExperiment,
  type Experiment, type TactileCommand, type TactileFeedback, type TactileHand, type TactileTrajectory,
} from '../lab';
import {decode, motorMessages, rememberTool, toolExchange, type ToolExchange, type ToolTurn} from './interaction';
import {createMemory, memoryPolicy} from './memory';
import {integer, ProviderError} from './controllers';
import {observe, parseChoice, type Action, type Choice, type Controller, type Interaction, type Point, type View} from './protocol';

export {lmstudioController, ollamaController, randomController} from './controllers';
export {importExperiment, observe, serializeExperiment};
export const defaults = {
  maxCommands: 100, maxDecisions: 100, durationMs: 600000, timeoutMs: 30000, step: .125,
  pixelsPerUnit: 400, trajectoryLimit: 2048, recentLimit: 6, notebookLimit: 6, sensoryLimit: 6,
};
type Settings = typeof defaults;

function settings(options: Partial<Settings>): Settings {
  const c = {...defaults, ...options};
  integer('maxCommands', c.maxCommands, 1, 2048);
  integer('maxDecisions', c.maxDecisions, 1, 2048);
  integer('durationMs', c.durationMs, 1, 86400000);
  integer('timeoutMs', c.timeoutMs, 1, 600000);
  integer('trajectoryLimit', c.trajectoryLimit, 0, 2048);
  integer('sensoryLimit', c.sensoryLimit, 1, 16);
  integer('recentLimit', c.recentLimit, 1, 16);
  integer('notebookLimit', c.notebookLimit, 0, 16);
  integer('pixelsPerUnit', c.pixelsPerUnit, 32, 4096);
  if (!Number.isFinite(c.step) || c.step < .01 || c.step > 1) throw new RangeError('Motor step must be in [.01, 1].');
  return c;
}

function* path(choice: Choice, start: Point, config: Settings): Generator<TactileCommand> {
  switch (choice.action) {
    case 'stop': return;
    case 'beginTrace': yield {kind: 'trace', at: choice.at}; return;
    case 'beginDrag': yield {kind: 'drag', at: choice.at}; return;
    case 'move': {
      // Allow for interpolation roundoff at the native 4096-pixel movement boundary.
      const step = Math.min(config.step, (4096 - 1e-9) / config.pixelsPerUnit);
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

function formatError(err: unknown) {
  return err instanceof SyntaxError ? 'Expected one JSON object.' : (err as Error).message;
}

type Entry = TactileTrajectory['entries'][number];
type Decision = {
  tool?: ToolExchange; latencyMs?: number;
  inquiry?: View['inquiryNotebook'][number];
  view: View; raw?: string; generatedTokens?: number; choice?: Choice; error?: string;
  responseMetadata?: Record<string, unknown>;
  providerResponse?: {body: string; truncated: boolean};
  motorStart: number; motorCount: number;
};
type Ending = 'motor-limit' | 'decision-limit' | 'duration' | 'model-timeout' | 'provider-error' | 'host-stop' | 'agent-stop';
export interface Episode {
  version: 2 | 3; memoryPolicy: typeof memoryPolicy; started: string; elapsedMs: number; controller: Controller['metadata']; settings: Settings;
  initial: Experiment; decisions: Decision[]; trajectory: TactileTrajectory; overflow: Entry[];
  ending: Ending; inquiryNotebook: View['inquiryNotebook']; sensoryMemory: View['sensoryMemory']; experiment: Experiment;
}

function interactionMode(controller: Controller['metadata']): Interaction {
  const mode = controller.interaction ?? 'structured';
  if (mode === 'structured' || (controller.type === 'lmstudio' && (mode === 'native-tools' || mode === 'motor-json'))) return mode;
  throw new Error('Unsupported recorded interaction mode.');
}

export async function runEpisode(controller: Controller, options: Partial<Settings> = {},
  initial = createExperiment(), signal?: AbortSignal): Promise<Episode> {
  const config = settings(options);
  const mode = interactionMode(controller.metadata);
  const turns: ToolTurn[] = [];
  const session = createTactileSession(initial, config);
  const started = new Date().toISOString();
  const start = performance.now(), deadline = start + config.durationMs;
  const duration = AbortSignal.timeout(config.durationMs);
  const decisions: Decision[] = [], log: Entry[] = [];
  const memory = createMemory(config);
  let correction: string | undefined;
  function hostLimit(): Ending | undefined {
    if (signal?.aborted) return 'host-stop';
    if (performance.now() >= deadline || duration.aborted) return 'duration';
    if (log.length >= config.maxCommands) return 'motor-limit';
  }

  let ending: Ending | undefined;
  while (!(ending = hostLimit())) {
    if (decisions.length >= config.maxDecisions) { ending = 'decision-limit'; break; }
    const decision: Decision = {view: memory.view(correction), motorStart: log.length, motorCount: 0};
    decisions.push(decision);
    const requested = performance.now();
    const requestDeadline = requested + config.timeoutMs;
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const request = AbortSignal.any(signal ? [duration, timeout, signal] : [duration, timeout]);
    let rejectOnAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(request.reason);
        request.addEventListener('abort', rejectOnAbort, {once: true});
      });
      // Controllers receive a detached observation. Session, host history and diagnostics stay here.
      const reply = await Promise.race([controller.decide(structuredClone(decision.view), request, structuredClone(turns)), cancelled]);
      decision.raw = reply.raw;
      decision.generatedTokens = reply.generatedTokens;
      if (reply.responseMetadata) decision.responseMetadata = reply.responseMetadata;
    } catch (err) {
      decision.error = err instanceof Error ? err.message : 'Controller failed.';
      if (err instanceof ProviderError) decision.providerResponse = {body: err.body, truncated: err.truncated};
      ending = hostLimit() ?? (timeout.aborted ? 'model-timeout' : 'provider-error');
      break;
    } finally {
      if (controller.metadata.type === 'lmstudio') decision.latencyMs = Math.round(performance.now() - requested);
      if (rejectOnAbort) request.removeEventListener('abort', rejectOnAbort);
    }
    if ((ending = hostLimit())) break;
    if (performance.now() >= requestDeadline) {
      decision.error = 'Controller exceeded its response deadline.';
      ending = 'model-timeout'; break;
    }
    let call: ToolExchange['call'] | undefined;
    try {
      const parsed = decode(decision.raw, mode);
      decision.choice = parsed.choice;
      call = parsed.call;
    } catch (err) {
      decision.error = formatError(err);
      correction = decision.error;
      continue;
    }
    correction = undefined;
    const choice = decision.choice;
    if (choice.note) decision.inquiry = memory.inquire(choice.note);
    const senses: ReturnType<typeof observe>[] = [];
    for (const command of path(choice, memory.motor, config)) {
      if (hostLimit()) break;
      const feedback = execute(session.hand, command);
      log.push({command, feedback});
      decision.motorCount++;
      const sense = observe(feedback, command);
      memory.record(asAction(command), sense);
      if (call) senses.push(sense);
    }
    if (call) {
      decision.tool = toolExchange(call, decision.motorStart, senses, memory);
      rememberTool(turns, {...decision.tool, before: decision.view}, config.recentLimit);
    }
    if (choice.action === 'stop') { ending = 'agent-stop'; break; }
  }
  const trajectory = session.trajectory() ?? {version: TACTILE_VERSION, pixelsPerUnit: config.pixelsPerUnit, entries: [], truncated: log.length > 0};
  return {version: mode === 'structured' ? 2 : 3, memoryPolicy: structuredClone(memoryPolicy), started, elapsedMs: Math.round(performance.now() - start), controller: controller.metadata,
    settings: config, initial, decisions, trajectory, overflow: log.slice(trajectory.entries.length),
    ending, inquiryNotebook: memory.inquiryNotebook, sensoryMemory: memory.sensoryMemory, experiment: session.experiment()};
}

// JSON object key order can change when a saved record passes through another tool.
function sortedJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  });
}

type HistoricalEpisode = Pick<Episode, 'initial' | 'experiment' | 'trajectory' | 'overflow'> & {
  version: 1; settings: Omit<Settings, 'sensoryLimit'>; decisions: Pick<Decision, 'motorStart' | 'motorCount'>[];
};

export function replayEpisode(record: Episode | HistoricalEpisode) {
  if (record.version !== 1 && record.version !== 2 && record.version !== 3) throw new Error('Unsupported Clydie episode version.');
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
  if (record.version !== 1) {
    const mode = interactionMode(record.controller);
    const turns: ToolTurn[] = [];
    if ((mode === 'structured') !== (record.version === 2)) throw new Error('Interaction and episode version disagree.');
    const memory = createMemory(config);
    let correction: string | undefined;
    if (sortedJSON(record.memoryPolicy) !== sortedJSON(memoryPolicy)) throw new Error('Unknown sensory memory policy.');
    const interrupted = record.ending === 'duration' || record.ending === 'host-stop' ||
      (record.ending === 'motor-limit' && trajectory.entries.length === config.maxCommands);
    for (const d of record.decisions) {
      const view = memory.view(correction);
      if (sortedJSON(d.view) !== sortedJSON(view)) throw new Error('Replay disagrees with recorded controller view.');
      if (record.version === 3 && d.raw !== undefined) {
        const {instructions, inputBudget} = record.controller;
        if (typeof instructions !== 'string' || typeof inputBudget !== 'number' || !Number.isFinite(inputBudget)) {
          throw new Error('Missing recorded input configuration.');
        }
        const input = motorMessages(instructions, view, turns, mode === 'native-tools', inputBudget);
        if (input.inputBytes !== d.responseMetadata?.inputBytes || sortedJSON(input.messages) !== sortedJSON(d.responseMetadata?.messages)) {
          throw new Error('Replay disagrees with recorded model input.');
        }
      }
      if (d.choice) {
        const {choice: parsed, call} = decode(d.raw ?? '', mode);
        if (sortedJSON(parsed) !== sortedJSON(d.choice)) throw new Error('Replay disagrees with recorded choice.');
        const inquiry = parsed.note ? memory.inquire(parsed.note) : undefined;
        if (sortedJSON(inquiry) !== sortedJSON(d.inquiry)) throw new Error('Replay disagrees with time-stamped inquiry.');
        const senses: ReturnType<typeof observe>[] = [];
        const expected = path(parsed, memory.motor, config);
        for (let i = d.motorStart; i < d.motorStart + d.motorCount; i++) {
          const command = trajectory.entries[i].command;
          const next = expected.next();
          if (next.done || sortedJSON(next.value) !== sortedJSON(command)) {
            throw new Error(`Recorded command at motor index ${i} disagrees with the choice's motor path.`);
          }
          const sense = observe(result.feedback[i], command);
          memory.record(asAction(command), sense);
          if (call) senses.push(sense);
        }
        if (!expected.next().done && !(interrupted && d === record.decisions.at(-1))) {
          throw new Error('Recorded decision ends before its motor path is complete.');
        }
        const exchange = call && toolExchange(call, d.motorStart, senses, memory);
        if (sortedJSON(exchange) !== sortedJSON(d.tool)) throw new Error('Replay disagrees with recorded tool call or host result.');
        if (exchange) rememberTool(turns, {...exchange, before: view}, config.recentLimit);
        correction = undefined;
      } else {
        if (d.motorCount || d.inquiry || d.tool) throw new Error('Invalid decision issued motor commands or inquiry.');
        // Only format failures can lead to another request. Transport and deadline errors end the run.
        if (d !== record.decisions.at(-1) || (record.version === 3 && record.ending === 'decision-limit')) {
          if (d.raw === undefined) throw new Error('Missing model reply before correction.');
          let error: string | undefined;
          try { decode(d.raw, mode); } catch (err) { error = formatError(err); }
          if (!error || error !== d.error) throw new Error('Replay disagrees with format correction.');
          correction = error;
        }
      }
    }
    if (record.version === 3 && ((record.ending === 'agent-stop') !== (record.decisions.at(-1)?.choice?.action === 'stop') ||
        record.decisions.slice(0, -1).some(d => d.choice?.action === 'stop'))) {
      throw new Error('Replay disagrees with recorded stop decision.');
    }
    if (sortedJSON(record.sensoryMemory) !== sortedJSON(memory.sensoryMemory) ||
        sortedJSON(record.inquiryNotebook) !== sortedJSON(memory.inquiryNotebook)) throw new Error('Replay disagrees with final memory.');
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
