import { supabase } from "@/integrations/supabase/client";
import { localDb } from "./local-db";

export type SyncDirection = "push" | "pull";

export interface SyncResult {
  direction: SyncDirection;
  employees: number;
  timeRecords: number;
  fieldDefs: number;
  adjustments: number;
  timestamp: string;
}

export async function pushSync(): Promise<SyncResult> {
  const local = await localDb.exportAll();

  await supabase.from("time_records").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("pay_adjustments").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("employee_field_defs").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("employees").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("payroll_settings").delete().neq("id", true);

  if (local.employees.length) {
    const rows = local.employees.map((e) => ({
      id: e.id, user_id: e.user_id, employee_code: e.employee_code, first_name: e.first_name, last_name: e.last_name,
      email: e.email, department: e.department, hourly_rate: e.hourly_rate, active: e.active,
      phone: e.phone, job_title: e.job_title, address_line1: e.address_line1, address_line2: e.address_line2,
      city: e.city, state: e.state, postal_code: e.postal_code, country: e.country,
      date_of_birth: e.date_of_birth, hire_date: e.hire_date,
      emergency_contact_name: e.emergency_contact_name, emergency_contact_phone: e.emergency_contact_phone,
      notes: e.notes, custom_fields: e.custom_fields, created_at: e.created_at,
    }));
    const { error } = await supabase.from("employees").insert(rows as never);
    if (error) throw error;
  }

  if (local.time_records.length) {
    const { error } = await supabase.from("time_records").insert(local.time_records.map((r) => ({
      id: r.id, employee_id: r.employee_id, work_date: r.work_date, entry_mode: r.entry_mode,
      clock_in: r.clock_in, clock_out: r.clock_out, lunch_minutes: r.lunch_minutes, hours: r.hours,
      note: r.note, created_at: r.created_at,
    })) as never);
    if (error) throw error;
  }

  if (local.employee_field_defs.length) {
    const { error } = await supabase.from("employee_field_defs").insert(local.employee_field_defs.map((d) => ({
      id: d.id, label: d.label, field_type: d.field_type, sort_order: d.sort_order, created_at: d.created_at,
    })) as never);
    if (error) throw error;
  }

  if (local.pay_adjustments.length) {
    const { error } = await supabase.from("pay_adjustments").insert(local.pay_adjustments.map((a) => ({
      id: a.id, employee_id: a.employee_id, pay_date: a.pay_date, category: a.category, amount: a.amount,
      note: a.note, created_at: a.created_at,
    })) as never);
    if (error) throw error;
  }

  if (local.payroll_settings) {
    const { error } = await supabase.from("payroll_settings").upsert({
      id: true, ot_threshold: local.payroll_settings.ot_threshold, ot_multiplier: local.payroll_settings.ot_multiplier,
      visible_columns: local.payroll_settings.visible_columns, updated_at: local.payroll_settings.updated_at,
    });
    if (error) throw error;
  }

  await localDb.setSyncMeta("push");

  return {
    direction: "push",
    employees: local.employees.length,
    timeRecords: local.time_records.length,
    fieldDefs: local.employee_field_defs.length,
    adjustments: local.pay_adjustments.length,
    timestamp: new Date().toISOString(),
  };
}

export async function pullSync(): Promise<SyncResult> {
  const { data: employees, error: e1 } = await supabase.from("employees").select("*");
  if (e1) throw e1;
  const { data: timeRecords, error: e2 } = await supabase.from("time_records").select("*");
  if (e2) throw e2;
  const { data: fieldDefs, error: e3 } = await supabase.from("employee_field_defs").select("*");
  if (e3) throw e3;
  const { data: adjustments, error: e4 } = await supabase.from("pay_adjustments").select("*");
  if (e4) throw e4;
  const { data: settings, error: e5 } = await supabase.from("payroll_settings").select("*").maybeSingle();
  if (e5) throw e5;

  await localDb.replaceAll({
    employees: (employees ?? []).map((e) => ({
      ...e, custom_fields: (e.custom_fields ?? {}) as Record<string, unknown>,
    })) as never,
    time_records: (timeRecords ?? []) as never,
    employee_field_defs: (fieldDefs ?? []) as never,
    pay_adjustments: (adjustments ?? []) as never,
    payroll_settings: settings ? {
      id: true, ot_threshold: Number(settings.ot_threshold), ot_multiplier: Number(settings.ot_multiplier),
      visible_columns: settings.visible_columns, updated_at: settings.updated_at,
    } : null,
  });

  await localDb.setSyncMeta("pull");

  return {
    direction: "pull",
    employees: employees?.length ?? 0,
    timeRecords: timeRecords?.length ?? 0,
    fieldDefs: fieldDefs?.length ?? 0,
    adjustments: adjustments?.length ?? 0,
    timestamp: new Date().toISOString(),
  };
}
