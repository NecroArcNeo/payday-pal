import { useMemo, type CSSProperties } from "react";
import { Palette } from "lucide-react";
import { btnGhost } from "@/components/AppShell";
import { Switch } from "@/components/ui/switch";
import { useRecordWarnings } from "@/components/RecordWarnings";
import { useShifts, usePayRates, useWeekRecords, type Employee, type RecordWithEmp } from "@/lib/payroll";
import type { PayLine } from "@/lib/pay";
import { usePref } from "@/lib/prefs";
import { CHECK_NAMES } from "@/lib/record-checks";
import {
  colourCss, DEFAULT_MARKS, MARK_COLOURS, MARK_KINDS, MARKS, markRecord, validMarks,
  type MarkAs, type MarkColour, type MarkKind, type MarkSettings, type RowMark,
} from "@/lib/row-marks";

// Colours and tags on the Time records table (the rules are in src/lib/row-marks.ts). The table asks `useRowMarks`
// for each row's mark, gives the row `markedRow(...)` and puts `<MarkTags>` next to the date; `RowMarksButton` in the
// table's header changes what's shown, remembered on this device.

const PREF = "meridian-row-marks";

export function useMarkSettings() {
  const [saved, setSaved] = usePref<unknown>(PREF, DEFAULT_MARKS);
  return [validMarks(saved), (s: MarkSettings) => setSaved(s)] as const;
}

/** A function from a row to how it's shown. Warnings use the whole weeks' records (a long day can be two records). */
export function useRowMarks(rows: RecordWithEmp[], employees: Employee[], pay: Map<string, PayLine> | undefined, lockedThrough: string | null) {
  const [settings] = useMarkSettings();
  const { data: shifts = [] } = useShifts();
  const { data: rates } = usePayRates();
  // Turned off: no rows, so the whole-week load and the checks are skipped too.
  const week = useWeekRecords(settings.on ? rows : NONE);
  const checked = useRecordWarnings(week ?? NONE, employees, shifts, rates);
  const usual = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const warnings = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const w of checked.open) for (const id of w.recordIds) m.set(id, [...(m.get(id) ?? []), CHECK_NAMES[w.kind]]);
    return m;
  }, [checked.open]);
  return (r: RecordWithEmp): RowMark => {
    const e = usual.get(r.employee_id);
    return markRecord({
      work_date: r.work_date, shift_id: r.shift_id, usualShiftId: e?.shift_id, pay_override: r.pay_override, unlocked: r.unlocked,
      employeeActive: e?.active, line: pay?.get(r.id), lockedThrough, warnings: warnings.get(r.id) ?? [],
    }, settings);
  };
}
// One empty list, so "no records yet" doesn't look like a new list on every render (that would redo the checks).
const NONE: RecordWithEmp[] = [];

/** The row's class, colour and tooltip: a wash of the colour and a stripe down its left edge (in styles.css). */
export function markedRow(mark: RowMark): { className: string; style?: CSSProperties; title?: string } {
  if (!mark.row) return { className: "" };
  return { className: "marked-row", style: { "--row-mark": colourCss(mark.row.colour) } as CSSProperties, title: `${MARKS[mark.row.kind].label}: ${mark.row.detail}` };
}

export function MarkTags({ tags }: { tags: RowMark["tags"] }) {
  return (
    <>
      {tags.map((t) => <Tag key={t.kind} colour={t.colour} title={`${MARKS[t.kind].label}: ${t.detail}`}>{MARKS[t.kind].tag}</Tag>)}
    </>
  );
}

function Tag({ colour, title, children }: { colour: MarkColour; title?: string; children: React.ReactNode }) {
  const c = colourCss(colour);
  return (
    <span title={title} className="ml-2 inline-block rounded border px-1.5 py-px align-middle font-body text-[10px] font-medium leading-4"
      style={{ color: `color-mix(in oklch, ${c} 70%, var(--foreground))`, backgroundColor: `color-mix(in oklch, ${c} 14%, transparent)`, borderColor: `color-mix(in oklch, ${c} 45%, transparent)` }}>
      {children}
    </span>
  );
}

