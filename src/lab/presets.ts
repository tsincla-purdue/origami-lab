import { type Move } from './engine';

export interface Preset {
  readonly name: string;
  readonly moves: readonly Move[];
}

const vertical = (x: number, label: string): Move => ({ line: [[x, 0], [x, 1]], side: -1, label });
const horizontal = (y: number, label: string): Move => ({ line: [[0, y], [1, y]], side: 1, label });

export const PRESETS: readonly Preset[] = [
  {
    name: 'Quarter square',
    moves: [vertical(0.5, 'Right half over'), horizontal(0.5, 'Top half down')],
  },
  {
    name: 'Eight-layer strip',
    moves: [vertical(0.5, 'Right half over'), vertical(0.25, 'Halve the stack'), vertical(0.125, 'Halve it again')],
  },
  {
    name: 'Triangle packet',
    moves: [
      { line: [[0, 0], [1, 1]], side: -1, label: 'Fold the first diagonal' },
      { line: [[0, 1], [1, 0]], side: 1, label: 'Bisect the triangle' },
    ],
  },
];
