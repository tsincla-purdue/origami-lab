// LM Studio wire protocol. Host results are constructed from projected tactile readings only.
import {actions, format, object, parseChoice, point, positionedActions,
  type Choice, type Interaction, type View} from './protocol';

export const motorFormat = {oneOf: format.oneOf.map(({properties: {note, ...properties}, ...branch}) =>
  ({...branch, properties}))};
export const tools = actions.map(name => ({
  type: 'function', function: {name, parameters: positionedActions.some(action => action === name) ? point :
    {type: 'object', properties: {}, additionalProperties: false}},
}));

type Call = {type: 'function'; id: string; function: {name: string; arguments: string}};
export function decode(raw: string, interaction: Interaction): {choice: Choice; call?: Call} {
  if (interaction !== 'native-tools') {
    const choice = parseChoice(raw);
    if (interaction === 'motor-json' && choice.note) throw new Error('Return only a motor action.');
    return {choice};
  }
  const message = JSON.parse(raw);
  if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length !== 1) {
    throw new Error('Request exactly one motor function.');
  }
  const call = message.tool_calls[0];
  if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id.trim() ||
      typeof call.function?.arguments !== 'string' || !actions.some(action => action === call.function.name)) {
    throw new Error('Expected a supported motor function with a call ID and JSON arguments.');
  }
  const {name, arguments: argsJSON} = call.function;
  const args: unknown = JSON.parse(argsJSON);
  if (!object(args)) throw new Error('Supply a JSON object of function arguments.');
  const positioned = positionedActions.some(action => action === name);
  if (!positioned && Object.keys(args).length) throw new Error('This function takes no arguments.');
  const choice = parseChoice(JSON.stringify(positioned ? {action: name, at: args} : {action: name}));
  return {choice, call: {type: 'function', id: call.id, function: {name, arguments: argsJSON}}};
}

type Sense = View['recent'][number]['sense'];
export type ToolExchange = {call: Call; result: {role: 'tool'; tool_call_id: string; content: string}};
export type ToolTurn = ToolExchange & {before: View};

export function rememberTool(turns: ToolTurn[], turn: ToolTurn, limit: number) {
  // Some backends reuse IDs. Keep associations unique within each submitted conversation.
  const duplicate = turns.findIndex(previous => previous.call.id === turn.call.id);
  if (duplicate >= 0) turns.splice(0, duplicate + 1);
  turns.push(turn);
  if (turns.length > limit) turns.shift();
}

export function toolExchange(call: Call, motorStart: number, senses: Sense[], after: Pick<View, 'motor' | 'handMode'>,
  includePositions = true): ToolExchange {
  // The range is linear. Keep every successive reading (and repeated event) without repeating stationary fields.
  type Reading = Omit<Sense, 'motor'>;
  const readings: {count: number; sense?: Reading; changes?: Record<string, unknown>}[] = [];
  let previous: Reading | undefined;
  for (const {motor, ...sense} of senses) {
    if (!previous) readings.push({count: 1, sense});
    else {
      const changes: Record<string, unknown> = {};
      for (const key of Object.keys({...previous, ...sense}) as (keyof Reading)[]) {
        if (JSON.stringify(previous[key]) !== JSON.stringify(sense[key])) changes[key] = sense[key] ?? null;
      }
      if (Object.keys(changes).length) readings.push({count: 1, changes});
      else readings[readings.length - 1].count++;
    }
    previous = sense;
  }
  const positions = includePositions ? senses.map(({motor}) => [motor.x, motor.y]) : undefined;
  const content = JSON.stringify({motorStart, motorCount: senses.length, motor: after.motor, handMode: after.handMode, readings, positions});
  return {call, result: {role: 'tool', tool_call_id: call.id, content}};
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

// Budget the wire objects in UTF-8 bytes, with a separate reserve for the loaded chat template.
export function motorMessages(prompt: string, view: View, history: readonly ToolTurn[], native: boolean, inputBudget: number) {
  const turns = [...history];
  for (;;) {
    const {inquiryNotebook, omittedInquiryNotes, correction, ...state} = turns[0]?.before ?? view;
    const snapshot = {...state, recent: [...state.recent], sensoryMemory: [...state.sensoryMemory]};
    const messages: object[] = [{role: 'system', content: prompt}, {role: 'user', content: ''}];
    for (const {call, result} of turns) messages.push({role: 'assistant', content: null, tool_calls: [call]}, result);
    if (view.correction && turns.length) messages.push({role: 'user', content: view.correction});
    for (;;) {
      messages[1] = {role: 'user', content: JSON.stringify({...snapshot, ...(!turns.length && {correction: view.correction})})};
      const inputBytes = bytes(messages) + bytes(native ? tools : motorFormat);
      if (inputBytes <= inputBudget) return {messages, inputBytes};
      if (turns.length > 1) break;
      if (snapshot.sensoryMemory.length) snapshot.sensoryMemory.shift();
      else if (snapshot.recent.length > (turns.length ? 0 : 1)) snapshot.recent.shift();
      else throw new Error(`Complete model input needs ${inputBytes} bytes, exceeding the ${inputBudget}-byte input budget.`);
    }
    turns.shift(); // Always retain the most recent complete assistant/result pair.
  }
}
