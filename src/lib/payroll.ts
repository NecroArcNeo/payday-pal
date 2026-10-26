import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { cloudConfigured, storeFor, useDataMode } from "@/lib/db/mode";
import { payByRecord, weekEnd, weekStart, type PayLine } from "@/lib/pay";
import type { EmployeeDefaults } from "@/lib/employee-fields";

export type Employee = Tables<"employees">;
export type TimeRecord = Tables<"time_records">;
export type RecordWithEmp = TimeRecord & { employees: Pick<Employee, "first_name" | "last_name" | "employee_code" | "hourly_rate"> | null };

export const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export const fullName = (e: Pick<Employee, "first_name" | "last_name">) => `${e.first_name} ${e.last_name}`;

/** The optional cloud account. Read from the stored session, so it works offline. */
export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      if (!cloudConfigured) return { user: null };
      const { data } = await supabase.auth.getSession();
      return { user: data.session?.user ?? null };
    },
  });
}

// Query keys end with the data mode so this device's and the cloud's data never share a cache entry.
export function useEmployees() {
  const mode = useDataMode();
  return useQuery({ queryKey: ["employees", mode], queryFn: () => storeFor(mode).listEmployees() });
}

export function useRecords(from?: string, to?: string) {
  const mode = useDataMode();
  return useQuery({ queryKey: ["records", from, to, mode], queryFn: () => storeFor(mode).listRecords(from, to) });
}

/** "Mon", "Tue"… for an ISO date, without timezone drift. */
export const weekday = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });

/** The calendar date in the user's own timezone (toISOString would give UTC's, which is tomorrow by evening in the Americas). */
export function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** An ISO date moved by whole days. */
export function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every date from `from` to `to` inclusive (just `from` when `to` is empty), optionally without Saturdays and Sundays. */
export function datesBetween(from: string, to: string, skipWeekends = false) {
  const out: string[] = [];
  for (let d = from; d <= (to || from); d = addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (!skipWeekends || (wd !== 0 && wd !== 6)) out.push(d);
  }
  return out;
}

export function currentWeek() {
  const now = new Date();
  const day = (now.getDay() + 6) % 7;
  const start = new Date(now);
  start.setDate(now.getDate() - day);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { from: isoDate(start), to: isoDate(end) };
}

export function computeHours(clockIn: string, clockOut: string, lunch: number) {
  const [ih = 0, im = 0] = clockIn.split(":").map(Number);
  const [oh = 0, om = 0] = clockOut.split(":").map(Number);
  let mins = oh * 60 + om - (ih * 60 + im);
  if (mins < 0) mins += 1440;
  return Math.max(0, (mins - lunch) / 60);
}

export type FieldDef = Tables<"employee_field_defs">;
export type Adjustment = Tables<"pay_adjustments">;
export type PayrollSettings = Tables<"payroll_settings">;

export function useFieldDefs() {
  const mode = useDataMode();
  return useQuery({ queryKey: ["field-defs", mode], queryFn: () => storeFor(mode).listFieldDefs() });
}

export function useAdjustments(from?: string, to?: string) {
  const mode = useDataMode();
  return useQuery({ queryKey: ["adjustments", from, to, mode], queryFn: () => storeFor(mode).listAdjustments(from, to) });
}

export const defaultSettings = { ot_threshold: 40, ot_multiplier: 1.5, weekend_overtime: true, visible_columns: ["employee_code", "days"] };

/** The default profile new employees start with (see `withDefaults`). */
export function useEmployeeDefaults() {
  const mode = useDataMode();
  return useQuery({
    queryKey: ["payroll-settings", "employee-defaults", mode],
    queryFn: async () => ((await storeFor(mode).getSettings())?.employee_defaults ?? {}) as EmployeeDefaults,
  });
}

export function usePayrollSettings() {
  const mode = useDataMode();
  return useQuery({
    queryKey: ["payroll-settings", mode],
    queryFn: async () => {
      const data = await storeFor(mode).getSettings();
      return data
        ? { ot_threshold: Number(data.ot_threshold), ot_multiplier: Number(data.ot_multiplier), weekend_overtime: data.weekend_overtime ?? true, visible_columns: data.visible_columns }
        : defaultSettings;
    },
  });
}

export type Shift = Tables<"shifts">;

export function useShifts() {
  const mode = useDataMode();
  return useQuery({ queryKey: ["shifts", mode], queryFn: () => storeFor(mode).listShifts() });
}

/** Every record in a date range — no row cap, so pay totals are never cut short. */
export function useAllRecords(from: string, to: string) {
  const mode = useDataMode();
  return useQuery({ queryKey: ["records", "all", from, to, mode], queryFn: () => storeFor(mode).listRecordsMatching({ from, to }) });
}

/**
 * Regular/overtime hours and pay for each of `rows`, keyed by record id. Loads
 * every record in the whole Mon–Sun weeks they span, so overtime and salary
 * match the Payroll page. Undefined while loading.
 */
export function useRecordPay(rows: Pick<TimeRecord, "work_date">[]): Map<string, PayLine> | undefined {
  const mode = useDataMode();
  const { data: employees } = useEmployees();
  const { data: shifts } = useShifts();
  const { data: settings } = usePayrollSettings();
  let first = "", last = "";
  for (const r of rows) {
    if (!first || r.work_date < first) first = r.work_date;
    if (!last || r.work_date > last) last = r.work_date;
  }
  const from = first && weekStart(first), to = last && weekEnd(last);
  const { data: context } = useQuery({
    queryKey: ["records", "all", from, to, mode],
    queryFn: () => storeFor(mode).listRecordsMatching({ from, to }),
    enabled: !!from,
    placeholderData: keepPreviousData,
  });
  return useMemo(() => {
    if (!context || !employees || !shifts || !settings) return undefined;
    const rules = { threshold: settings.ot_threshold, otMultiplier: settings.ot_multiplier, weekendOvertime: settings.weekend_overtime };
    return payByRecord(context, employees, shifts, rules);
  }, [context, employees, shifts, settings]);
}
