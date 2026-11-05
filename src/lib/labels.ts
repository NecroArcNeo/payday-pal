import { getPref, setPref, usePref } from "@/lib/prefs";

// Aliases: the user's own names for field, category and column labels. The real name never changes;
// an alias only covers it on screen (and in exports), and clearing the alias brings the real name back.
// Keys name the concept, not the place, so one alias shows everywhere that label appears:
// employee columns by column name ("department", "hourly_rate"), custom categories as "custom:<def id>",
// profile sections as "section:<title>", extra-pay categories as "extra:<name>", and table columns
// by what they hold ("date", "hours", "reg_pay"…).

const KEY = "meridian-label-aliases";
export const MAX_ALIAS = 60;
type Aliases = Record<string, string>;

/** The alias for `key`, else its real name. For places outside React (CSV exports). */
export const labelOf = (key: string, name: string) => getPref<Aliases>(KEY, {})[key] || name;

/** Saves an alias. Empty, or the same as the real name, removes it so the real name shows again. */
export function setAlias(key: string, alias: string, name: string) {
  const next = { ...getPref<Aliases>(KEY, {}) };
  const v = alias.trim().slice(0, MAX_ALIAS);
  if (v && v !== name) next[key] = v; else delete next[key];
  setPref(KEY, next);
}

/** Removes an alias, so the real name shows again. */
export function clearAlias(key: string) {
  const next = { ...getPref<Aliases>(KEY, {}) };
  delete next[key];
  setPref(KEY, next);
}

export function useLabels() {
  const [aliases] = usePref<Aliases>(KEY, {});
  return {
    /** The alias for `key`, else its real name. */
    label: (key: string, name: string) => aliases[key] || name,
    aliasOf: (key: string): string | undefined => aliases[key],
    /** Every alias, by key (Settings → Display lists them). */
    aliases,
  };
}
