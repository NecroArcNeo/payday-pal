import { useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { StatCard, btnGhost, inputCls } from "@/components/AppShell";
import { DataTable } from "@/components/DataTable";
import { DateInput } from "@/components/DateInput";
import { storeFor, useDataMode } from "@/lib/db/mode";
import { centsAddingUp } from "@/lib/amount";
import { downloadBlob } from "@/lib/db/backups";
import { isoDate, money, useAdjustments, useEmployees, usePayRates, usePayrollSettings, useShifts } from "@/lib/payroll";
import { payByRecord, weekEnd, weekStart } from "@/lib/pay";
import { usePref } from "@/lib/prefs";
import {
  autoGroup, buildReport, compareReports, GROUPS, METRICS, previousRange, rangeLabel, REPORT_RANGES, reportRange, sameTimeLastYear, SPLITS,
  type CompareRow, type GroupBy, type Metric, type Report, type ReportRange, type SplitBy, type Unit,
} from "@/lib/report";

// A chart of one metric over any range, with the choices to change it, summary cards and the numbers as a table.
// The Reports page, the employee profile and the Dashboard all use it; the maths is buildReport (src/lib/report.ts).

export type ChartKind = "bar" | "stacked" | "line" | "area" | "pie";
const KINDS: Record<ChartKind, string> = { bar: "Bars", stacked: "Stacked bars", line: "Line", area: "Area", pie: "Pie" };
/** What the period is compared with: "off" still compares the total with the previous period (the last card). */
export type Compare = "off" | "previous" | "last_year" | "custom";
const COMPARES: Record<Compare, string> = { off: "No", previous: "Previous period", last_year: "Same time last year", custom: "Chosen dates…" };
export type ReportSettings = {
  range: ReportRange | "custom"; from: string; to: string; metric: Metric; kind: ChartKind; group: GroupBy | "auto"; split: SplitBy;
  compare: Compare; cmpFrom: string; cmpTo: string;
};
export const DEFAULT_SETTINGS: ReportSettings = { range: "last_3_months", from: "", to: "", metric: "pay", kind: "bar", group: "auto", split: "none", compare: "off", cmpFrom: "", cmpTo: "" };

// Up to 9 series (8 people and everyone else): the theme's 5 chart colours, then 4 more that read in light and dark.
const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-4)", "var(--chart-5)", "var(--chart-3)", "oklch(0.62 0.19 330)", "oklch(0.65 0.15 150)", "oklch(0.6 0.2 25)", "oklch(0.6 0.03 260)"];
/** The compared period is drawn in grey, so this period stands out. */
const THEN_COLOUR = "oklch(0.65 0.02 260)";

export const formatValue = (v: number, unit: Unit) =>
  unit === "money" ? money(v) : unit === "hours" ? `${Number(v.toFixed(2))} h` : String(Math.round(v * 100) / 100);
const short = (v: number, unit: Unit) => {
  const k = Math.abs(v) >= 1000 ? `${Number((v / 1000).toFixed(1))}k` : String(Number(v.toFixed(1)));
  return unit === "money" ? `$${k}` : unit === "hours" ? `${k} h` : k;
};
/** How much `a` changed from `b`, as a fraction; null when there's nothing to compare with. */
const change = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : (a - b) / Math.abs(b));
const pct = (c: number) => `${c >= 0 ? "+" : ""}${(c * 100).toFixed(1)}%`;

/** Settings as saved, with anything unknown (from an older version, or edited by hand) put back to its default. */
function validSettings(s: Partial<ReportSettings> | null | undefined, base: ReportSettings): ReportSettings {
  const v = { ...base, ...(s ?? {}) };
  const ok = <T extends string>(x: string, all: Record<T, unknown>, d: T): T => (x in all ? (x as T) : d);
  const day = (x: unknown) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : "");
  return {
    range: v.range === "custom" ? "custom" : ok(v.range, REPORT_RANGES, base.range as ReportRange),
    from: day(v.from), to: day(v.to),
    metric: ok(v.metric, METRICS, base.metric), kind: ok(v.kind, KINDS, base.kind),
    group: v.group === "auto" ? "auto" : ok(v.group, GROUPS, "month"), split: ok(v.split, SPLITS, base.split),
    compare: ok(v.compare, COMPARES, base.compare), cmpFrom: day(v.cmpFrom), cmpTo: day(v.cmpTo),
  };
}

