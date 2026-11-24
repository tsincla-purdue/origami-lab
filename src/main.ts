import './style.css';
import type { Vec } from '../vendor/origamio/src/geometry';
import { foldedPoints } from '../vendor/origamio/src/paper';
import { cameraViewBox, fitCamera, viewBox } from '../vendor/origamio/src/render';
import {
  DEFAULT_PAPER_STYLE, PAPER_STYLES, PRESETS, apply, canUnfold, createExperiment, exportFold, importExperiment,
  isPaperStyle, propose, recordMove, recordUnfold, serializeExperiment, setPaperStyle, stateAt, undoMove, validate,
} from './lab';
import type { Experiment, Move, PaperStyle, Validation } from './lab';
import { MAX_EXPERIMENT_LENGTH } from './lab/experiment';
import { connectGestures, draftMove, type ConstraintIssue, type CornerSelection, type Draft, type Tool } from './playground/gestures';
import { constraintMarkup, cornerHandles, faceColor, packetMarkup, paperMarkup, previewMarkup, styleSwatch } from './playground/paper-view';

const get = <T extends HTMLElement | SVGElement = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
const candidate = get<HTMLSelectElement>('candidate');
const preset = get<HTMLSelectElement>('preset');
const notice = get<HTMLParagraphElement>('notice');
const paper = get<SVGSVGElement>('paper');
const perform = get<HTMLButtonElement>('perform');
const history = get<HTMLOListElement>('history');
const undo = get<HTMLButtonElement>('undo');
const unfold = get<HTMLButtonElement>('unfold');
const replay = get<HTMLButtonElement>('replay');
const reset = get<HTMLButtonElement>('reset');
const fileInput = get<HTMLInputElement>('import-file');
const advanced = get<HTMLDetailsElement>('advanced');
const snapToggle = get<HTMLInputElement>('snap-toggle');
const confirmFold = get<HTMLButtonElement>('confirm-fold');
const cancelFold = get<HTMLButtonElement>('cancel-fold');
const cornerControl = get<HTMLSelectElement>('packet-corner');
const countControl = get<HTMLSelectElement>('packet-count');
const pinButton = get<HTMLButtonElement>('pin-point');
const solutionChoice = get<HTMLSelectElement>('solution-choice');

const styleKey = 'origami-lab.paper-style';
function savedStyle(): PaperStyle {
  try {
    const style = localStorage.getItem(styleKey);
    if (isPaperStyle(style)) return style;
  } catch { /* Local settings are optional. */ }
  return DEFAULT_PAPER_STYLE;
}

function rememberStyle(style: PaperStyle) {
  try { localStorage.setItem(styleKey, style); }
  catch { /* The experiment still carries the style. */ }
}

let experiment = createExperiment(savedStyle());
let cursor = 0;
let creaseView = false;
let moves: Move[] = [];
let playback: number | undefined;
let tool: Tool = 'corner';
let pending: Draft | undefined;
let hoverCorner: Vec | undefined;
let preview: ReturnType<typeof apply> | undefined;
let alternatives: ReturnType<typeof apply>[] = [];
let constraintIssue: ConstraintIssue | undefined;
let gestureFeedback: Validation | undefined;
let shownCorners: readonly Vec[] | undefined;
let shownSelection: CornerSelection | undefined;

const atTip = () => cursor === experiment.attempts.length && playback === undefined;
const editable = () => atTip() && !creaseView;
const gestures = connectGestures(paper, { snapping: () => snapToggle.checked, show: showDraft, commit: finishDraft });

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
  clearGesture();
  render();
}

function pixelUnit() {
  const matrix = paper.getScreenCTM();
  return matrix ? 1 / (Math.hypot(matrix.a, matrix.b) || 1) : 1;
}

function drawHandles() {
  get<SVGGElement>('paper-handles').innerHTML = cornerHandles(gestures.corners(), pixelUnit());
}

