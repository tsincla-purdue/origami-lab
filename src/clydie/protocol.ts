// The controller's entire view. Runtime imports of the paper engine belong to the host.
import type {SensoryFact, SensoryStep} from './memory';
import type {TactileCommand, TactileFeedback} from '../lab/tactile';

const positionedActions = ['beginDrag', 'beginTrace', 'move'] as const;
const otherActions = ['release', 'mark', 'flip', 'unfold', 'stop'] as const;
export const actions = [...positionedActions, ...otherActions] as const;
export type Point = {x: number; y: number};
export type Action = {action: typeof positionedActions[number]; at: Point}
  | {action: typeof otherActions[number]};
const noteKinds = ['question', 'conjecture', 'reflection'] as const;
export type Note = {kind: typeof noteKinds[number]; text: string};
export type Choice = Action & {note?: Note};
const coord = {type: 'number', minimum: -1, maximum: 2};
const point = {type: 'object', required: ['x', 'y'], additionalProperties: false, properties: {x: coord, y: coord}};
const note = {type: 'object', required: ['kind', 'text'], additionalProperties: false, properties: {
  kind: {type: 'string', enum: noteKinds}, text: {type: 'string', minLength: 1, maxLength: 240},
}};
export const format = {
  oneOf: [
    {type: 'object', additionalProperties: false, required: ['action', 'at'], properties: {
      action: {type: 'string', enum: positionedActions}, at: point, note,
    }},
    {type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: {type: 'string', enum: otherActions}, note,
    }},
  ],
} as const;

export const invitation = `You have a piece of paper to explore.

Play with it in whatever way you find interesting or pleasing. Let what you experience suggest a question you would like to investigate, however small. Use your hands to explore that question, paying attention to what actually happens.

Follow surprises, change your question, or pursue something entirely different whenever you wish.

There is no particular shape to make, no problem to solve, and no result you need to achieve. The exploration itself is the point.`;

export const instructions = `${invitation}

Measurement contract
Only host feedback reports sensations. The hand cannot sense texture, stiffness, pressure, sound or elasticity. Zero proximity means no local proximity signal was reported. It does not establish uniformity. sense.events lists reported events in order. delta compares readings excluding motor position. No reported change describes only the sensors.
The action you choose now has not happened. Its consequences arrive in the next view. Your optional note (question, conjecture or reflection, up to 240 characters) concerns earlier experience. inquiryNotebook holds your own words. Guesses are welcome. beforeMotorIndex is the number of completed commands when you wrote it.

Return one JSON action. beginTrace places a sensing finger. At another position it lifts and repositions. At the same position it keeps tracing. move samples the intervening path. beginDrag tries to grip an accessible corner, exposed edge or material feature. A flat interior touch can fail. After failure move moves only the hand. A held grip can encounter resistance. release lifts or lets go and may complete a fold.
beginTrace, beginDrag and move require at with numeric x and y in [-1,2]. Omit at for release, mark (mark the current contact), flip (turn over), unfold (open the last fold), or stop. The original square spans [0,1] on both axes, y upwards. Proximity and landmark intensity range from 0 to 1.`;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function parseChoice(raw: string): Choice {
  const v: unknown = JSON.parse(raw);
  if (!object(v) || !actions.some(a => a === v.action) || Object.keys(v).some(k => !['action','at','note'].includes(k))) {
    throw new Error('Expected one supported action.');
  }
  const positioned = positionedActions.some(a => a === v.action);
  if (positioned) {
    if (!object(v.at) || Object.keys(v.at).length !== 2 ||
        ![v.at.x, v.at.y].every(n => typeof n === 'number' && Number.isFinite(n) && n >= coord.minimum && n <= coord.maximum)) {
      throw new Error('Supply just x and y in the workspace range.');
    }
  } else if ('at' in v) throw new Error('This action takes no coordinates.');
  if ('note' in v && (!object(v.note) || Object.keys(v.note).length !== 2 ||
      !noteKinds.includes(v.note.kind as Note['kind']) ||
      typeof v.note.text !== 'string' || !v.note.text.trim() || v.note.text.length > 240)) {
    throw new Error('A note needs a kind and 1–240 characters of text.');
  }
  return v as Choice;
}

export function observe(f: TactileFeedback, command?: TactileCommand) {
  // A no-grab verdict is retained verbatim by the host. Only the felt event changes.
  const acquired = command?.kind === 'drag' && !f.validation;
  const events = f.events.slice(acquired ? -7 : -8).map(e => {
    switch (e.kind) {
      case 'contact': return {kind: e.kind, contact: e.contact};
      case 'snap-acquired': return {kind: e.kind, constraint: e.constraint};
      case 'resistance':
        if (command?.kind === 'drag' && e.validation.code === 'no-grab') return {kind: 'grip-failed'};
        return {kind: e.kind, outcome: e.validation.status};
      default: return {kind: e.kind};
    }
  });
  if (acquired) events.push({kind: 'grip-acquired'});
  return {
    motor: {x: f.motor.x, y: f.motor.y}, proximity: f.proximity, contact: f.contact ?? null,
    snapped: f.snapped, outcome: f.validation?.status ?? null,
    ...(f.landmark && {landmark: {kind: f.landmark.kind, intensity: f.landmark.intensity}}),
    events, omittedEvents: Math.max(0, f.events.length + Number(acquired) - 8),
  };
}

export type View = {
  handMode: 'idle' | 'tracing' | 'dragging';
  motor: Point;
  nextMotorIndex: number;
  recent: SensoryStep[];
  sensoryMemory: SensoryFact[];
  inquiryNotebook: (Note & {beforeMotorIndex: number})[];
  omittedInquiryNotes: number;
  correction?: string;
};
export interface Controller {
  metadata: Record<string, unknown>;
  decide(view: View, signal: AbortSignal): Promise<{raw: string; generatedTokens?: number; responseMetadata?: Record<string, unknown>}>;
}
