import './style.css';
import type { Vec } from '../vendor/origamio/src/geometry';
import { foldedPoints } from '../vendor/origamio/src/paper';
import { cameraViewBox, fitCamera, viewBox } from '../vendor/origamio/src/render';
import {
  DEFAULT_PAPER_STYLE, PAPER_STYLES, PRESETS, canFlip, canUnfold, createExperiment, exportFold, importExperiment,
  isPaperStyle, paperInView, propose, recordFlip, recordMark, recordMove, recordRemoveMark, recordUnfold,
  serializeExperiment, setPaperStyle, stateAt, undoMove, validate,
} from './lab';
import type { Experiment, Move, PaperStyle, Validation } from './lab';
import { MAX_EXPERIMENT_LENGTH } from './lab/experiment';
import { connectGestures, type ConstraintIssue, type CornerSelection, type Draft, type Tool } from './playground/gestures';
import { interpretDraft, type Interpretation } from './playground/intent';
import {
  constraintMarkup, cornerHandles, faceColor, lineHandles, markHandles, markMarkup, markSelection,
  packetMarkup, paperMarkup, previewMarkup, styleSwatch,
} from './playground/paper-view';

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
const flipButton = get<HTMLButtonElement>('flip-paper');
const solutionChoice = get<HTMLSelectElement>('solution-choice');
const markButton = get<HTMLButtonElement>('mark-point');
const markLayer = get<HTMLSelectElement>('mark-layer');

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
let interpretations: Interpretation[] = [];
let choice = 0;
const picked = () => interpretations[choice];
let constraintIssue: ConstraintIssue | undefined;
let gestureFeedback: Validation | undefined;
let shownCorners: readonly Vec[] | undefined;
let shownSelection: CornerSelection | undefined;

const atTip = () => cursor === experiment.attempts.length && playback === undefined;
const editable = () => atTip() && !creaseView;
const gestures = connectGestures(paper, { snapping: () => snapToggle.checked, show: showDraft, commit: settleDraft });
let shownMarkOptions: ReturnType<typeof gestures.markOptions> | undefined;
const selectedMark = () => gestures.markOptions()[markLayer.selectedIndex];

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
  const unit = pixelUnit();
  get<SVGGElement>('paper-handles').innerHTML = lineHandles(gestures.grabLines().map(({line}) => line), unit) +
    cornerHandles(gestures.corners(), unit) + markHandles(gestures.markedPoints(), unit);
  get<SVGGElement>('paper-marks').innerHTML = markMarkup(stateAt(experiment, cursor), unit, creaseView);
}

function drawOverlay() {
  const layer = get<SVGGElement>('paper-preview');
  if (creaseView) {
    layer.innerHTML = '';
    return;
  }
  const move = atTip() && advanced.open && !pending && !hoverCorner && !gestureFeedback && !gestures.pinned()
    ? moves[candidate.selectedIndex] : undefined;
  const option = picked();
  const guide = option?.draft ?? pending ?? (move && {
    line: { a: { x: move.line[0][0], y: move.line[0][1] }, b: { x: move.line[1][0], y: move.line[1][1] } },
    side: move.side,
  });
  const endpoint = option?.result.validation.status === 'accepted' ? paperInView(option.result.state) : undefined;
  const state = paperInView(stateAt(experiment, cursor));
  const selection = gestures.selection();
  const unit = pixelUnit();
  const landings = interpretations.filter(({result}) => result.validation.status === 'accepted')
    .map(({draft}) => draft.destination);
  layer.innerHTML = (selection ? packetMarkup(state, selection, guide, unit, option?.move.packet) : '') +
    previewMarkup(state, guide, endpoint, hoverCorner, unit, !selection) +
    constraintMarkup(gestures.pinned(), option?.draft ?? pending, constraintIssue, landings, unit) +
    markSelection(selectedMark() ?? gestures.markGhost(), unit, !selectedMark());
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
      new Option('Automatic', ''),
      ...selection.packets.map(({facetIds}) => new Option(String(facetIds.length))),
      new Option('Whole stack', 'all'),
    ] : [new Option('Automatic', ''), new Option('Whole stack', 'all')]));
  }
  countControl.value = gestures.wholeStack() ? 'all' :
    selection && gestures.hasExplicitPacket() ? String(selection.count) : '';
  const max = selection?.packets.at(-1)?.facetIds.length;
  const inferred = picked()?.draft.inferFrom && picked()?.move.packet?.facetIds.length;
  const text = inferred && inferred !== selection?.count ? `${inferred} connected facets` :
    gestures.wholeStack() ? 'Whole stack' : selection ? `${selection.count}/${max} layers` : '';
  const status = get('packet-status');
  if (status.textContent !== text) status.textContent = text;
}