/** Records for whole Mon–Sun weeks around [from, to] (weekly overtime and salary need the whole week), and extra pay. */
function useReportData(from: string, to: string) {
  const mode = useDataMode();
  const loadFrom = weekStart(from), loadTo = weekEnd(to);
  const records = useQuery({
    queryKey: ["records", "report", loadFrom, loadTo, mode],
    queryFn: () => storeFor(mode).listRecordsMatching({ from: loadFrom, to: loadTo }),
    placeholderData: keepPreviousData,
  });
  const adjustments = useAdjustments(from, to);
  return { records: records.data, adjustments: adjustments.data, fetching: records.isFetching };
}

export function ReportChart({ prefKey, employeeIds, single = false, compact = false, defaults = DEFAULT_SETTINGS, height = 320, subject }: {
  /** Where the choices are remembered on this device (each place keeps its own). */
  prefKey: string;
  /** Only these people; everyone when left out. */
  employeeIds?: string[] | undefined;
  /** About one person: splitting by employee or department is left out. */
  single?: boolean | undefined;
  /** Just the chart, with `defaults` and no choices, cards or table (the Dashboard's). */
  compact?: boolean | undefined;
  defaults?: ReportSettings | undefined;
  height?: number | undefined;
  /** Who the chart is about ("Everyone", a name), for the title of a saved picture or PDF. */
  subject?: string | undefined;
}) {
  const [saved, setSaved] = usePref<Partial<ReportSettings> | null>(`meridian-report:${prefKey}`, null);
  const s = compact ? defaults : validSettings(saved, defaults);
  const set = (patch: Partial<ReportSettings>) => setSaved({ ...s, ...patch });
  const today = isoDate(new Date());
  const { from, to } = s.range === "custom" && s.from && s.to && s.from <= s.to ? { from: s.from, to: s.to } : reportRange(s.range === "custom" ? "last_3_months" : s.range, today);
  const groupBy = s.group === "auto" ? autoGroup(from, to) : s.group;
  const comparing = !compact && s.compare !== "off";
  // Comparing draws two totals side by side, so it doesn't split.
  const split: SplitBy = comparing || s.metric === "reg_ot" || (single && (s.split === "employee" || s.split === "department")) ? "none" : s.split;
  const against = s.compare === "last_year" ? sameTimeLastYear(from, to)
    : s.compare === "custom" && s.cmpFrom && s.cmpTo && s.cmpFrom <= s.cmpTo ? { from: s.cmpFrom, to: s.cmpTo }
    : previousRange(from, to);

  // Two loads: this period and the one it's compared with. The Dashboard's chart has no comparison, so it asks for
  // the same range twice, which React Query answers from one load (same query key).
  const now = useReportData(from, to);
  const then = useReportData(compact ? from : against.from, compact ? to : against.to);
  const { data: employees } = useEmployees();
  const { data: shifts } = useShifts();
  const { data: rates } = usePayRates();
  const { data: settings } = usePayrollSettings();
  const idsKey = employeeIds?.join(",") ?? "";

  const result = useMemo(() => {
    if (!now.records || !now.adjustments || !then.records || !then.adjustments || !employees || !shifts || !settings) return null;
    const rules = { threshold: settings.ot_threshold, otMultiplier: settings.ot_multiplier, weekendOvertime: settings.weekend_overtime };
    const ids = idsKey ? idsKey.split(",") : undefined;
    const common = { employees, shifts, rates, rules, groupBy, metric: s.metric, splitBy: split, employeeIds: ids };
    const report = (records: NonNullable<typeof now.records>, adjustments: NonNullable<typeof now.adjustments>, r: { from: string; to: string }) =>
      buildReport({ ...common, records, adjustments, pay: payByRecord(records, employees, shifts, rules, rates), ...r });
    const a = report(now.records, now.adjustments, { from, to });
    const b = compact ? null : report(then.records, then.adjustments, against);
    return { now: a, before: b, rows: comparing && b ? compareReports(a, b) : null };
  }, [now.records, now.adjustments, then.records, then.adjustments, employees, shifts, rates, settings, idsKey, groupBy, s.metric, split, from, to, against.from, against.to, compact, comparing]);

  const chartBox = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);

  const report = result?.now;
  const rows = result?.rows ?? null;
  const multi = (report?.series.length ?? 0) > 1;
  const additive = s.metric !== "per_hour";
  // Stacking and pies need several series that add up; a comparison is two periods side by side.
  const kind: ChartKind = (s.kind === "pie" || s.kind === "stacked") && (comparing || !multi || !additive) ? "bar" : s.kind;
  const nowName = rangeLabel(from, to), thenName = rangeLabel(against.from, against.to);

  const controls = !compact && (
    <div className="flex flex-wrap items-end gap-3">
      <Choice label="Show" value={s.metric} onChange={(v) => set({ metric: v as Metric })} options={Object.entries(METRICS).map(([k, m]) => [k, m.label])} />
      <Choice label="Chart" value={s.kind} onChange={(v) => set({ kind: v as ChartKind })} options={Object.entries(KINDS).filter(([k]) => (k !== "pie" && k !== "stacked") || (!comparing && multi && additive) || s.kind === k).map(([k, l]) => [k, l])} />
      <Choice label="Period" value={s.range} onChange={(v) => set(v === "custom" ? { range: "custom", from: s.from || from, to: s.to || to } : { range: v as ReportRange })}
        options={[...Object.entries(REPORT_RANGES), ["custom", "Choose dates…"]]} />
      {s.range === "custom" && <Dates from={s.from || from} to={s.to || to} onChange={(f, t) => set({ from: f, to: t })} label="Report" />}
      <Choice label="Per" value={s.group} onChange={(v) => set({ group: v as GroupBy | "auto" })} options={[["auto", `Auto (${GROUPS[autoGroup(from, to)].toLowerCase()})`], ...Object.entries(GROUPS)]} />
      {!comparing && s.metric !== "reg_ot" && (
        <Choice label="Split by" value={split} onChange={(v) => set({ split: v as SplitBy })}
          options={Object.entries(SPLITS).filter(([k]) => !single || k === "none" || k === "shift")} />
      )}
      <Choice label="Compare with" value={s.compare} onChange={(v) => set(v === "custom" ? { compare: "custom", cmpFrom: s.cmpFrom || against.from, cmpTo: s.cmpTo || against.to } : { compare: v as Compare })}
        options={Object.entries(COMPARES)} />
      {s.compare === "custom" && <Dates from={s.cmpFrom || against.from} to={s.cmpTo || against.to} onChange={(f, t) => set({ cmpFrom: f, cmpTo: t })} label="Compare" />}
    </div>
  );

  if (!report || !result) return <>{controls}<div className="glass-panel grid place-items-center text-sm text-muted-foreground" style={{ height }}>Loading…</div></>;

  // Recharts reads keys with dots as paths, so series get plain keys (s0, s1…) and their names go in the config.
  // When comparing there are two: this period (s0) and the compared one (s1).
  const seriesNames = rows ? [nowName, thenName] : report.series.map((x) => x.label);
  const keys = seriesNames.map((_, i) => `s${i}`);
  const config: ChartConfig = Object.fromEntries(seriesNames.map((label, i) => [keys[i]!, { label, color: rows && i === 1 ? THEN_COLOUR : PALETTE[i % PALETTE.length]! }]));
  const span = (b: { from: string; to: string }) => (b.from === b.to ? b.from : `${b.from} – ${b.to}`);
  const data = rows
    ? rows.map((r) => ({ label: (r.now ?? r.then)!.label, range: `${r.now ? r.now.label : "—"} vs ${r.then ? r.then.label : "—"}`, s0: r.a, s1: r.b }))
    : report.buckets.map((b, bi) => ({ label: b.label, range: span(b), ...Object.fromEntries(keys.map((k, si) => [k, report.values[bi]![si]!])) }));
  const empty = rows ? rows.every((r) => !r.a && !r.b) : report.values.every((row) => row.every((v) => v === 0));
  const unit = report.unit;
  const stacked = !rows && (kind === "stacked" || s.metric === "reg_ot");
  const axis = { tickLine: false, axisLine: false, tickMargin: 8 } as const;
  const tooltip = <ChartTooltip cursor={kind !== "line"} content={<ValueTooltip unit={unit} config={config} sum={!rows && multi && additive} />} />;
  const legend = multi || rows ? <ChartLegend content={<ChartLegendContent />} /> : null;

  const chart = kind === "pie" ? (
    <PieChart>
      {tooltip}
      <Pie data={report.series.map((x, i) => ({ name: keys[i]!, value: report.seriesTotals[i]! }))} dataKey="value" nameKey="name" innerRadius="45%" strokeWidth={2}>
        {keys.map((k) => <Cell key={k} fill={`var(--color-${k})`} />)}
      </Pie>
      <ChartLegend content={<ChartLegendContent nameKey="name" />} />
    </PieChart>
  ) : kind === "line" ? (
    <LineChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
      <CartesianGrid vertical={false} /><XAxis dataKey="label" {...axis} minTickGap={16} /><YAxis {...axis} width={56} tickFormatter={(v: number) => short(v, unit)} />
      {tooltip}{legend}
      {keys.map((k, i) => <Line key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={2} dot={data.length <= 31} {...(rows && i === 1 ? { strokeDasharray: "5 4" } : {})} />)}
    </LineChart>
  ) : kind === "area" ? (
    <AreaChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
      <CartesianGrid vertical={false} /><XAxis dataKey="label" {...axis} minTickGap={16} /><YAxis {...axis} width={56} tickFormatter={(v: number) => short(v, unit)} />
      {tooltip}{legend}
      {keys.map((k) => <Area key={k} dataKey={k} type="monotone" {...(additive && !rows ? { stackId: "a" } : {})} stroke={`var(--color-${k})`} fill={`var(--color-${k})`} fillOpacity={0.25} />)}
    </AreaChart>
  ) : (
    <BarChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
      <CartesianGrid vertical={false} /><XAxis dataKey="label" {...axis} minTickGap={8} /><YAxis {...axis} width={56} tickFormatter={(v: number) => short(v, unit)} />
      {tooltip}{legend}
      {keys.map((k, i) => <Bar key={k} dataKey={k} fill={`var(--color-${k})`} {...(stacked ? { stackId: "a" } : {})}
        radius={stacked ? (i === keys.length - 1 ? [4, 4, 0, 0] : 0) : 4} />)}
    </BarChart>
  );

  const body = (
    <div className="relative" ref={chartBox}>
      <ChartContainer config={config} className="!aspect-auto w-full" style={{ height }}>{chart}</ChartContainer>
      {empty && <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted-foreground">No records from {from} to {to}{rows ? ` or ${against.from} to ${against.to}` : ""}.</div>}
      {(now.fetching || then.fetching) && <div className="absolute right-2 top-2 text-[11px] text-muted-foreground">Updating…</div>}
    </div>
  );
  if (compact) return body;

  const grid = numbersGrid(report, result.before, rows, additive, s.metric);
  const title = `${METRICS[s.metric].label}${subject ? ` · ${subject}` : ""}`;
  const subtitle = `${nowName}, per ${groupBy}${split !== "none" ? `, by ${SPLITS[split].toLowerCase()}` : ""}${rows ? `, compared with ${thenName}` : ""}`;
  const fileName = `report_${from}_${to}${rows ? `_vs_${against.from}_${against.to}` : ""}`;

  // The picture and PDF are made from the chart as drawn: the SVG Recharts drew, plus a title and the legend.
  const save = async (as: "png" | "pdf") => {
    const el = chartBox.current?.querySelector<HTMLElement>("[data-chart]");
    if (!el || saving) return;
    setSaving(true);
    try {
      const { chartCanvas, canvasPng } = await import("@/lib/export/chart-image");
      const showLegend = multi || rows || kind === "pie";
      const canvas = await chartCanvas(el, title, subtitle, showLegend ? keys.map((k, i) => ({ label: seriesNames[i]!, cssColor: `var(--color-${k})` })) : []);
      if (as === "png") downloadBlob(await canvasPng(canvas), `${fileName}.png`);
      else {
        const { canvasMeasure, chartPdf, plainSheet } = await import("@/lib/export/pdf");
        const lines = [[title], [subtitle], grid.head, ...[...grid.rows, grid.foot].map((r) => r.map((c) => shown(c, unit)))];
        const table = plainSheet(lines, 2, canvasMeasure(), grid.right);
        downloadBlob(new Blob([chartPdf(canvas, title, table) as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), `${fileName}.pdf`);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {controls}
      <p className="text-xs text-muted-foreground">{METRICS[s.metric].hint}. {from} to {to}, per {groupBy}.{rows ? ` Compared with ${against.from} to ${against.to}, ${groupBy} by ${groupBy} in order.` : ""}</p>
      <Cards report={report} before={result.before} beforeLabel={s.compare === "off" || s.compare === "previous" ? "Previous period" : s.compare === "last_year" ? "Same time last year" : "Compared period"}
        groupBy={groupBy} additive={additive} today={today} />
      <div className="glass-panel p-4">
        <div className="mb-2 flex justify-end gap-2">
          <button type="button" onClick={() => save("png")} disabled={saving} className={btnGhost} title="Save the chart as a PNG picture">Save picture</button>
          <button type="button" onClick={() => save("pdf")} disabled={saving} className={btnGhost} title="Save the chart and its numbers as a PDF">Save PDF</button>
        </div>
        {body}
      </div>
      <NumbersTable grid={grid} unit={unit} prefKey={prefKey} fileName={fileName} />
    </div>
  );
}

function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="text-sm">
      <span className="label-mono">{label}</span>
      <select className={`${inputCls} mt-1 !w-auto`} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    </label>
  );
}

function Dates({ from, to, onChange, label }: { from: string; to: string; onChange: (from: string, to: string) => void; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <DateInput className={`${inputCls} max-w-[10rem]`} value={from} onChange={(v) => onChange(v, to)} aria-label={`${label} from`} />
      <span className="text-muted-foreground">→</span>
      <DateInput className={`${inputCls} max-w-[10rem]`} value={to} onChange={(v) => onChange(from, v)} aria-label={`${label} to`} min={from} />
    </span>
  );
}

function ValueTooltip({ active, payload, unit, config, sum }: {
  active?: boolean; payload?: { dataKey?: string | number; name?: string | number; value?: number | null; payload?: { range?: string } }[];
  unit: Unit; config: ChartConfig; sum: boolean;
}) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((a, p) => a + (Number(p.value) || 0), 0);
  return (
    <div className="min-w-[10rem] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      {payload[0]?.payload?.range && <div className="mb-1 font-medium">{payload[0].payload.range}</div>}
      {payload.map((p) => {
        const key = String(p.dataKey === "value" ? p.name : p.dataKey);
        return (
          <div key={key} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: `var(--color-${key})` }} />{config[key]?.label}</span>
            <span className="font-mono">{p.value == null ? "—" : formatValue(Number(p.value), unit)}</span>
          </div>
        );
      })}
      {sum && payload.length > 1 && <div className="mt-1 flex justify-between border-t border-border pt-1 font-medium"><span>Total</span><span className="font-mono">{formatValue(total, unit)}</span></div>}
    </div>
  );
}

