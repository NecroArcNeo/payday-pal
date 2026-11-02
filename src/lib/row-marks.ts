import type { PayLine } from "@/lib/pay";

// Colours and tags on Time records rows: each kind of record (overtime, things to check, manual pay…) can colour the
// whole row, add a small tag, or show nothing. The choices are a per-device pref, checked by `validMarks`.
// Pure: tested in row-marks.test.ts.

export type MarkKind = "overtime" | "warning" | "manual" | "weekend" | "shift" | "unlocked" | "locked" | "resigned";
export type MarkAs = "row" | "tag" | "off";
export type MarkSetting = { as: MarkAs; colour: MarkColour };
/** `on: false` turns every colour and tag off at once, keeping each kind's choice for when it's turned back on. */
export type MarkSettings = Record<MarkKind, MarkSetting> & { on: boolean };

/** Row tints that read in light and dark (the row gets a light wash of the colour and a stripe down its left edge). */
export const MARK_COLOURS = {
  orange: "oklch(0.72 0.18 50)", red: "oklch(0.63 0.22 25)", amber: "oklch(0.8 0.16 85)", green: "oklch(0.68 0.17 150)",
  blue: "oklch(0.62 0.19 255)", purple: "oklch(0.6 0.2 300)", grey: "oklch(0.62 0.02 260)",
} as const;
/** One of the colours above by name, or any colour the user picked, as "#rrggbb". */
export type MarkColour = keyof typeof MARK_COLOURS | `#${string}`;

/** The CSS colour for a mark colour. */
export function colourCss(c: MarkColour): string {
  return c in MARK_COLOURS ? MARK_COLOURS[c as keyof typeof MARK_COLOURS] : c;
}
const isColour = (c: unknown): c is MarkColour => typeof c === "string" && (c in MARK_COLOURS || /^#[0-9a-f]{6}$/i.test(c));

/** In this order: when a record is several kinds at once and more than one colours the row, the first one wins. */
export const MARKS: Record<MarkKind, { label: string; tag: string; hint: string }> = {
  overtime: { label: "Overtime", tag: "overtime", hint: "Some of the record's hours are paid as overtime" },
  warning: { label: "Things to check", tag: "check", hint: "The record is in the Payroll page's list of things to check (not ones marked fine)" },
  manual: { label: "Manual pay", tag: "manual pay", hint: "The day is paid a fixed amount instead of by its hours" },
  weekend: { label: "Weekend", tag: "weekend", hint: "Worked on a Saturday or Sunday" },
  shift: { label: "Not their usual shift", tag: "other shift", hint: "The record has its own shift, different from the employee's usual one" },
  unlocked: { label: "Unlocked on a locked day", tag: "unlocked", hint: "A day locked as paid, unlocked just for this record" },
  locked: { label: "Locked as paid", tag: "locked", hint: "The day is locked as paid" },
  resigned: { label: "Resigned employee", tag: "resigned", hint: "The employee is marked as resigned" },
};
export const MARK_KINDS = Object.keys(MARKS) as MarkKind[];

export const DEFAULT_MARKS: MarkSettings = {
  on: true,
  overtime: { as: "row", colour: "orange" },
  warning: { as: "tag", colour: "amber" },
  manual: { as: "off", colour: "blue" },
  weekend: { as: "off", colour: "purple" },
  shift: { as: "off", colour: "green" },
  unlocked: { as: "off", colour: "red" },
  locked: { as: "off", colour: "grey" },
  resigned: { as: "tag", colour: "grey" },
};

/** Saved settings with anything unknown (an older version, a hand edit) put back to its default. */
export function validMarks(saved: unknown): MarkSettings {
  const s = (saved && typeof saved === "object" ? saved : {}) as Record<string, Partial<MarkSetting> | undefined> & { on?: unknown };
  const kinds = Object.fromEntries(MARK_KINDS.map((k) => {
    const v = s[k], d = DEFAULT_MARKS[k];
    return [k, {
      as: v?.as === "row" || v?.as === "tag" || v?.as === "off" ? v.as : d.as,
      colour: isColour(v?.colour) ? v.colour : d.colour,
    }];
  })) as Record<MarkKind, MarkSetting>;
  return { ...kinds, on: typeof s.on === "boolean" ? s.on : DEFAULT_MARKS.on };
}

export type MarkFacts = {
  work_date: string;
  /** The record's own shift (null = the employee's usual one) and the employee's usual shift. */
  shift_id: string | null;
  usualShiftId: string | null | undefined;
  pay_override: number | string | null;
  unlocked?: boolean | null | undefined;
  employeeActive: boolean | null | undefined;
  /** Its pay line (undefined while pay is still being worked out). */
  line: PayLine | undefined;
  lockedThrough: string | null;
  /** Names of the open warnings on this record, if any. */
  warnings: string[];
};

/** Which kinds a record is, in the order of MARKS, each with a detail for its tooltip. */
export function recordKinds(f: MarkFacts): { kind: MarkKind; detail: string }[] {
  const out: { kind: MarkKind; detail: string }[] = [];
  const add = (kind: MarkKind, detail: string) => out.push({ kind, detail });
  if (f.line && f.line.overtime > 0) add("overtime", `${Number(f.line.overtime.toFixed(2))} h overtime${f.line.weekend ? " (weekend)" : ""}`);
  if (f.warnings.length) add("warning", f.warnings.join(", "));
  if (f.pay_override !== null && f.pay_override !== undefined && f.pay_override !== "") add("manual", MARKS.manual.hint);
  const dow = new Date(`${f.work_date}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) add("weekend", dow === 0 ? "Sunday" : "Saturday");
  if (f.shift_id && f.shift_id !== f.usualShiftId) add("shift", MARKS.shift.hint);
  const lockedDay = !!f.lockedThrough && f.work_date <= f.lockedThrough;
  if (lockedDay && f.unlocked) add("unlocked", MARKS.unlocked.hint);
  if (lockedDay && !f.unlocked) add("locked", `Days up to ${f.lockedThrough} are locked as paid`);
  if (f.employeeActive === false) add("resigned", MARKS.resigned.hint);
  return out;
}

export type RowMark = {
  /** The colour of the row, from the first kind set to colour rows; null when none is. */
  row: { kind: MarkKind; colour: MarkColour; detail: string } | null;
  tags: { kind: MarkKind; colour: MarkColour; detail: string }[];
};

/**
 * How a record is shown under these settings. A kind that would colour the row when another kind already has shows
 * as a tag instead, so nothing is lost. With the whole feature off, nothing is shown.
 */
export function markRecord(f: MarkFacts, settings: MarkSettings): RowMark {
  if (!settings.on) return { row: null, tags: [] };
  let row: RowMark["row"] = null;
  const tags: RowMark["tags"] = [];
  for (const { kind, detail } of recordKinds(f)) {
    const s = settings[kind];
    if (s.as === "off") continue;
    if (s.as === "row" && !row) row = { kind, colour: s.colour, detail };
    else tags.push({ kind, colour: s.colour, detail });
  }
  return { row, tags };
}
