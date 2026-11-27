// The controller's entire view. Runtime imports of the paper engine belong to the host.
import type {TactileFeedback} from '../lab/tactile';

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
Use one JSON action per reply. beginTrace places the probe, beginDrag tries to grab, and move moves the hand. These three require at with numeric x and y. For release, mark, flip, unfold, or stop, omit at. release lifts the hand, mark tries to mark the current contact, flip turns the paper over, unfold asks to open the last fold, and stop ends the episode.
The original square spans 0 to 1 on each axis, y increases upwards, and the hand may range from -1 to 2. Its motor coordinates are your own positions. Proximity ranges from 0 to 1. Contact, snap changes, resistance and outcomes describe what you felt. You may include one short note with kind observation or conjecture and text. Your notebook starts empty.`;

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

export function observe(f: TactileFeedback) {
  return {
    motor: {x: f.motor.x, y: f.motor.y}, proximity: f.proximity, contact: f.contact ?? null,
    snapped: f.snapped, outcome: f.validation?.status ?? null,
    events: f.events.slice(-8).map(e => {
      switch (e.kind) {
        case 'contact': return {kind: e.kind, contact: e.contact};
        case 'snap-acquired': return {kind: e.kind, constraint: e.constraint};
        case 'resistance': return {kind: e.kind, outcome: e.validation.status};
        default: return {kind: e.kind};
      }
    }),
    omittedEvents: Math.max(0, f.events.length - 8),
  };
}

export type View = {
  motor: Point;
  recent: {action: Action; sense: ReturnType<typeof observe>}[];
  notebook: Note[];
  correction?: string;
};
export interface Controller {
  metadata: Record<string, unknown>;
  decide(view: View, signal: AbortSignal): Promise<{raw: string; generatedTokens?: number}>;
}
