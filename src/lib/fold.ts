// Which boxes are folded into bars (FoldBox): a per-device list of box ids.

export const FOLD_PREF = "meridian-folded";

export const isFolded = (folded: unknown, id: string) => Array.isArray(folded) && folded.includes(id);

/** The list with `id` folded or not; a bad saved value starts a new list. */
export function withFold(folded: unknown, id: string, fold: boolean): string[] {
  const list = Array.isArray(folded) ? folded.filter((x): x is string => typeof x === "string" && x !== id) : [];
  return fold ? [...list, id] : list;
}