function Cards({ report, before, beforeLabel, groupBy, additive, today }: { report: Report; before: Report | null; beforeLabel: string; groupBy: GroupBy; additive: boolean; today: string }) {
  const unit = report.unit;
  // Each bucket's figure: its series added up, or (pay per hour, which doesn't add up) its only series.
  const totals = report.buckets.map((_, i) => (additive ? report.values[i]!.reduce((a, b) => a + b, 0) : report.values[i]![0]!));
  const best = totals.reduce((bi, v, i) => (v > totals[bi]! ? i : bi), 0);
  // The average is over the days, weeks… that have started, so the rest of this month doesn't pull it down.
  const started = report.buckets.filter((b) => b.from <= today).length;
  const c = before ? change(report.total, before.total) : null;
  return (
    <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <StatCard label={unit === "count" || !additive ? "Whole period" : "Total"} value={formatValue(report.total, unit)} highlight />
      <StatCard label={`Average per ${groupBy}`} value={formatValue(totals.slice(0, started).reduce((a, b) => a + b, 0) / Math.max(1, started), unit)} delay={60} />
      <StatCard label={`Highest ${groupBy}`} value={totals[best] ? formatValue(totals[best]!, unit) : "—"} {...(totals[best] ? { sub: report.buckets[best]!.label } : {})} delay={120} />
      <StatCard label={beforeLabel} value={before ? formatValue(before.total, unit) : "—"}
        sub={c === null ? "no records to compare" : `${pct(c)} this period`} delay={180} />
    </section>
  );
}

