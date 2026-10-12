import { useQuery } from "@tanstack/react-query";
import { localDb, type EmployeeRow, type TimeRecordRow, type RecordWithEmp, type FieldDefRow, type AdjustmentRow, type PayrollSettingsRow, type ShiftTypeRow } from "./local-db";

export type Employee = EmployeeRow;
export type TimeRecord = TimeRecordRow;
export type RecordWithEmp = RecordWithEmp;
export type FieldDef = FieldDefRow;
export type Adjustment = AdjustmentRow;
export type PayrollSettings = PayrollSettingsRow;
export type ShiftType = ShiftTypeRow;

export const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export const fullName = (e: Pick<Employee, "first_name" | "last_name">) => `${e.first_name} ${e.last_name}`;

export function useEmployees() {
  return useQuery({
    queryKey: ["employees"],
    queryFn: () => localDb.getEmployees(),
  });
}

export function useRecords(from?: string, to?: string) {
  return useQuery({
    queryKey: ["records", from, to],
    queryFn: () => localDb.getRecords(from, to),
  });
}

export function useRecordsPaged(from: string | undefined, to: string | undefined, limit: number, offset: number) {
  return useQuery({
    queryKey: ["records-paged", from, to, limit, offset],
    queryFn: () => localDb.getRecords(from, to, limit, offset),
  });
}

export function useRecordCount(from?: string, to?: string) {
  return useQuery({
    queryKey: ["record-count", from, to],
    queryFn: () => localDb.getRecordCount(from, to),
  });
}

export function useShiftTypes() {
  return useQuery({
    queryKey: ["shift-types"],
    queryFn: () => localDb.getShiftTypes(),
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

export function useFieldDefs() {
  return useQuery({
    queryKey: ["field-defs"],
    queryFn: () => localDb.getFieldDefs(),
  });
}

export function useAdjustments(from?: string, to?: string) {
  return useQuery({
    queryKey: ["adjustments", from, to],
    queryFn: () => localDb.getAdjustments(from, to),
  });
}

export const defaultSettings = { ot_threshold: 40, ot_multiplier: 1.5, visible_columns: ["employee_code", "days"] };

export function usePayrollSettings() {
  return useQuery({
    queryKey: ["payroll-settings"],
    queryFn: async () => {
      const s = await localDb.getPayrollSettings();
      return { ot_threshold: s.ot_threshold, ot_multiplier: s.ot_multiplier, visible_columns: s.visible_columns };
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

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Returns the abbreviated day name for an ISO date string. */
export function dayOfWeek(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return DOW_NAMES[d.getUTCDay()];
}

/** Returns true if the ISO date falls on a Saturday or Sunday. */
export function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Compute pay breakdown: regular, weekly overtime, weekend overtime, and shift-adjusted pay.
 * Weekend hours are always treated as overtime. Weekly overtime is hours beyond the threshold on weekdays.
 * Shift multiplier applies to regular hours only; overtime uses the ot_multiplier.
 */
export function computePayBreakdown(
  records: { work_date: string; hours: number | string; employee_id: string }[],
  threshold: number,
  otMultiplier: number,
  shiftMultiplier: number,
) {
  const weekdayRecords = records.filter((r) => !isWeekend(r.work_date));
  const weekendRecords = records.filter((r) => isWeekend(r.work_date));

  const { regular: weekdayRegular, overtime: weekdayOT } = splitHours(weekdayRecords, threshold);
  const weekendHours = weekendRecords.reduce((s, r) => s + Number(r.hours), 0);

  const regular = weekdayRegular;
  const weeklyOT = weekdayOT;
  const weekendOT = weekendHours;

  const regPay = regular * shiftMultiplier;
  const weeklyOTPay = weeklyOT * otMultiplier * shiftMultiplier;
  const weekendOTPay = weekendOT * otMultiplier * shiftMultiplier;

  return {
    regular,
    weeklyOT,
    weekendOT,
    overtime: weeklyOT + weekendOT,
    regPay,
    weeklyOTPay,
    weekendOTPay,
    otPay: weeklyOTPay + weekendOTPay,
    gross: regPay + weeklyOTPay + weekendOTPay,
  };
}

/** Overtime = hours above the weekly threshold (Mon–Sun). */
export function splitHours(records: { work_date: string; hours: number | string }[], threshold: number) {
  const weeks = new Map<string, number>();
  for (const r of records) weeks.set(weekKey(r.work_date), (weeks.get(weekKey(r.work_date)) ?? 0) + Number(r.hours));
  let regular = 0, overtime = 0;
  for (const h of weeks.values()) { regular += Math.min(h, threshold); overtime += Math.max(0, h - threshold); }
  return { regular, overtime };
}