function drawOverlay() {
  const layer = get<SVGGElement>('paper-preview');
  if (creaseView) {
    layer.innerHTML = '';
    return;
  }
  const move = atTip() && advanced.open && !pending && !hoverCorner && !gestureFeedback && !gestures.pinned()
    ? moves[candidate.selectedIndex] : undefined;
  const guide = pending ?? (move && {
    line: { a: { x: move.line[0][0], y: move.line[0][1] }, b: { x: move.line[1][0], y: move.line[1][1] } },
    side: move.side,
  });
  const endpoint = preview?.validation.status === 'accepted' ? preview.state : undefined;
  const state = stateAt(experiment, cursor);
  const selection = gestures.selection();
  const unit = pixelUnit();
  layer.innerHTML = (selection ? packetMarkup(state, selection, guide, unit) : '') +
    previewMarkup(state, guide, endpoint, hoverCorner, unit, !selection) +
    constraintMarkup(gestures.pinned(), pending, constraintIssue?.target, unit);
}

function displayPacketControls() {
  const corners = gestures.availableCorners();
  const selection = gestures.selection();
  const current = selection ? corners.indexOf(selection.corner) : -1;
  const selectedPoint = selection && current < 0 ? selection.corner : undefined;
  if (corners !== shownCorners || selection !== shownSelection) {
    cornerControl.replaceChildren(new Option('Choose a corner', ''), ...corners.map(({x, y}, index) =>
      new Option(`Corner ${index + 1} · (${x.toFixed(2)}, ${y.toFixed(2)})`, String(index))));
    if (selectedPoint) cornerControl.add(new Option(
      `Selected point · (${selectedPoint.x.toFixed(2)}, ${selectedPoint.y.toFixed(2)})`, 'point',
    ));
    shownCorners = corners;
  }
  cornerControl.value = selectedPoint ? 'point' : current < 0 ? '' : String(current);
  cornerControl.disabled = !corners.length;
  countControl.disabled = !editable();
  if (selection !== shownSelection || !countControl.options.length) {
    countControl.replaceChildren(...(selection ? [
      ...selection.packets.map(({facetIds}) => new Option(String(facetIds.length))),
      new Option('Whole stack', 'all'),
    ] : [new Option('Top at selected point', ''), new Option('Whole stack', 'all')]));
  }
  countControl.value = gestures.wholeStack() ? 'all' : selection ? String(selection.count) : '';
  const max = selection?.packets.at(-1)?.facetIds.length;
  const text = gestures.wholeStack() ? 'Whole stack' : selection ? `${selection.count}/${max} layers` : '';
  const status = get('packet-status');
  if (status.textContent !== text) status.textContent = text;
}

function gestureStatus() {
  const verdict = preview?.validation ?? gestureFeedback;
  const status = get('gesture-status');
  const text = verdict?.status ?? constraintIssue?.status ?? '';
  status.hidden = !text;
  status.className = `status-pill ${text}`;
  if (status.textContent !== text) status.textContent = text;
  const pin = gestures.pinned();
  const message = verdict?.reason ?? constraintIssue?.reason ?? (creaseView ? 'Switch to Folded to use the fold tools.' :
    !atTip() ? 'Return to the last history step to continue folding.' :
    pending?.tool === 'crease' ? 'Tap the side of the line you want to move.' :
    pin ? 'Drag a point toward a visible crease or edge.' :
    tool === 'corner' ? 'Drag a corner, or tap a point to select it.' : 'Draw a crease, then tap the side to move.');
  const reason = get('gesture-reason');
  if (reason.textContent !== message) reason.textContent = message;
  const confirmation = pending && pending.side !== undefined && gestures.canConfirm(pending);
  confirmFold.hidden = !confirmation;
  confirmFold.disabled = preview?.validation.status !== 'accepted';
  cancelFold.hidden = !pending && !pin;
  pinButton.disabled = !editable() || tool !== 'corner' || (!pin && !gestures.selection());
  pinButton.setAttribute('aria-pressed', String(Boolean(pin)));
  pinButton.textContent = pin ? 'Unpin point' : 'Pin point';
  get('solution-control').hidden = !confirmation || alternatives.length < 2;
  if (confirmation && alternatives.length > 1) {
    const labels = pending?.constraint?.solutions.map(({destination}, index) =>
      `(${destination.x.toFixed(3)}, ${destination.y.toFixed(3)}) · ${alternatives[index].validation.status}`) ?? [];
    if (labels.join() !== [...solutionChoice.options].map(option => option.text).join()) {
      solutionChoice.replaceChildren(...labels.map((label, index) => new Option(label, String(index))));
    }
    solutionChoice.value = String(pending?.constraint?.index ?? 0);
  }
}

