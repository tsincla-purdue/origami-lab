import {instructions, observe, type Action, type Choice, type View} from './protocol';

type Sense = ReturnType<typeof observe>;
type Reading = Omit<Sense, 'motor'>;
type Limits = {recentLimit: number; sensoryLimit: number; notebookLimit: number};

export type SensoryFact = {firstMotorIndex: number; lastMotorIndex: number; reading: Reading};
export type SensoryStep = {motorIndex: number; action: Action; sense: Sense; delta: ReturnType<typeof delta>};

const utf8 = new TextEncoder();
// Each input byte costs at most one byte-level BPE token. Reserve template and completion space.
export const viewByteLimit = 4096 - 128 - 128 - utf8.encode(instructions).length;
export const memoryPolicy = {
  viewByteLimit, eventsPerMotor: 8, indexBase: 0,
  coalescing: 'consecutive equal projected readings excluding motor position',
  eviction: 'oldest first per window; then oldest source index across windows with multiple items; keep one of each if possible, then drop duplicate fact, then note; always keep latest motor',
} as const;

function delta(previous: Reading | undefined, reading: Reading) {
  const changes: Record<string, {from: unknown; to: unknown}> = {};
  if (previous) {
    for (const key of ['contact', 'proximity', 'landmark', 'snapped', 'outcome', 'omittedEvents'] as const) {
      if (JSON.stringify(previous[key]) !== JSON.stringify(reading[key])) {
        changes[key] = {from: previous[key] ?? null, to: reading[key] ?? null};
      }
    }
  }
  const eventsChanged = !!previous && JSON.stringify(previous.events) !== JSON.stringify(reading.events);
  return {firstReading: !previous, changes, eventsChanged,
    noReportedChange: !!previous && !Object.keys(changes).length && !eventsChanged &&
      reading.events.length === 0 && reading.omittedEvents === 0};
}

// The controller receives only a detached snapshot. The two stores have separate writers.
export function createMemory(limits: Limits) {
  let handMode: View['handMode'] = 'idle', motor = {x: 0, y: 0};
  let nextMotorIndex = 0, noteCount = 0;
  const recent: SensoryStep[] = [], sensoryMemory: SensoryFact[] = [], inquiryNotebook: View['inquiryNotebook'] = [];
  function record(action: Action, sense: Sense) {
    const {motor: position, ...reading} = sense;
    const last = sensoryMemory.at(-1);
    recent.push({motorIndex: nextMotorIndex, action, sense, delta: delta(last?.reading, reading)});
    if (recent.length > limits.recentLimit) recent.shift();
    if (last && JSON.stringify(last.reading) === JSON.stringify(reading)) last.lastMotorIndex = nextMotorIndex;
    else {
      sensoryMemory.push({firstMotorIndex: nextMotorIndex, lastMotorIndex: nextMotorIndex, reading});
      if (sensoryMemory.length > limits.sensoryLimit) sensoryMemory.shift();
    }
    nextMotorIndex++;
    motor = position;
    switch (action.action) {
      case 'beginTrace': handMode = 'tracing'; break;
      case 'beginDrag': handMode = sense.outcome === 'rejected' ? 'idle' : 'dragging'; break;
      case 'release': case 'flip': case 'unfold': handMode = 'idle'; break;
    }
  }
  function inquire(note: NonNullable<Choice['note']>) {
    noteCount++;
    const inquiry = {...note, beforeMotorIndex: nextMotorIndex};
    inquiryNotebook.push(inquiry);
    if (inquiryNotebook.length > limits.notebookLimit) inquiryNotebook.shift();
    return inquiry;
  }
  function view(correction?: string): View {
    const v: View = structuredClone({motor, handMode, nextMotorIndex, recent, sensoryMemory, inquiryNotebook,
      omittedInquiryNotes: noteCount - inquiryNotebook.length, ...(correction && {correction})});
    // Ranges expose the missing motor prefix. Evict whole records, never parts of an event sequence.
    while (utf8.encode(JSON.stringify(v)).length > viewByteLimit) {
      const step = v.recent.length > 1 ? v.recent[0].motorIndex : Infinity;
      const fact = v.sensoryMemory.length > 1 ? v.sensoryMemory[0].lastMotorIndex : Infinity;
      const note = v.inquiryNotebook.length > 1 ? v.inquiryNotebook[0].beforeMotorIndex : Infinity;
      if (Math.min(step, fact, note) === Infinity) {
        if (v.sensoryMemory.length) v.sensoryMemory.shift();
        else if (v.inquiryNotebook.length) { v.inquiryNotebook.shift(); v.omittedInquiryNotes++; }
        else throw new Error('Single sensory step exceeds view budget.');
      } else if (fact <= step && fact <= note) v.sensoryMemory.shift();
      else if (step <= note) v.recent.shift();
      else { v.inquiryNotebook.shift(); v.omittedInquiryNotes++; }
    }
    return v;
  }
  return {record, inquire, view, get motor() {return motor;}, get handMode() {return handMode;}, sensoryMemory, inquiryNotebook};
}
