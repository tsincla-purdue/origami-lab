import './style.css';
import { type Line } from '../vendor/origamio/src/geometry';
import { foldedPoints } from '../vendor/origamio/src/paper';
import { cameraViewBox, fitCamera, renderFolded, renderUnfolded, viewBox } from '../vendor/origamio/src/render';
import {
  PRESETS, createExperiment, exportFold, importExperiment, propose, recordMove,
  serializeExperiment, stateAt, validate,
} from './lab';
import type { Experiment, Move, Validation } from './lab';
import { MAX_EXPERIMENT_LENGTH } from './lab/experiment';

const get = <T extends HTMLElement | SVGElement = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
const candidate = get<HTMLSelectElement>('candidate');
const preset = get<HTMLSelectElement>('preset');
const notice = get<HTMLParagraphElement>('notice');
const paper = get<SVGSVGElement>('paper');
const perform = get<HTMLButtonElement>('perform');
const history = get<HTMLOListElement>('history');
const undo = get<HTMLButtonElement>('undo');
const replay = get<HTMLButtonElement>('replay');
const reset = get<HTMLButtonElement>('reset');
const fileInput = get<HTMLInputElement>('import-file');

let experiment = createExperiment();
let cursor = 0;
let creaseView = false;
let moves: Move[] = [];
let playback: number | undefined;

function notify(message = '', error = false) {
  notice.hidden = !message;
  notice.textContent = message;
  notice.classList.toggle('error', error);
}

function stopPlayback() {
  window.clearInterval(playback);
  playback = undefined;
}

function seek(position: number) {
  stopPlayback();
  cursor = position;
  render();
}

function displayDrawing() {
  const state = stateAt(experiment, cursor);
  const atTip = cursor === experiment.attempts.length;
  const move = atTip && playback === undefined ? moves[candidate.selectedIndex] : undefined;
  get('folded-view').setAttribute('aria-pressed', String(!creaseView));
  get('crease-view').setAttribute('aria-pressed', String(creaseView));
  get('sheet-caption').textContent = `${state.facets.length} ${state.facets.length === 1 ? 'facet' : 'facets'} · ${state.foldCount} ${state.foldCount === 1 ? 'fold' : 'folds'}`;
  paper.setAttribute('aria-label', creaseView ? 'Unfolded paper and crease pattern' : 'Current folded paper');
  paper.setAttribute('viewBox', creaseView ? viewBox(state.width, state.height) :
    cameraViewBox(state.size, fitCamera(state.size, foldedPoints(state))));
  const line: Line | undefined = move && {
    a: { x: move.line[0][0], y: move.line[0][1] },
    b: { x: move.line[1][0], y: move.line[1][1] },
  };
  paper.innerHTML = creaseView ? renderUnfolded(state) :
    renderFolded(state, move && line ? { preview: { line, side: move.side } } : {});
  get('legend').innerHTML = creaseView
    ? '<span><i class="swatch crease-swatch"></i> Crease</span>'
    : '<span><i class="swatch front"></i> Paper front</span><span><i class="swatch back"></i> Paper back</span>' +
      (move ? '<span><i class="swatch axis"></i> Fold axis</span>' : '');
}

function showValidation(validation: Validation | undefined, canAttempt: boolean) {
  const pill = get('validation-status');
  pill.hidden = !validation;
  pill.className = `status-pill ${validation?.status ?? ''}`;
  pill.textContent = validation?.status ?? '';
  get('validation-reason').textContent = validation?.reason ??
    'Replay to the end of the history to add another move.';
  perform.disabled = !canAttempt || !validation;
  perform.textContent = canAttempt && validation?.status !== 'accepted' ? 'Record attempt' : 'Apply fold';
}

function renderCandidate() {
  const move = moves[candidate.selectedIndex];
  const available = !candidate.disabled && move;
  const recorded = cursor > 0 ? experiment.attempts[cursor - 1].validation : undefined;
  showValidation(available ? validate(stateAt(experiment, cursor), move) : recorded, Boolean(available));
  displayDrawing();
}

