import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type Employee = Tables<"employees">;
export type TimeRecord = Tables<"time_records">;
export type RecordWithEmp = TimeRecord & { employees: Pick<Employee, "first_name" | "last_name" | "employee_code" | "hourly_rate"> | null };

export const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export const fullName = (e: Pick<Employee, "first_name" | "last_name">) => `${e.first_name} ${e.last_name}`;

export function useEmployees() {
  return useQuery({
    queryKey: ["employees"],
    queryFn: async () => {
      const { data, error } = await supabase.from("employees").select("*").order("last_name");
      if (error) throw error;
      return data;
    },
  });
}

export function useRecords(from?: string, to?: string) {
  return useQuery({
    queryKey: ["records", from, to],
    queryFn: async () => {
      let q = supabase
        .from("time_records")
        .select("*, employees(first_name,last_name,employee_code,hourly_rate)")
        .order("work_date", { ascending: false })
        .limit(1000);
      if (from) q = q.gte("work_date", from);
      if (to) q = q.lte("work_date", to);
      const { data, error } = await q;
      if (error) throw error;
      return data as RecordWithEmp[];
    },
  });
}

export function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
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
  return useQuery({
    queryKey: ["field-defs"],
    queryFn: async () => {
      const { data, error } = await supabase.from("employee_field_defs").select("*").order("sort_order").order("created_at");
      if (error) throw error;
      return data;
    },
  });
}

export function useAdjustments(from?: string, to?: string) {
  return useQuery({
    queryKey: ["adjustments", from, to],
    queryFn: async () => {
      let q = supabase.from("pay_adjustments").select("*").order("pay_date", { ascending: false });
      if (from) q = q.gte("pay_date", from);
      if (to) q = q.lte("pay_date", to);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });
}

export const defaultSettings = { ot_threshold: 40, ot_multiplier: 1.5, visible_columns: ["employee_code", "days"] };

export function usePayrollSettings() {
  return useQuery({
    queryKey: ["payroll-settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("payroll_settings").select("*").maybeSingle();
      if (error) throw error;
      return data
        ? { ot_threshold: Number(data.ot_threshold), ot_multiplier: Number(data.ot_multiplier), visible_columns: data.visible_columns }
        : defaultSettings;
    },
  });
}

/** Monday of the week containing an ISO date string. */
export function weekKey(date: string) {
  const d = new Date(date + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** Overtime = hours above the weekly threshold (Mon–Sun). */
export function splitHours(records: { work_date: string; hours: number | string }[], threshold: number) {
  const weeks = new Map<string, number>();
  for (const r of records) weeks.set(weekKey(r.work_date), (weeks.get(weekKey(r.work_date)) ?? 0) + Number(r.hours));
  let regular = 0, overtime = 0;
  for (const h of weeks.values()) { regular += Math.min(h, threshold); overtime += Math.max(0, h - threshold); }
  return { regular, overtime };
}
