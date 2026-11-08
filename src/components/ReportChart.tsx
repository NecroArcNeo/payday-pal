import { useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ReferenceArea, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { StatCard, btnGhost, inputCls } from "@/components/AppShell";
import { DataTable } from "@/components/DataTable";
import { DateInput } from "@/components/DateInput";
import { db } from "@/lib/db/mode";
import { centsAddingUp } from "@/lib/amount";
import { downloadBlob } from "@/lib/db/backups";
import { isoDate, money, useAdjustments, useEmployees, usePayRates, usePayrollSettings, useShifts, useHolidays } from "@/lib/payroll";
import { payByRecord, weekEnd, weekStart, payRules } from "@/lib/pay";
import { usePref } from "@/lib/prefs";
import { SkeletonBlock } from "@/components/Loading";
import { TallBox } from "@/components/ResizeHandle";
import {
  autoGroup, buildReport, compareReports, DEFAULT_STATS, GROUPS, METRICS, previousRange, rangeLabel, REPORT_RANGES, reportRange, reportStats, sameTimeLastYear, SPLITS, STATS,
  type CompareRow, type GroupBy, type Metric, type Report, type ReportRange, type SplitBy, type StatKey, type Unit,
} from "@/lib/report";
import { SortTh, TableSort, useTableSort } from "@/components/SortControl";
import { sortTable, type SortColumns } from "@/lib/table-sort";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FoldBox } from "@/components/FoldBox";

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
  /** The statistics cards: over the chart's period, or dates of their own (typed, or dragged across the chart). */
  statsRange: "chart" | "custom"; statsFrom: string; statsTo: string;
  /** What the cards' average, highest and lowest are per: the chart's grouping ("auto"), or one of their own. */
  statsPer: GroupBy | "auto";
  /** Which cards show, in STATS order. */
  stats: StatKey[];
};
export const DEFAULT_SETTINGS: ReportSettings = {
  range: "last_3_months", from: "", to: "", metric: "pay", kind: "bar", group: "auto", split: "none", compare: "off", cmpFrom: "", cmpTo: "",
  statsRange: "chart", statsFrom: "", statsTo: "", statsPer: "auto", stats: DEFAULT_STATS,
};

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
    statsRange: v.statsRange === "custom" ? "custom" : "chart", statsFrom: day(v.statsFrom), statsTo: day(v.statsTo),
    statsPer: v.statsPer === "auto" ? "auto" : ok(v.statsPer, GROUPS, "auto" as GroupBy),
    stats: Array.isArray(v.stats) ? (Object.keys(STATS) as StatKey[]).filter((k) => (v.stats as unknown[]).includes(k)) : base.stats,
  };
}