function renderHistory() {
  get('history-count').textContent = `${experiment.attempts.length} ${experiment.attempts.length === 1 ? 'attempt' : 'attempts'}`;
  const steps = ['Initial square', ...experiment.attempts.map(({move}, i) =>
    typeof move.label === 'string' && move.label ? move.label : `Fold attempt ${i + 1}`)];
  const rows = steps.map((text, index) => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    if (index === cursor) button.setAttribute('aria-current', 'step');
    const number = document.createElement('span');
    number.className = 'step-number';
    number.textContent = String(index).padStart(2, '0');
    const title = document.createElement('span');
    title.className = 'step-name';
    title.textContent = text;
    title.title = text;
    button.append(number, title);
    if (index > 0) {
      const {status, reason} = experiment.attempts[index - 1].validation;
      const badge = document.createElement('span');
      badge.className = `history-status ${status}`;
      badge.textContent = status;
      badge.title = reason;
      button.append(badge);
    }
    button.addEventListener('click', () => {
      seek(index);
      history.querySelector<HTMLElement>('[aria-current="step"]')?.focus({preventScroll: true});
    });
    row.append(button);
    return row;
  });
  history.replaceChildren(...rows);
  const active = rows[cursor];
  if (active.offsetTop < history.scrollTop) history.scrollTop = active.offsetTop;
  if (active.offsetTop + active.offsetHeight > history.scrollTop + history.clientHeight) {
    history.scrollTop = active.offsetTop + active.offsetHeight - history.clientHeight;
  }
}

function render() {
  candidate.disabled = cursor !== experiment.attempts.length || playback !== undefined;
  moves = candidate.disabled ? [] : propose(experiment.final);
  candidate.replaceChildren(...(moves.length
    ? moves.map(move => new Option(move.label))
    : [new Option('History preview')]));
  if (moves.length === 0) candidate.disabled = true;

  renderHistory();
  renderCandidate();

  undo.disabled = cursor === 0;
  reset.disabled = cursor === 0;
  replay.disabled = experiment.attempts.length === 0;
  get('replay-label').textContent = playback === undefined ? 'Replay' : 'Pause';
}

function replaceExperiment(next: Experiment, position: number) {
  stopPlayback();
  experiment = next;
  cursor = position;
  notify();
  render();
}

function canReplace() {
  return !experiment.attempts.length || window.confirm('Replace this experiment? Export it first if you want to keep its history.');
}

function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

candidate.addEventListener('change', renderCandidate);
perform.addEventListener('click', () => {
  const move = moves[candidate.selectedIndex];
  if (!move || cursor !== experiment.attempts.length) return;
  try {
    experiment = recordMove(experiment, move);
    cursor = experiment.attempts.length;
    notify();
    render();
  } catch (error) {
    notify((error as Error).message, true);
  }
});
get('crease-view').addEventListener('click', () => { creaseView = true; displayDrawing(); });
get('folded-view').addEventListener('click', () => { creaseView = false; displayDrawing(); });
undo.addEventListener('click', () => seek(cursor - 1));
reset.addEventListener('click', () => seek(0));
replay.addEventListener('click', () => {
  if (playback !== undefined) {
    seek(cursor);
    return;
  }
  cursor = 0;
  playback = window.setInterval(() => {
    cursor++;
    if (cursor === experiment.attempts.length) stopPlayback();
    render();
  }, 480);
  render();
});
get('new-experiment').addEventListener('click', () => {
  if (canReplace()) replaceExperiment(createExperiment(), 0);
});

PRESETS.forEach(({name}, index) => preset.add(new Option(name, String(index))));
preset.addEventListener('change', () => {
  const chosen = PRESETS[Number(preset.value)];
  preset.value = '';
  if (!chosen || !canReplace()) return;
  replaceExperiment(chosen.moves.reduce(recordMove, createExperiment()), 0);
  notify(`${chosen.name} loaded. Select Replay or a step in the history.`);
});

get('import-button').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  try {
    if (file.size > MAX_EXPERIMENT_LENGTH) throw new Error('The experiment file is too large.');
    const imported = importExperiment(await file.text());
    if (canReplace()) {
      replaceExperiment(imported, imported.attempts.length);
      notify('Experiment imported and verified by replay.');
    }
  } catch (error) {
    notify(`Import failed. ${(error as Error).message}`, true);
  }
});
get('export-button').addEventListener('click', () =>
  download('origami-experiment.json', serializeExperiment(experiment)));
get('fold-export').addEventListener('click', () => {
  try {
    const kind = creaseView ? 'creasePattern' : 'foldedForm';
    download(`origami-${creaseView ? 'creases' : 'folded'}.fold`,
      JSON.stringify(exportFold(stateAt(experiment, cursor), kind), null, 2));
  } catch (error) {
    notify(`FOLD export failed. ${(error as Error).message}`, true);
  }
});

render();
