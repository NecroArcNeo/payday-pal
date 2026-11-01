import { useMemo, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isoDate } from "@/lib/payroll";
import { localDayOrder, readTypedDate, showDate } from "@/lib/typed-date";

// Classes that place or size the control go on its wrapper (so the calendar button sits inside the box); the rest style
// the text box itself.
const LAYOUT = /^!?(m[trblxy]?-|-m[trblxy]?-|w-|min-w-|max-w-|block$|inline-block$|flex-1$|shrink|grow)/;
const pretty = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/**
 * A date box that reads the date as typed (src/lib/typed-date.ts): 1101, 11/1, 11-01-26, Nov 1, today… with a
 * calendar button. Use it instead of <input type="date">. `value` and `onChange` are YYYY-MM-DD ("" when empty), as
 * with the browser's date box; `onChange` gets a date as soon as what's typed reads as one, and leaving the box
 * shows it in full. Text that isn't a date is put back to the last good date on leaving.
 */
export function DateInput({ value, onChange, className = "", min, max, required, disabled, placeholder, title, id, "aria-label": ariaLabel }: {
  value: string; onChange: (iso: string) => void; className?: string | undefined; min?: string | undefined; max?: string | undefined;
  required?: boolean | undefined; disabled?: boolean | undefined; placeholder?: string | undefined; title?: string | undefined; id?: string | undefined; "aria-label"?: string | undefined;
}) {
  const order = useMemo(localDayOrder, []);
  // While typing, the box shows the text as typed; otherwise the value, written out the same way each time.
  const [typing, setTyping] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const read = typing === null ? null : readTypedDate(typing, isoDate(new Date()), order);
  const bad = typing !== null && typing.trim() !== "" && !read;
  const outside = !!read && ((!!min && read < min) || (!!max && read > max));

  const classes = className.split(/\s+/).filter(Boolean);
  const wrap = classes.filter((c) => LAYOUT.test(c)).join(" ");
  const box = classes.filter((c) => !LAYOUT.test(c)).join(" ");

  // The date when the box was entered: put back if what's typed by the end isn't a date (or on Escape).
  const start = useRef(value);
  const readNow = (text: string) => readTypedDate(text, isoDate(new Date()), order);
  // Up to 3 digits is usually a date still being typed ("1" → "11" → "110" → "1101"), so it's only taken on leaving the
  // box or Enter; anything longer, or with a separator or a word, is taken as it's typed, so the page follows along.
  const unfinished = (text: string) => /^\d{1,3}$/.test(text.trim());
  const type = (text: string) => {
    setTyping(text);
    const iso = readNow(text);
    if (iso && !unfinished(text)) { if (iso !== value) onChange(iso); }
    else if (!text.trim() && value && !required) onChange("");
  };
  // Enter or leaving the box completes the date: takes what's typed, or puts the starting date back if it isn't a date,
  // and shows it written out in full. Escape always puts the starting date back.
  const cancelled = useRef(false);
  const finish = () => {
    if (typing !== null && !cancelled.current) {
      const next = (typing.trim() ? readNow(typing) : required ? null : "") ?? start.current;
      if (next !== value) onChange(next);
      start.current = next;
    }
    cancelled.current = false;
    setTyping(null);
  };

  return (
    <span className={`relative inline-block align-middle ${wrap}`}>
      <input id={id} type="text" inputMode="numeric" autoComplete="off" spellCheck={false} size={12}
        className={`${box} w-full !pr-8 ${bad || outside ? "ring-2 ring-destructive" : ""}`}
        value={typing ?? (value ? showDate(value, order) : "")}
        placeholder={placeholder ?? (order === "mdy" ? "mm/dd/yyyy" : "dd/mm/yyyy")}
        title={title ?? "Type a date any way: 1101, 11/1, 11/01/2026, Nov 1, today…"}
        aria-label={ariaLabel} aria-invalid={bad || outside || undefined} required={required} disabled={disabled}
        onChange={(e) => type(e.target.value)}
        onFocus={(e) => { start.current = value; e.target.select(); }}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === "Escape" && typing !== null) { cancelled.current = true; if (start.current !== value) onChange(start.current); (e.target as HTMLInputElement).blur(); }
          // Enter after typing completes the date and stays in the box; it doesn't also submit the form or save the row,
          // which would still see the old date. Enter again (nothing typed since) does those as usual.
          if (e.key === "Enter" && typing !== null) {
            e.preventDefault();
            e.stopPropagation();
            finish();
            const el = e.currentTarget;
            requestAnimationFrame(() => el.select());
          }
          // Arrow keys move a day (a week with Shift), as many date boxes do.
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && value) {
            e.preventDefault();
            const d = new Date(`${value}T00:00:00Z`);
            d.setUTCDate(d.getUTCDate() + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 7 : 1));
            const next = d.toISOString().slice(0, 10);
            onChange(next);
            setTyping(showDate(next, order));
          }
        }} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" disabled={disabled} tabIndex={-1} aria-label="Pick from a calendar"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40">
            <CalendarDays className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar mode="single" captionLayout="dropdown" startMonth={new Date(1900, 0)} endMonth={new Date(2200, 11)}
            {...(value ? { selected: new Date(`${value}T00:00:00`), defaultMonth: new Date(`${value}T00:00:00`) } : {})}
            disabled={[...(min ? [{ before: new Date(`${min}T00:00:00`) }] : []), ...(max ? [{ after: new Date(`${max}T00:00:00`) }] : [])]}
            onSelect={(d) => { if (d) { onChange(isoDate(d)); setTyping(null); setOpen(false); } }} />
        </PopoverContent>
      </Popover>
      {typing !== null && typing.trim() !== "" && (
        <span role="status" className={`pointer-events-none absolute left-0 top-full z-20 mt-1 whitespace-nowrap rounded-md px-2 py-1 text-xs shadow-md ring-1 ring-border ${bad || outside ? "bg-destructive text-destructive-foreground" : "bg-popover text-popover-foreground"}`}>
          {bad ? "Can't read this as a date" : outside ? `${pretty(read!)}: ${min && read! < min ? `before ${pretty(min)}` : `after ${pretty(max!)}`}` : pretty(read!)}
        </span>
      )}
    </span>
  );
}
