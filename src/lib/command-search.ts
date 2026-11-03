// Matching for the Ctrl+K search's pages and actions (employees use searchEmployees, as everywhere else).
// Pure: tested in command-search.test.ts.

export type Command = { id: string; label: string; keywords?: string };

/**
 * The commands every typed word appears in (in the label or the keywords, any case, at a word's start), best first:
 * those whose label starts with what's typed, then whose label has every word, then the rest in their own order.
 * Nothing typed: all of them, as they are.
 */
export function matchCommands<T extends Command>(commands: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return commands;
  const starts = (text: string, w: string) => text.split(/[^\p{L}\p{N}]+/u).some((part) => part.startsWith(w));
  const rank = (c: T) => {
    const label = c.label.toLowerCase(), all = `${label} ${(c.keywords ?? "").toLowerCase()}`;
    if (!words.every((w) => starts(all, w))) return -1;
    if (label.startsWith(words.join(" "))) return 0;
    return words.every((w) => starts(label, w)) ? 1 : 2;
  };
  return commands.map((c, i) => ({ c, i, r: rank(c) })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c);
}