/** A table cell: text, or a figure (shown in the report's unit, or as a % change). null is a gap: shown as "—". */
type GridCell = string | { n: number | null; pct?: boolean };
type Grid = { head: string[]; rows: GridCell[][]; foot: GridCell[]; titles: string[]; right: number[] };

const shown = (c: GridCell, unit: Unit) => (typeof c === "string" ? c : c.n === null ? "—" : c.pct ? pct(c.n) : formatValue(c.n, unit));
const csvValue = (c: GridCell) => (typeof c === "string" ? c : c.n === null ? "" : c.pct ? `${(c.n * 100).toFixed(1)}%` : c.n.toFixed(2));

/**
 * The numbers under the chart, as one grid for the screen, the CSV and the PDF: a row per day/week/month, a column
 * per series (and their total) — or, when comparing, this period's bucket, the compared one's, and the change.
 */
function numbersGrid(report: Report, before: Report | null, rows: CompareRow[] | null, additive: boolean, metric: Metric): Grid {
  if (rows && before) {
    const what = METRICS[metric].label;
    return {
      head: ["This period", what, "Compared with", what, "Change"],
      rows: rows.map((r) => [r.now?.label ?? "—", { n: r.a }, r.then?.label ?? "—", { n: r.b }, { n: change(r.a, r.b), pct: true }]),
      foot: ["Whole period", { n: report.total }, "", { n: before.total }, { n: change(report.total, before.total), pct: true }],
      titles: rows.map((r) => `${r.now ? `${r.now.from} – ${r.now.to}` : "—"} vs ${r.then ? `${r.then.from} – ${r.then.to}` : "—"}`),
      right: [1, 3, 4],
    };
  }
  const showTotal = report.series.length > 1 && additive;
  const sum = (v: number[]) => v.reduce((a, c) => a + c, 0);
  // Shown to the cent (or hundredth of an hour): each row's figures are rounded so they add up to its total exactly.
  const line = (v: number[], total: number): GridCell[] => {
    const cells = showTotal ? centsAddingUp(v, Math.round(total * 100)) : v;
    return [...cells.map((n) => ({ n })), ...(showTotal ? [{ n: Math.round(total * 100) / 100 }] : [])];
  };
  return {
    head: ["Period", ...report.series.map((x) => x.label), ...(showTotal ? ["Total"] : [])],
    rows: report.buckets.map((b, i) => [b.label, ...line(report.values[i]!, sum(report.values[i]!))]),
    foot: ["Whole period", ...line(report.seriesTotals, report.total)],
    titles: report.buckets.map((b) => (b.from === b.to ? b.from : `${b.from} – ${b.to}`)),
    right: report.series.map((_, i) => i + 1).concat(showTotal ? [report.series.length + 1] : []),
  };
}

