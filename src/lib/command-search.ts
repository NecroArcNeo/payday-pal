// Matching for the Ctrl+K search's pages and actions (employees use searchEmployees, as everywhere else).
// Pure: tested in command-search.test.ts.

export type Command = { id: string; label: string; keywords?: string };

/**
 * Edits between two words: letters added, removed, changed, or two side by side swapped ("pyaroll"), each counting
 * one (the "optimal string alignment" distance, Levenshtein's plus swaps).
 */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/** Typos allowed in a typed word: none under 4 letters (too many short words are a typo apart), 1, or 2 from 7. */
const allowed = (w: string) => (w.length < 4 ? 0 : w.length < 7 ? 1 : 2);

/**
 * How well a typed word fits a text: 0 when one of its words starts with it, 1 when it does with a typo or two
 * (the typed word against the start of a word, give or take a letter, with the first letter right: people rarely get
 * that one wrong, and without it "lock" would find "clock"), -1 when it doesn't.
 */
function fit(text: string, w: string): 0 | 1 | -1 {
  const parts = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.some((p) => p.startsWith(w))) return 0;
  const max = allowed(w);
  if (!max) return -1;
  const near = parts.some((p) => p[0] === w[0] && [w.length - 1, w.length, w.length + 1].some((n) => n <= p.length && editDistance(w, p.slice(0, n)) <= max));
  return near ? 1 : -1;
}

/**
 * The commands every typed word appears in (in the label or the keywords, any case, at a word's start, or nearly:
 * "payrol", "emplyee", "holliday"), best first: those whose label starts with what's typed, then whose label has every
 * word, then keyword matches, then matches with typos (in the label, then in the keywords); ties in their own order. Nothing typed: all of them.
 */
export function matchCommands<T extends Command>(commands: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return commands;
  const rank = (c: T) => {
    const label = c.label.toLowerCase(), all = `${label} ${(c.keywords ?? "").toLowerCase()}`;
    const fits = words.map((w) => fit(all, w));
    if (fits.includes(-1)) return -1;
    if (fits.includes(1)) return words.every((w) => fit(label, w) >= 0) ? 3 : 4;
    if (label.startsWith(words.join(" "))) return 0;
    return words.every((w) => fit(label, w) === 0) ? 1 : 2;
  };
  return commands.map((c, i) => ({ c, i, r: rank(c) })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c);
}
