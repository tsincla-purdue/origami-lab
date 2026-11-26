import { apply, foldMotion, type Move, type PaperState } from '../lab/engine';
import { previewUnfold, recordGestureMove, recordUnfold, type Experiment } from '../lab/experiment';
import { packetCandidates } from '../lab/packet-intent';
import { draftCapture, draftMove, type Draft } from './gestures';

interface FoldInterpretation {
  readonly draft: Draft;
  readonly move: Move;
  readonly result: ReturnType<typeof apply>;
}

export type Interpretation = FoldInterpretation | {
  readonly draft: Draft;
  readonly move?: undefined;
  readonly result: ReturnType<typeof previewUnfold>;
};

/** A failed edge-snap rival need not hold up the only accepted interpretation. */
export function uniqueAccepted(draft: Draft, interpretations: readonly Interpretation[]) {
  if (interpretations.some(option => option.draft.opening)) {
    const accepted = interpretations.filter(option => option.result.validation.status === 'accepted');
    // A refused opening remains the primary verdict when the gripper is on that hinge.
    return accepted.length === 1 && (!draft.opening || accepted[0].draft.opening) ? accepted[0] : undefined;
  }
  const first = interpretations[0];
  if (first?.result.validation.status !== 'accepted') return;
  const edgeSnap = draft.source || draft.lineIntent?.kind === 'align-lines';
  const unambiguous = edgeSnap
    ? interpretations.filter(option => option.result.validation.status === 'accepted').length === 1
    : !draft.alternatives?.length && interpretations.length === 1;
  return unambiguous ? first : undefined;
}

export function interpretGesture(experiment: Experiment, draft: Draft): Interpretation[] {
  if (!draft.opening && !draft.alternatives?.some(option => option.opening)) return interpretDraft(experiment.final, draft);
  return [draft, ...draft.alternatives ?? []].flatMap<Interpretation>(option => {
    const preview = {...option, alternatives: undefined};
    if (!option.opening) return interpretDraft(experiment.final, preview);
    const {foldAttempt, obstruction} = option.opening;
    const result: ReturnType<typeof previewUnfold> = obstruction ? {state: experiment.final, validation: obstruction === 'covered'
      ? {status: 'rejected', code: 'opening-covered', reason: 'Stationary paper covers the flap on this side.'}
      : {status: 'unverified', code: 'opening-disconnected', reason: 'The grab cannot move all the joined flaps as one packet.'}}
      : previewUnfold(experiment, foldAttempt);
    const opening = {draft: preview, result};
    if (!preview.inferFrom) return [opening];
    // A cut through a thicker packet can use the same axis while moving different material.
    const openingIds = new Set(preview.packet?.facetIds);
    const folds = interpretDraft(experiment.final, {...preview, opening: undefined, snapLabel: undefined}).filter(fold => {
      if (fold.result.validation.status !== 'accepted') return false;
      const moved = foldMotion(fold.result.state)!.packet.facetIds;
      return moved.length !== openingIds.size || moved.some(id => !openingIds.has(id));
    });
    return [opening, ...folds];
  });
}

export function commitInterpretation(experiment: Experiment, option: Interpretation): Experiment {
  if (option.move) return recordGestureMove(experiment, option.move, draftCapture(option.draft));
  if (option.result.validation.status !== 'accepted') throw new Error('The grabbed fold cannot be opened.');
  return recordUnfold(experiment, option.draft.opening!.foldAttempt);
}

/** Choose among approved material identities without changing the gesture's geometric solutions. */
export function interpretDraft(state: PaperState, draft: Draft): FoldInterpretation[] {
  if (draft.side === undefined || draft.opening) return [];
  if (draft.alternatives?.length) {
    return [draft, ...draft.alternatives].flatMap(option => interpretDraft(state, {...option, alternatives: undefined}));
  }
  const constraint = draft.constraint;
  const geometry = constraint
    ? [constraint.index, ...constraint.solutions.keys()].filter((index, i) => i === 0 || index !== constraint.index)
        .map(index => ({
          ...draft, ...constraint.solutions[index], snapped: [constraint.solutions[index].destination],
          constraint: { ...constraint, index },
        }))
    : [draft];
  const accepted: FoldInterpretation[] = [];
  let failed: FoldInterpretation | undefined;
  for (const placement of geometry) {
    const candidates = placement.inferFrom && placement.side !== undefined
      ? packetCandidates(state, placement.inferFrom, placement.line, placement.side)
      : [];
    for (const packet of candidates.length ? candidates : [placement.packet]) {
      const proposal = { ...placement, packet };
      const move = draftMove(proposal)!;
      const result = apply(state, move);
      const interpretation = { draft: proposal, move, result };
      if (result.validation.status === 'accepted') accepted.push(interpretation);
      else failed ??= interpretation;
    }
  }
  return accepted.length ? accepted : failed ? [failed] : [];
}
