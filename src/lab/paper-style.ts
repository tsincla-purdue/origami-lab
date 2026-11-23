export const PAPER_STYLES = [
  { id: 'classic', name: 'Classic white' },
  { id: 'two-tone', name: 'Two-tone' },
  { id: 'grid', name: 'Square grid' },
  { id: 'stripes', name: 'Diagonal stripes' },
  { id: 'dots', name: 'Polka dots' },
  { id: 'checker', name: 'Checkerboard' },
  { id: 'border', name: 'Decorative border' },
  { id: 'waves', name: 'Waves' },
] as const;

export type PaperStyle = typeof PAPER_STYLES[number]['id'];
export const DEFAULT_PAPER_STYLE: PaperStyle = 'classic';

export function isPaperStyle(value: unknown): value is PaperStyle {
  return PAPER_STYLES.some(({id}) => id === value);
}