function showDraft(draft?: Draft, hover?: Vec, issue?: ConstraintIssue) {
  pending = draft;
  hoverCorner = hover;
  constraintIssue = issue;
  const selection = gestures.selection();
  const selectionChanged = selection !== shownSelection;
  if (draft || issue || selectionChanged) gestureFeedback = undefined;
  const move = draft && draftMove(draft);
  alternatives = draft?.constraint && editable() ? draft.constraint.solutions.map(solution =>
    apply(experiment.final, draftMove({...draft, ...solution}))) : [];
  preview = draft?.constraint ? alternatives[draft.constraint.index] :
    move && editable() ? apply(experiment.final, move) : undefined;
  drawOverlay();
  gestureStatus();
  displayPacketControls();
  shownSelection = selection;
  if (selectionChanged && advanced.open) renderCandidate();
}

function clearGesture() {
  gestureFeedback = undefined;
  gestures.cancel();
}

function finishDraft(draft: Draft) {
  const move = draftMove(draft);
  if (!move || !editable()) return;
  const verdict = validate(experiment.final, move);
  if (verdict.status === 'accepted') {
    commitMove(move);
  } else {
    gestureFeedback = verdict;
    gestures.cancel();
  }
}

function displayDrawing() {
  const state = stateAt(experiment, cursor);
  const style = experiment.appearance.paperStyle;
  get('folded-view').setAttribute('aria-pressed', String(!creaseView));
  get('crease-view').setAttribute('aria-pressed', String(creaseView));
  for (const mode of ['corner', 'crease'] as const) {
    const button = get<HTMLButtonElement>(`${mode}-tool`);
    button.setAttribute('aria-pressed', String(tool === mode));
    button.disabled = !editable();
  }
  snapToggle.disabled = !editable();
  get('sheet-caption').textContent = `${state.facets.length} ${state.facets.length === 1 ? 'facet' : 'facets'} · ${state.foldCount} ${state.foldCount === 1 ? 'fold' : 'folds'}`;
  paper.setAttribute('aria-label', creaseView ? 'Unfolded paper and crease pattern' : 'Current folded paper');
  // Keep the original square in the frame so a flap can open back into it.
  paper.setAttribute('viewBox', creaseView ? viewBox(state.width, state.height) :
    cameraViewBox(state.size, fitCamera(state.size, [
      {x: 0, y: 0}, {x: state.width, y: state.height}, ...foldedPoints(state),
    ])));
  get<SVGGElement>('paper-scene').setAttribute('transform', `translate(0 ${state.size}) scale(1 -1)`);
  get<SVGGElement>('paper-art').innerHTML = paperMarkup(state, style, creaseView);
  gestures.setContext(editable() ? state : undefined, tool);
  drawHandles();
  drawOverlay();
  gestureStatus();
  displayPacketControls();
  const legend = get('legend');
  legend.style.setProperty('--paper-front', faceColor(style, 'front'));
  legend.style.setProperty('--paper-back', faceColor(style, 'back'));
  legend.innerHTML = creaseView
    ? '<span><i class="swatch crease-swatch"></i> Crease</span>'
    : '<span><i class="swatch front"></i> Front</span><span><i class="swatch back"></i> Reverse</span>';
  get('style-name').textContent = PAPER_STYLES.find(({id}) => id === style)?.name ?? '';
  for (const button of styleButtons) button.setAttribute('aria-pressed', String(button.value === style));
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

function candidateMove() {
  const move = moves[candidate.selectedIndex];
  const packet = gestures.packet();
  return move && packet ? { ...move, packet } : move;
}

function renderCandidate() {
  const move = candidateMove();
  const available = !candidate.disabled && move;
  const recorded = cursor > 0 ? experiment.attempts[cursor - 1].validation : undefined;
  showValidation(available ? validate(stateAt(experiment, cursor), move) : recorded, Boolean(available));
  drawOverlay();
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
  displayDrawing();
  renderCandidate();

  undo.disabled = !atTip() || !experiment.attempts.length;
  unfold.disabled = !atTip() || !canUnfold(experiment);
  replay.disabled = experiment.attempts.length === 0;
  get('replay-label').textContent = playback === undefined ? 'Replay' : 'Pause';
}

function replaceExperiment(next: Experiment, position: number) {
  stopPlayback();
  experiment = next;
  cursor = position;
  rememberStyle(next.appearance.paperStyle);
  clearGesture();
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

function commitMove(move: Move) {
  if (!atTip()) return;
  try {
    experiment = recordMove(experiment, move);
    cursor = experiment.attempts.length;
    clearGesture();
    notify();
    render();
  } catch (error) {
    clearGesture();
    notify((error as Error).message, true);
  }
}

const styleButtons = PAPER_STYLES.map(({id, name}) => {
  const button = document.createElement('button');
  button.className = 'style-choice';
  button.type = 'button';
  button.value = id;
  button.title = name;
  button.setAttribute('aria-label', name);
  button.innerHTML = styleSwatch(id);
  button.addEventListener('click', () => {
    experiment = setPaperStyle(experiment, id);
    rememberStyle(id);
    displayDrawing();
  });
  return button;
});
get('paper-styles').replaceChildren(...styleButtons);

new ResizeObserver(() => {
  drawHandles();
  drawOverlay();
}).observe(paper);
candidate.addEventListener('change', renderCandidate);
advanced.addEventListener('toggle', () => {
  if (!advanced.open && tool === 'crease') {
    tool = 'corner';
    clearGesture();
    displayDrawing();
  }
  renderCandidate();
});
perform.addEventListener('click', () => {
  const move = candidateMove();
  if (move) commitMove(move);
});
cornerControl.addEventListener('change', () => {
  if (cornerControl.value === 'point') return;
  const corner = cornerControl.value === '' ? undefined : gestures.availableCorners()[Number(cornerControl.value)];
  gestures.selectCorner(corner);
});
countControl.addEventListener('change', () => {
  const value = countControl.value;
  gestures.selectCount(value === 'all' ? 'all' : value ? Number(value) : undefined);
});
pinButton.addEventListener('click', () => gestures.togglePin());
solutionChoice.addEventListener('change', () => gestures.selectSolution(Number(solutionChoice.value)));
for (const mode of ['corner', 'crease'] as const) {
  get(`${mode}-tool`).addEventListener('click', () => {
    tool = mode;
    clearGesture();
    displayDrawing();
  });
}
confirmFold.addEventListener('click', () => { if (pending) finishDraft(pending); });
cancelFold.addEventListener('click', clearGesture);
document.addEventListener('keydown', event => { if (event.key === 'Escape') clearGesture(); });
get('crease-view').addEventListener('click', () => { creaseView = true; clearGesture(); displayDrawing(); });
get('folded-view').addEventListener('click', () => { creaseView = false; clearGesture(); displayDrawing(); });
undo.addEventListener('click', () => {
  if (!atTip() || !experiment.attempts.length) return;
  const retained = undoMove(experiment);
  replaceExperiment(retained, retained.attempts.length);
});
unfold.addEventListener('click', () => {
  if (!atTip() || !canUnfold(experiment)) return;
  try {
    const next = recordUnfold(experiment);
    creaseView = false;
    tool = 'corner';
    replaceExperiment(next, next.attempts.length);
  } catch (error) {
    notify((error as Error).message, true);
  }
});
reset.addEventListener('click', () => {
  creaseView = false;
  tool = 'corner';
  replaceExperiment(createExperiment(experiment.appearance.paperStyle), 0);
});
replay.addEventListener('click', () => {
  if (playback !== undefined) {
    seek(cursor);
    return;
  }
  cursor = 0;
  clearGesture();
  playback = window.setInterval(() => {
    cursor++;
    if (cursor === experiment.attempts.length) stopPlayback();
    render();
  }, 480);
  render();
});
get('new-experiment').addEventListener('click', () => {
  if (canReplace()) replaceExperiment(createExperiment(experiment.appearance.paperStyle), 0);
});

PRESETS.forEach(({name}, index) => preset.add(new Option(name, String(index))));
preset.addEventListener('change', () => {
  const chosen = PRESETS[Number(preset.value)];
  preset.value = '';
  if (!chosen || !canReplace()) return;
  replaceExperiment(chosen.moves.reduce(recordMove, createExperiment(experiment.appearance.paperStyle)), 0);
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
