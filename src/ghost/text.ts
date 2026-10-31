// Text helpers: grapheme-aware diffing so emoji / combining marks never split.

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

export function graphemes(s: string): string[] {
  if (!s) return [];
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

export interface TextChange {
  start: number; // code-unit offset in the old string
  removed: string;
  inserted: string;
}

/**
 * Minimal single-region diff between `a` (before) and `b` (after), computed on
 * grapheme clusters. `caretAfter` (selectionEnd after the edit) disambiguates
 * repeated characters: an edit always ends where the caret lands.
 */
export function diffText(a: string, b: string, caretAfter: number): TextChange | null {
  if (a === b) return null;
  const A = graphemes(a);
  const B = graphemes(b);

  let ci = 0;
  let acc = 0;
  while (ci < B.length && acc + B[ci].length <= caretAfter) {
    acc += B[ci].length;
    ci++;
  }

  const max = Math.min(A.length, B.length);
  let p = 0;
  while (p < max && A[p] === B[p]) p++;
  let s = 0;
  while (s < max && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;

  s = Math.min(s, B.length - ci);
  p = Math.min(p, A.length - s, B.length - s);

  let start = 0;
  for (let i = 0; i < p; i++) start += A[i].length;
  return {
    start,
    removed: A.slice(p, A.length - s).join(''),
    inserted: B.slice(p, B.length - s).join(''),
  };
}

export const hasVisible = (s: string) => /\S/u.test(s);

/** Offsets of the visible part of `s` (leading/trailing whitespace trimmed). */
export function trimOffsets(s: string): [number, number] {
  const lead = s.length - s.replace(/^\s+/u, '').length;
  const trail = s.length - s.replace(/\s+$/u, '').length;
  return [lead, s.length - trail];
}

/** Short, single-line version of deleted text to show inside a ghost. */
export function ghostLabel(s: string, max = 24): { label: string; count: number } {
  const flat = s.trim().replace(/\s+/gu, ' ');
  const g = graphemes(flat);
  const label = g.length > max ? g.slice(0, max - 2).join('') + '…' : flat;
  return { label, count: Math.min(g.length, max) };
}
