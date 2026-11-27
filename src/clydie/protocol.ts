// The controller's entire view. Runtime imports of the paper engine belong to the host.
import type {TactileCommand, TactileFeedback} from '../lab/tactile';

const positionedActions = ['beginDrag', 'beginTrace', 'move'] as const;
const otherActions = ['release', 'mark', 'flip', 'unfold', 'stop'] as const;
export const actions = [...positionedActions, ...otherActions] as const;
export type Point = {x: number; y: number};
export type Action = {action: typeof positionedActions[number]; at: Point}
  | {action: typeof otherActions[number]};
export type Note = {kind: 'observation' | 'conjecture'; text: string};
export type Choice = Action & {note?: Note};
const coord = {type: 'number', minimum: -1, maximum: 2};
const point = {type: 'object', required: ['x', 'y'], additionalProperties: false, properties: {x: coord, y: coord}};
const note = {type: 'object', required: ['kind', 'text'], additionalProperties: false, properties: {
  kind: {type: 'string', enum: ['observation', 'conjecture']}, text: {type: 'string', minLength: 1, maxLength: 240},
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

export const instructions = `You have a piece of paper that you can explore by touching and moving it. There is no particular shape you need to make. Explore the paper and see what you notice.
Use one JSON action per reply. beginTrace places a sensing finger. Once tracing, use move to feel the path to another location without gripping. Repeating beginTrace at the same position keeps the same contact and explores nothing new. At another position, beginTrace lifts and places the finger there. beginDrag tries to grip an accessible corner, exposed edge or existing material feature. A flat interior touch does not guarantee a grip. A failed grip leaves you holding nothing. move keeps an acquired grip and can encounter resistance. Without a grip it moves only your hand. release lifts the finger or lets go and, when appropriate, attempts to complete a fold.
beginTrace, beginDrag and move require at with numeric x and y. Omit at for release, mark (try to mark the current contact), flip (turn the paper over), unfold (try to open the last fold) and stop (end the episode).
The original square spans 0 to 1 on each axis, y increases upwards, and the hand may range from -1 to 2. Its motor coordinates are your own positions. Proximity and local landmark intensity range from 0 to 1. Contact, snap changes, resistance and outcomes describe what you felt. You may include one short note with kind observation or conjecture and text. Your notebook starts empty.`;

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
      (v.note.kind !== 'observation' && v.note.kind !== 'conjecture') ||
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
  recent: {action: Action; sense: ReturnType<typeof observe>}[];
  notebook: Note[];
  correction?: string;
};
export interface Controller {
  metadata: Record<string, unknown>;
  decide(view: View, signal: AbortSignal): Promise<{raw: string; generatedTokens?: number; responseMetadata?: Record<string, unknown>}>;
}