/** Records for whole Mon–Sun weeks around [from, to] (weekly overtime and salary need the whole week), and extra pay. */
function useReportData(from: string, to: string) {
  const loadFrom = weekStart(from), loadTo = weekEnd(to);
  const records = useQuery({
    queryKey: ["records", "report", loadFrom, loadTo],
    queryFn: () => db().listRecordsMatching({ from: loadFrom, to: loadTo }),
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

  // The statistics cards: over the chart's period and grouping, or over dates of their own (compared with the same
  // length just before), per day/week/month/year as chosen.
  const statsOwn = !compact && s.statsRange === "custom" && !!s.statsFrom && !!s.statsTo && s.statsFrom <= s.statsTo;
  const st = statsOwn ? { from: s.statsFrom, to: s.statsTo } : { from, to };
  const statsAuto = statsOwn ? autoGroup(st.from, st.to) : groupBy;
  const statsPer: GroupBy = s.statsPer === "auto" ? statsAuto : s.statsPer;
  const stBefore = statsOwn ? previousRange(st.from, st.to) : against;

  // Four loads: this period, the one it's compared with, and the statistics' own dates and the ones before them. When
  // the statistics follow the chart (and on the Dashboard, which has neither), they ask for ranges already asked for,
  // which React Query answers from the same load (same query key).
  const now = useReportData(from, to);
  const then = useReportData(compact ? from : against.from, compact ? to : against.to);
  const stNow = useReportData(compact ? from : st.from, compact ? to : st.to);
  const stThen = useReportData(compact ? from : stBefore.from, compact ? to : stBefore.to);
  const { data: employees } = useEmployees();
  const { data: shifts } = useShifts();
  const { data: rates } = usePayRates();
  const { data: settings } = usePayrollSettings();
  const { data: holidays } = useHolidays();
  const idsKey = employeeIds?.join(",") ?? "";

  const result = useMemo(() => {
    if (!now.records || !now.adjustments || !then.records || !then.adjustments || !stNow.records || !stNow.adjustments || !stThen.records || !stThen.adjustments) return null;
    if (!employees || !shifts || !settings || !holidays) return null;
    const rules = payRules(settings, holidays);
    const ids = idsKey ? idsKey.split(",") : undefined;
    const common = { employees, shifts, rates, rules, groupBy, metric: s.metric, splitBy: split, employeeIds: ids };
    // Pay per record is the slow part; loads that are the same (statistics following the chart) share it.
    const payFor = new Map<unknown, ReturnType<typeof payByRecord>>();
    const pay = (records: Parameters<typeof payByRecord>[0]) => payFor.get(records) ?? payFor.set(records, payByRecord(records, employees, shifts, rules, rates)).get(records)!;
    type Records = NonNullable<typeof now.records>;
    type Adjustments = NonNullable<typeof now.adjustments>;
    const report = (records: Records, adjustments: Adjustments, r: { from: string; to: string }, more: { groupBy?: GroupBy; splitBy?: SplitBy } = {}) =>
      buildReport({ ...common, records, adjustments, pay: pay(records), ...r, ...more });
    const a = report(now.records, now.adjustments, { from, to });
    const b = compact ? null : report(then.records, then.adjustments, against);
    // The cards add every series up, so their report isn't split.
    const flat = { groupBy: statsPer, splitBy: "none" as const };
    const stats = compact ? null : { now: report(stNow.records, stNow.adjustments, st, flat), before: report(stThen.records, stThen.adjustments, stBefore, flat) };
    return { now: a, before: b, rows: comparing && b ? compareReports(a, b) : null, stats };
  }, [now.records, now.adjustments, then.records, then.adjustments, stNow.records, stNow.adjustments, stThen.records, stThen.adjustments, employees, shifts, rates, settings, holidays, idsKey, groupBy, s.metric, split, from, to, against.from, against.to, st.from, st.to, stBefore.from, stBefore.to, statsPer, compact, comparing]);

  const chartBox = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  // Dragging across the chart (or clicking one bar) picks the statistics' dates: the first and last day/week… pressed
  // over, as indexes into the chart's buckets, while the button is down.
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);

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

  // The chart's height can be dragged (its bottom edge), remembered per place like the other choices.
  const heightKey = `meridian-report-height:${prefKey}`;
  if (!report || !result) return <>{controls}<TallBox prefKey={heightKey} height={height} label="Chart height"><SkeletonBlock className="h-full w-full rounded-2xl" /></TallBox></>;

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

  // Picking the statistics' dates on the chart (not a pie, nor a comparison, whose bars are two periods). Recharts
  // reports which bucket the pointer is over as activeTooltipIndex.
  const selectable = !compact && !rows && kind !== "pie";
  const at = (e: { activeTooltipIndex?: number } | null | undefined) => e?.activeTooltipIndex ?? null;
  const pick = selectable ? {
    onMouseDown: (e: { activeTooltipIndex?: number } | null) => { const i = at(e); if (i !== null) setDrag({ a: i, b: i }); },
    onMouseMove: (e: { activeTooltipIndex?: number } | null) => { const i = at(e); if (drag && i !== null && i !== drag.b) setDrag({ a: drag.a, b: i }); },
    onMouseUp: () => {
      if (!drag) return;
      const lo = report.buckets[Math.min(drag.a, drag.b)], hi = report.buckets[Math.max(drag.a, drag.b)];
      setDrag(null);
      if (lo && hi) set({ statsRange: "custom", statsFrom: lo.from, statsTo: hi.to });
    },
    onMouseLeave: () => setDrag(null),
  } : {};
  // The band shows the dates being dragged, or the statistics' own dates where they overlap the chart.
  const overlapping = report.buckets.flatMap((b, i) => (b.to >= st.from && b.from <= st.to ? [i] : []));
  const band = drag ? [Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)] as const
    : statsOwn && overlapping.length ? [overlapping[0]!, overlapping.at(-1)!] as const
    : null;
  // Left out of a saved picture or PDF, which show the chart itself.
  const highlight = selectable && band && band[0] >= 0 && !saving
    ? <ReferenceArea x1={data[band[0]]!.label} x2={data[band[1]]!.label} fill="var(--primary)" fillOpacity={0.12} strokeOpacity={0} />
    : null;

  const chart = kind === "pie" ? (
    <PieChart>
      {tooltip}
      <Pie data={report.series.map((x, i) => ({ name: keys[i]!, value: report.seriesTotals[i]! }))} dataKey="value" nameKey="name" innerRadius="45%" strokeWidth={2}>
        {keys.map((k) => <Cell key={k} fill={`var(--color-${k})`} />)}
      </Pie>
      <ChartLegend content={<ChartLegendContent nameKey="name" />} />
    </PieChart>
  ) : kind === "line" ? (
    <LineChart data={data} margin={{ left: 4, right: 12, top: 8 }} {...pick}>
      <CartesianGrid vertical={false} /><XAxis dataKey="label" {...axis} minTickGap={16} /><YAxis {...axis} width={56} tickFormatter={(v: number) => short(v, unit)} />
      {highlight}{tooltip}{legend}
      {keys.map((k, i) => <Line key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={2} dot={data.length <= 31} {...(rows && i === 1 ? { strokeDasharray: "5 4" } : {})} />)}
    </LineChart>
  ) : kind === "area" ? (
    <AreaChart data={data} margin={{ left: 4, right: 12, top: 8 }} {...pick}>
      <CartesianGrid vertical={false} /><XAxis dataKey="label" {...axis} minTickGap={16} /><YAxis {...axis} width={56} tickFormatter={(v: number) => short(v, unit)} />
      {highlight}{tooltip}{legend}
      {keys.map((k) => <Area key={k} dataKey={k} type="monotone" {...(additive && !rows ? { stackId: "a" } : {})} stroke={`var(--color-${k})`} fill={`var(--color-${k})`} fillOpacity={0.25} />)}
    </AreaChart>
  ) : (
    <BarChart data={data} margin={{ left: 4, right: 12, top: 8 }} {...pick}>
      <CartesianGrid vertical={false} /><XAxis dataKey="label" {...axis} minTickGap={8} /><YAxis {...axis} width={56} tickFormatter={(v: number) => short(v, unit)} />
      {highlight}{tooltip}{legend}
      {keys.map((k, i) => <Bar key={k} dataKey={k} fill={`var(--color-${k})`} {...(stacked ? { stackId: "a" } : {})}
        radius={stacked ? (i === keys.length - 1 ? [4, 4, 0, 0] : 0) : 4} />)}
    </BarChart>
  );

  const body = (
    <div className="relative" ref={chartBox}>
      <TallBox prefKey={heightKey} height={height} label="Chart height">
        <ChartContainer config={config} className="!aspect-auto h-full w-full">{chart}</ChartContainer>
      </TallBox>
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
    // Drawn again at once without the statistics' band (flushSync), so the picture is taken without it.
    flushSync(() => setSaving(true));
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

  // Container queries (the cards' columns) follow the chart's own width: it's a full page on Reports and in a side
  // panel on Employees.
  return (
    <div className="@container space-y-4">
      {controls}
      <p className="text-xs text-muted-foreground">{METRICS[s.metric].hint}. {from} to {to}, per {groupBy}.{rows ? ` Compared with ${against.from} to ${against.to}, ${groupBy} by ${groupBy} in order.` : ""}</p>
      {result.stats && (
        <Statistics s={s} set={set} chart={{ from, to }} st={st} own={statsOwn} per={statsPer} auto={statsAuto} additive={additive} today={today}
          now={result.stats.now} before={result.stats.before}
          beforeLabel={statsOwn ? "Same length before" : s.compare === "off" || s.compare === "previous" ? "Previous period" : s.compare === "last_year" ? "Same time last year" : "Compared period"}
          beforeRange={stBefore} selectable={selectable} />
      )}
      <FoldBox id={`report:${prefKey}:chart`} title="Chart" off={compact}>
        <div className="glass-panel p-4">
          <div className="mb-2 flex justify-end gap-2">
            <button type="button" onClick={() => save("png")} disabled={saving} className={btnGhost} title="Save the chart as a PNG picture">Save picture</button>
            <button type="button" onClick={() => save("pdf")} disabled={saving} className={btnGhost} title="Save the chart and its numbers as a PDF">Save PDF</button>
          </div>
          {body}
        </div>
      </FoldBox>
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

/**
 * The statistics: which dates they're over (the chart's period, dates typed in, or dragged across the chart), what
 * the average is per, which cards show, and the cards themselves. The numbers come from reportStats over a report of
 * just those dates (worked out with the payroll rules over whole weeks, like the chart), so "hours worked from Jan 15
 * to May 22" is exactly those days.
 */
function Statistics({ s, set, chart, st, own, per, auto, additive, today, now, before, beforeLabel, beforeRange, selectable }: {
  s: ReportSettings; set: (patch: Partial<ReportSettings>) => void; chart: { from: string; to: string }; st: { from: string; to: string };
  own: boolean; per: GroupBy; auto: GroupBy; additive: boolean; today: string; now: Report; before: Report;
  beforeLabel: string; beforeRange: { from: string; to: string }; selectable: boolean;
}) {
  const unit = now.unit;
  const stats = reportStats(now, today, additive);
  const c = change(now.total, before.total);
  const per_ = per.toLowerCase();
  const range = rangeLabel(st.from, st.to);
  const shown = s.stats;
  const cards: Record<StatKey, React.ReactNode> = {
    total: <StatCard label={unit === "count" || !additive ? "Whole period" : "Total"} value={formatValue(stats.total, unit)} sub={range} highlight />,
    average: <StatCard label={`Average per ${per_}`} value={stats.averageOver ? formatValue(stats.average, unit) : "—"}
      sub={stats.averageOver ? `over ${stats.averageOver} ${per_}${stats.averageOver === 1 ? "" : "s"}` : `no ${per_} has started yet`} />,
    highest: <StatCard label={`Highest ${per_}`} value={stats.highest ? formatValue(stats.highest.value, unit) : "—"} {...(stats.highest ? { sub: stats.highest.bucket.label } : {})} />,
    lowest: <StatCard label={`Lowest ${per_}`} value={stats.lowest ? formatValue(stats.lowest.value, unit) : "—"} {...(stats.lowest ? { sub: stats.lowest.bucket.label } : {})} />,
    compare: <StatCard label={beforeLabel} value={formatValue(before.total, unit)}
      sub={c === null ? `no records ${rangeLabel(beforeRange.from, beforeRange.to)}` : `${pct(c)} this period · ${rangeLabel(beforeRange.from, beforeRange.to)}`} />,
  };
  const toggle = (k: StatKey, on: boolean) => set({ stats: (Object.keys(STATS) as StatKey[]).filter((x) => (x === k ? on : shown.includes(x))) });
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Choice label="Statistics for" value={own ? "custom" : "chart"}
          onChange={(v) => set(v === "custom" ? { statsRange: "custom", statsFrom: s.statsFrom || chart.from, statsTo: s.statsTo || chart.to } : { statsRange: "chart" })}
          options={[["chart", "The chart's period"], ["custom", "Chosen dates…"]]} />
        {s.statsRange === "custom" && <Dates from={s.statsFrom || chart.from} to={s.statsTo || chart.to} onChange={(f, t) => set({ statsRange: "custom", statsFrom: f, statsTo: t })} label="Statistics" />}
        <Choice label="Average per" value={s.statsPer} onChange={(v) => set({ statsPer: v as GroupBy | "auto" })}
          options={[["auto", `Auto (${GROUPS[auto].toLowerCase()})`], ...Object.entries(GROUPS)]} />
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger className={btnGhost}>Cards ({shown.length})</DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Show these statistics</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {(Object.entries(STATS) as [StatKey, string][]).map(([k, label]) => (
              // Ticking keeps the menu open (preventDefault on select), to tick several in one go.
              <DropdownMenuCheckboxItem key={k} checked={shown.includes(k)} onCheckedChange={(on) => toggle(k, on)} onSelect={(e) => e.preventDefault()}>{label}</DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {own && <button type="button" onClick={() => set({ statsRange: "chart" })} className={`${btnGhost} !py-1.5 text-xs`}>Back to the chart's period</button>}
        {selectable && <span className="pb-2 text-xs text-muted-foreground">{own ? range : "Tip: drag across the chart (or click a bar) to see the statistics for just those dates."}</span>}
      </div>
      {shown.length > 0 && (
        <div className="grid grid-cols-2 gap-4 @2xl:grid-cols-4">
          {(Object.keys(STATS) as StatKey[]).filter((k) => shown.includes(k)).map((k) => <div key={k}>{cards[k]}</div>)}
        </div>
      )}
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
  // Sorted by any column; the period columns (text labels like "Oct 2026") sort in time order, by their row. Columns
  // are keyed by position and heading, so a sort by "Kitchen" stays while the period changes. The whole-period line
  // stays at the bottom.
  const columns: SortColumns<number> = Object.fromEntries(grid.head.map((h, i) => [`${i}|${h}`, grid.right.includes(i)
    ? { label: h, kind: "number" as const, value: (ri: number) => { const c = grid.rows[ri]![i]!; return typeof c === "string" ? null : c.n; } }
    : { label: h, kind: "date" as const, desc: false, value: (ri: number) => ri }]));
  const [sort, setSort] = useTableSort(`meridian-report-table-sort:${prefKey}`, columns, { by: `0|${grid.head[0]}`, desc: false });
  const order = sortTable(grid.rows.map((_, i) => i), sort, columns);
  const exportCsv = () => {
    // In the order shown.
    const csv = [grid.head, ...[...order.map((ri) => grid.rows[ri]!), grid.foot].map((r) => r.map(csvValue))].map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    downloadBlob(new Blob([csv], { type: "text/csv" }), `${fileName}.csv`);
  };
  const align = (i: number) => (grid.right.includes(i) ? "text-right" : "text-left font-body");
  return (
    <FoldBox id={`report:${prefKey}:numbers`} title="The numbers">
      <div className="glass-panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <span className="font-display font-extrabold tracking-tight">The numbers</span>
          <button type="button" onClick={exportCsv} className={btnGhost}>Export CSV</button>
        </div>
        <div className="max-h-[28rem] overflow-auto">
          <DataTable id={`report-${prefKey}`} className="w-full text-sm">
            <thead>
              <TableSort sort={sort} columns={columns} onSort={setSort}>
              <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                {grid.head.map((h, i) => <SortTh k={`${i}|${h}`} key={i} className={`px-4 py-3 font-medium ${grid.right.includes(i) ? "text-right" : "text-left"}`}>{h}</SortTh>)}
              </tr>
              </TableSort>
            </thead>
            <tbody className="font-mono text-[13px]">
              {order.map((ri) => grid.rows[ri]!).map((r, k) => (
                <tr key={order[k]} className="border-b border-border last:border-0 hover:bg-secondary" title={grid.titles[order[k]!]}>
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
    </FoldBox>
  );
}
