import { apply, type Move, type PaperState } from '../lab/engine';
import { packetCandidates } from '../lab/packet-intent';
import { draftMove, type Draft } from './gestures';

export interface Interpretation {
  readonly draft: Draft;
  readonly move: Move;
  readonly result: ReturnType<typeof apply>;
}

/** A failed edge-snap rival need not hold up the only accepted interpretation. */
export function uniqueAccepted(draft: Draft, interpretations: readonly Interpretation[]) {
  const first = interpretations[0];
  if (first?.result.validation.status !== 'accepted') return;
  const edgeSnap = draft.source || draft.lineIntent?.kind === 'align-lines';
  const unambiguous = edgeSnap
    ? interpretations.filter(option => option.result.validation.status === 'accepted').length === 1
    : !draft.alternatives?.length && interpretations.length === 1;
  return unambiguous ? first : undefined;
}

/** Choose among approved material identities without changing the gesture's geometric solutions. */
export function interpretDraft(state: PaperState, draft: Draft): Interpretation[] {
  if (draft.side === undefined) return [];
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
  const accepted: Interpretation[] = [];
  let failed: Interpretation | undefined;
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
