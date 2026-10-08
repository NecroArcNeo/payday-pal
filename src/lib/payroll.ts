import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type Employee = Tables<"employees">;
export type TimeRecord = Tables<"time_records">;
export type RecordWithEmp = TimeRecord & { employees: Pick<Employee, "first_name" | "last_name" | "employee_code" | "hourly_rate"> | null };

export const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export const fullName = (e: Pick<Employee, "first_name" | "last_name">) => `${e.first_name} ${e.last_name}`;

export function useSession() {
  return useQuery({
    queryKey: ["session-role"],
    queryFn: async () => {
      const { data } = await supabase.auth.getUser();
      const user = data.user;
      if (!user) return { user: null, isAdmin: false };
      const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", user.id);
      return { user, isAdmin: !!roles?.some((r) => r.role === "admin") };
    },
  });
}

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