function NumbersTable({ grid, unit, prefKey, fileName }: { grid: Grid; unit: Unit; prefKey: string; fileName: string }) {
  const exportCsv = () => {
    const csv = [grid.head, ...[...grid.rows, grid.foot].map((r) => r.map(csvValue))].map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    downloadBlob(new Blob([csv], { type: "text/csv" }), `${fileName}.csv`);
  };
  const align = (i: number) => (grid.right.includes(i) ? "text-right" : "text-left font-body");
  return (
    <div className="glass-panel overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <span className="font-display font-extrabold tracking-tight">The numbers</span>
        <button type="button" onClick={exportCsv} className={btnGhost}>Export CSV</button>
      </div>
      <div className="max-h-[28rem] overflow-auto">
        <DataTable id={`report-${prefKey}`} className="w-full text-sm">
          <thead>
            <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              {grid.head.map((h, i) => <th key={i} className={`px-4 py-3 font-medium ${grid.right.includes(i) ? "text-right" : "text-left"}`}>{h}</th>)}
            </tr>
          </thead>
          <tbody className="font-mono text-[13px]">
            {grid.rows.map((r, ri) => (
              <tr key={ri} className="border-b border-border last:border-0 hover:bg-secondary" title={grid.titles[ri]}>
                {r.map((c, i) => <td key={i} className={`px-4 py-2 ${align(i)}`}>{shown(c, unit)}</td>)}
              </tr>
            ))}
            <tr className="border-t-2 border-border font-semibold">
              {grid.foot.map((c, i) => <td key={i} className={`px-4 py-2 ${align(i)}`}>{shown(c, unit)}</td>)}
            </tr>
          </tbody>
        </DataTable>
      </div>
    </div>
  );
}
