import type { Line, Vec } from '../../vendor/origamio/src/geometry';

export interface SnapCandidate<T> {
  readonly key: string;
  readonly score: number;
  readonly value: T;
}

export const pointKey = ({x, y}: Vec) => `${x},${y}`;
export const lineKey = ({a, b}: Line) => [pointKey(a), pointKey(b)].sort().join('/');
export const snapRadius = (pointerType: string) => pointerType === 'touch' ? 18 : 13;
export const releaseRadius = (radius: number) => radius * 1.5;

/** A locked target survives small movements. A close rival becomes a choice, not a replacement. */
export function selectSnap<T extends SnapCandidate<unknown>>(candidates: readonly T[], radius: number, locked?: string) {
  const sorted = [...candidates].sort((a, b) => a.score - b.score);
  const acquired = sorted.filter(candidate => candidate.score <= radius);
  const primary = sorted.find(candidate => candidate.key === locked && candidate.score <= releaseRadius(radius)) ?? acquired[0];
  if (!primary) return [];
  const best = acquired[0] ?? primary;
  return [primary, ...acquired.filter(candidate => candidate.key !== primary.key &&
    candidate.score <= Math.min(primary.score, best.score) + radius / 4)];
}