function gestureStatus() {
  const verdict = picked()?.result.validation ?? gestureFeedback;
  const status = get('gesture-status');
  const text = verdict?.status ?? constraintIssue?.status ?? '';
  status.hidden = !text;
  status.className = `status-pill ${text}`;
  if (status.textContent !== text) status.textContent = text;
  const pin = gestures.pinned();
  const explanation = verdict?.status === 'accepted' && pending?.lineIntent?.kind === 'perpendicular-point'
    ? 'The crease passes through the pin at a right angle to the grabbed line.' : verdict?.reason;
  const snap = picked()?.draft.snapLabel ?? pending?.snapLabel;
  const intersection = selectedMark() ?? gestures.markGhost();
  const message = snap && (!verdict || verdict.status === 'accepted')
    ? `${snap}. ${pending?.side === undefined ? 'Tap the side to move.' : explanation ?? ''}`.trim()
    : explanation ?? constraintIssue?.reason ?? (intersection ? `Exact intersection on layer ${intersection.rank}.` :
    creaseView ? 'Switch to Folded to use the fold tools.' :
    !atTip() ? 'Return to the last history step to continue folding.' :
    pending?.tool === 'crease' ? 'Tap the side of the line you want to move.' :
    pin ? 'Drag a point along its line, or toward another visible crease or edge.' :
    tool === 'crease' ? 'Draw a crease, then tap the side to move.' :
    gestures.selection() ? 'Drag the selected point or press and hold it to pin it.' :
    'Drag a corner or edge, tap to select layers, or press and hold a point to pin it.');
  const reason = get('gesture-reason');
  if (reason.textContent !== message) reason.textContent = message;
  const confirmation = pending && pending.side !== undefined && gestures.canConfirm(pending);
  confirmFold.hidden = !confirmation;
  confirmFold.disabled = picked()?.result.validation.status !== 'accepted';
  cancelFold.hidden = !pending && !pin;
  pinButton.disabled = !editable() || tool !== 'corner' || (!pin && !gestures.selection());
  pinButton.setAttribute('aria-pressed', String(Boolean(pin)));
  pinButton.textContent = pin ? 'Unpin point' : 'Pin point';
  const markOptions = gestures.markOptions();
  if (shownMarkOptions !== markOptions) {
    markLayer.replaceChildren(...markOptions.map(({rank, point: {x, y}}, index) =>
      new Option(`Layer ${rank} · sheet (${x.toFixed(3)}, ${y.toFixed(3)})`, String(index))));
    shownMarkOptions = markOptions;
  }
  const mark = selectedMark();
  get('mark-layer-control').hidden = !editable() || markOptions.length < 2;
  markButton.hidden = !editable() || !mark;
  markButton.textContent = mark?.markId === undefined ? 'Mark point' : 'Remove mark';
  get('solution-control').hidden = !confirmation || interpretations.length < 2;
  if (confirmation && interpretations.length > 1) {
    const pointKey = ({x, y}: Vec) => `${x},${y}`;
    const landings = new Set(interpretations.map(({draft}) => pointKey(draft.destination)));
    const hasPacketChoice = landings.size < interpretations.length;
    get('solution-label').textContent = pending?.alternatives?.length ? 'Snap target' : landings.size === 1 ? 'Moving packet'
      : hasPacketChoice || pending?.lineIntent ? 'Fold preview' : 'Landing point';
    const labels = interpretations.map(({draft, move}) => {
      const {x, y} = draft.destination;
      const location = `(${x.toFixed(3)}, ${y.toFixed(3)})`;
      const material = `${move.packet?.facetIds.length ?? experiment.final.facets.length} connected facets`;
      if (pending?.alternatives?.length) {
        const target = draft.lineIntent?.kind === 'align-lines' ? ` · target facet ${draft.lineIntent.target.facetId}` : '';
        const axis = [draft.line.a, draft.line.b].map(({x, y}) => `(${x.toFixed(3)}, ${y.toFixed(3)})`).join(' → ');
        return `${move.label} · ${axis}${target}`;
      }
      return landings.size === 1 ? material : hasPacketChoice ? `${location} · ${material}` : location;
    });
    if (labels.join() !== [...solutionChoice.options].map(option => option.text).join()) {
      solutionChoice.replaceChildren(...labels.map((label, index) => new Option(label, String(index))));
    }
    solutionChoice.value = String(choice);
  }
}