/** The header's key to the row colours in use, and the "Colours" button that opens `MarksPanel`. */
export function RowMarksButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [settings] = useMarkSettings();
  const rowKinds = settings.on ? MARK_KINDS.filter((k) => settings[k].as === "row") : [];
  return (
    <>
      {rowKinds.map((k) => (
        <span key={k} className="flex items-center gap-1.5 text-xs text-muted-foreground" title={MARKS[k].hint}>
          <span className="h-3 w-3 rounded-sm" style={{ background: colourCss(settings[k].colour) }} />{MARKS[k].label}
        </span>
      ))}
      <button type="button" onClick={onToggle} className={btnGhost} aria-expanded={open} title="Choose which records colour their row or get a tag">
        <Palette className="mr-1 inline h-4 w-4" />Colours{!settings.on && <span className="ml-1 text-muted-foreground">(off)</span>}
      </button>
    </>
  );
}

const AS: [MarkAs, string][] = [["row", "Colour row"], ["tag", "Tag"], ["off", "Nothing"]];

export function MarksPanel({ onClose }: { onClose: () => void }) {
  const [settings, save] = useMarkSettings();
  const set = (k: MarkKind, patch: Partial<MarkSettings[MarkKind]>) => save({ ...settings, [k]: { ...settings[k], ...patch } });
  return (
    <div className="border-b border-border bg-secondary/40 px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Changes show straight away and are remembered on this computer. If a record is several of these, the first colour in the list wins and the rest show as tags.</p>
        <span className="flex gap-2">
          <button type="button" onClick={() => save(DEFAULT_MARKS)} className={btnGhost}>Defaults</button>
          <button type="button" onClick={onClose} className={btnGhost}>Done</button>
        </span>
      </div>
      <label className="mb-2 flex w-fit cursor-pointer items-center gap-2.5 text-sm font-medium">
        <Switch checked={settings.on} onCheckedChange={(on) => save({ ...settings, on })} />
        Colour rows and show tags
      </label>
      {/* Turned off, the choices below are kept (dimmed) for when it's turned back on. */}
      <ul className={`divide-y divide-border ${settings.on ? "" : "pointer-events-none opacity-40"}`} aria-disabled={!settings.on}>
        {MARK_KINDS.map((k) => {
          const s = settings[k];
          return (
            <li key={k} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2 text-sm">
              <span className="w-52 shrink-0" title={MARKS[k].hint}>
                {MARKS[k].label}
                <span className="block text-[11px] text-muted-foreground">{MARKS[k].hint}</span>
              </span>
              <span className="flex rounded-lg bg-background p-0.5 text-xs ring-1 ring-border" role="radiogroup" aria-label={`${MARKS[k].label}: how to show it`}>
                {AS.map(([v, l]) => (
                  <button key={v} type="button" role="radio" aria-checked={s.as === v} onClick={() => set(k, { as: v })}
                    className={`rounded-md px-2.5 py-1 ${s.as === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{l}</button>
                ))}
              </span>
              <span className={`flex gap-1.5 ${s.as === "off" ? "opacity-30" : ""}`} role="radiogroup" aria-label={`${MARKS[k].label}: colour`}>
                {(Object.keys(MARK_COLOURS) as (keyof typeof MARK_COLOURS)[]).map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={s.colour === c} aria-label={c} title={c} disabled={s.as === "off"} onClick={() => set(k, { colour: c })}
                    className={`h-5 w-5 rounded-full ring-offset-2 ring-offset-background ${s.colour === c ? "ring-2 ring-foreground" : ""}`} style={{ background: MARK_COLOURS[c] }} />
                ))}
                <OtherColour colour={s.colour} disabled={s.as === "off"} onPick={(c) => set(k, { colour: c })} />
              </span>
              {s.as === "tag" && <Tag colour={s.colour}>{MARKS[k].tag}</Tag>}
              {s.as === "row" && <span className="rounded px-2 py-0.5 text-xs" style={{ background: `color-mix(in oklch, ${colourCss(s.colour)} 18%, transparent)`, boxShadow: `inset 3px 0 0 ${colourCss(s.colour)}` }}>row like this</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Any other colour, through the computer's own colour picker (a native `<input type="color">`, so nothing to load).
 * The round button shows the picked colour, or a colour wheel until one is picked.
 */
function OtherColour({ colour, disabled, onPick }: { colour: MarkColour; disabled: boolean; onPick: (c: MarkColour) => void }) {
  const custom = colour.startsWith("#");
  return (
    <label title="Pick any colour" role="radio" aria-checked={custom} aria-label="Other colour"
      className={`relative h-5 w-5 rounded-full ring-offset-2 ring-offset-background ${custom ? "ring-2 ring-foreground" : ""} ${disabled ? "" : "cursor-pointer"}`}
      style={{ background: custom ? colour : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}>
      <input type="color" disabled={disabled} value={custom ? colour : "#ff8800"} onChange={(e) => onPick(e.target.value as MarkColour)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
    </label>
  );
}
