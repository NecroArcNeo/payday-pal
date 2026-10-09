import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { AppShell, btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { fullName, money, useEmployees, type Employee } from "@/lib/payroll";
import { Pencil, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/employees")({
  head: () => ({ meta: [{ title: "Employees — Meridian Payroll" }] }),
  component: EmployeesPage,
});

const schema = z.object({
  employee_code: z.string().trim().min(1, "ID required").max(40),
  first_name: z.string().trim().min(1, "First name required").max(80),
  last_name: z.string().trim().min(1, "Last name required").max(80),
  email: z.string().trim().email("Invalid email").max(255).or(z.literal("")),
  department: z.string().trim().max(80),
  hourly_rate: z.coerce.number().min(0).max(10000),
});

const empty = { employee_code: "", first_name: "", last_name: "", email: "", department: "", hourly_rate: "" };

function EmployeesPage() {
  const { data: employees = [] } = useEmployees();
  const qc = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = schema.safeParse(form);
    if (!parsed.success) { toast.error(parsed.error.issues[0]?.message ?? "Invalid input"); return; }
    const row = { ...parsed.data, email: parsed.data.email || null, department: parsed.data.department || null };
    const { error } = editing
      ? await supabase.from("employees").update(row).eq("id", editing)
      : await supabase.from("employees").insert(row);
    if (error) { toast.error(error.message); return; }
    toast.success(editing ? "Employee updated" : "Employee added");
    setForm(empty);
    setEditing(null);
    qc.invalidateQueries({ queryKey: ["employees"] });
  };

  const edit = (e: Employee) => {
    setEditing(e.id);
    setForm({ employee_code: e.employee_code, first_name: e.first_name, last_name: e.last_name, email: e.email ?? "", department: e.department ?? "", hourly_rate: String(e.hourly_rate) });
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this employee and all their time records?")) return;
    const { error } = await supabase.from("employees").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries();
  };

  const list = employees.filter((e) => `${fullName(e)} ${e.employee_code} ${e.email ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const field = (k: string, ph: string, type = "text") => (
    <input className={inputCls} type={type} step="0.01" placeholder={ph} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
  );

  return (
    <AppShell eyebrow="Directory" title={`${employees.length} employees`}>
      <form onSubmit={save} className="glass-panel grid gap-3 p-5 md:grid-cols-7">
        {field("employee_code", "Employee ID")}
        {field("first_name", "First name")}
        {field("last_name", "Last name")}
        {field("email", "Email", "email")}
        {field("department", "Department")}
        {field("hourly_rate", "Hourly rate", "number")}
        <div className="flex gap-2">
          <button className={`${btnPrimary} flex-1`}>{editing ? "Save" : "Add"}</button>
          {editing && <button type="button" onClick={() => { setEditing(null); setForm(empty); }} className={btnGhost}>✕</button>}
        </div>
      </form>

      <div className="glass-panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="font-display font-extrabold tracking-tight">Roster</div>
          <input className={`${inputCls} max-w-xs`} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              <th className="px-5 py-3 text-left font-medium">Employee</th>
              <th className="px-3 py-3 text-left font-medium">ID</th>
              <th className="px-3 py-3 text-left font-medium">Email</th>
              <th className="px-3 py-3 text-left font-medium">Department</th>
              <th className="px-3 py-3 text-right font-medium">Rate</th>
              <th className="px-3 py-3 text-left font-medium">Account</th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={7} className="px-5 py-10 text-center text-muted-foreground">No employees yet — add one above or import a file.</td></tr>}
            {list.map((e) => (
              <tr key={e.id} className="border-b border-border last:border-0 hover:bg-secondary">
                <td className="px-5 py-3 font-medium"><Link to="/employees/$id" params={{ id: e.id }} className="hover:underline">{fullName(e)}</Link></td>
                <td className="px-3 py-3 font-mono text-[13px]">{e.employee_code}</td>
                <td className="px-3 py-3 text-muted-foreground">{e.email ?? "—"}</td>
                <td className="px-3 py-3 text-muted-foreground">{e.department ?? "—"}</td>
                <td className="px-3 py-3 text-right font-mono text-[13px]">{money(Number(e.hourly_rate))}</td>
                <td className="px-3 py-3 text-xs">{e.user_id ? <span className="text-accent-foreground">Linked</span> : <span className="text-muted-foreground">—</span>}</td>
                <td className="px-3 py-3">
                  <div className="flex justify-end gap-3 text-muted-foreground">
                    <button onClick={() => edit(e)} aria-label="Edit"><Pencil className="h-4 w-4 hover:text-foreground" /></button>
                    <button onClick={() => remove(e.id)} aria-label="Delete"><Trash2 className="h-4 w-4 hover:text-destructive" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