function showDraft(draft?: Draft, hover?: Vec, issue?: ConstraintIssue) {
  if (draft !== pending) {
    interpretations = draft && editable() ? interpretDraft(experiment.final, draft) : [];
    choice = 0;
  }
  pending = draft;
  hoverCorner = hover;
  constraintIssue = issue;
  const selection = gestures.selection();
  const selectionChanged = selection !== shownSelection;
  if (draft || issue || selectionChanged) gestureFeedback = undefined;
  gestureStatus();
  drawOverlay();
  displayPacketControls();
  shownSelection = selection;
  if (selectionChanged && advanced.open) renderCandidate();
}

function clearGesture() {
  gestureFeedback = undefined;
  gestures.cancel();
}

function finishDraft() {
  const option = picked();
  if (editable() && pending && gestures.canConfirm(pending) && option?.result.validation.status === 'accepted') {
    commitMove(option.move);
  }
}

function settleDraft(draft: Draft) {
  const verdict = picked()?.result.validation;
  if (verdict?.status === 'accepted') {
    if (!draft.alternatives?.length && interpretations.length === 1 && !(draft.constraint && gestures.pinNeedsConfirmation())) finishDraft();
  } else if (!draft.constraint && !draft.alternatives?.length) {
    gestureFeedback = verdict;
    gestures.cancel();
  }
}

function displayDrawing() {
  const model = stateAt(experiment, cursor);
  const state = paperInView(model);
  const style = experiment.appearance.paperStyle;
  get('folded-view').setAttribute('aria-pressed', String(!creaseView));
  get('crease-view').setAttribute('aria-pressed', String(creaseView));
  for (const mode of ['corner', 'crease'] as const) {
    const button = get<HTMLButtonElement>(`${mode}-tool`);
    button.setAttribute('aria-pressed', String(tool === mode));
    button.disabled = !editable();
  }
  snapToggle.disabled = !editable();
  flipButton.disabled = !editable() || !canFlip(experiment);
  flipButton.setAttribute('aria-pressed', String(Boolean(model.pose?.reversed)));
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
  gestureStatus();
  drawOverlay();
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
flipButton.addEventListener('click', () => {
  if (!editable() || !canFlip(experiment)) return;
  try {
    const next = recordFlip(experiment);
    replaceExperiment(next, next.attempts.length);
  } catch (error) {
    notify((error as Error).message, true);
  }
});
markLayer.addEventListener('change', () => {
  gestureStatus();
  drawOverlay();
});
markButton.addEventListener('click', () => {
  const mark = selectedMark();
  if (!editable() || !mark) return;
  try {
    const next = mark.markId === undefined
      ? recordMark(experiment, mark.point)
      : recordRemoveMark(experiment, mark.markId);
    replaceExperiment(next, next.attempts.length);
  } catch (error) {
    notify((error as Error).message, true);
  }
});
solutionChoice.addEventListener('change', () => {
  const next = Number(solutionChoice.value);
  if (!pending || !gestures.canConfirm(pending) || !interpretations[next]) return;
  choice = next;
  drawOverlay();
  gestureStatus();
  displayPacketControls();
});
for (const mode of ['corner', 'crease'] as const) {
  get(`${mode}-tool`).addEventListener('click', () => {
    tool = mode;
    clearGesture();
    displayDrawing();
  });
}
confirmFold.addEventListener('click', finishDraft);
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
