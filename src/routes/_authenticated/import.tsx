import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import { AppShell, btnGhost, btnPrimary } from "@/components/AppShell";
import { useEmployees, useFieldDefs, type Employee, type FieldDef } from "@/lib/payroll";

export const Route = createFileRoute("/_authenticated/import")({
  head: () => ({ meta: [{ title: "Import — Meridian Payroll" }] }),
  component: ImportPage,
});

type Role = "people" | "records" | "ignore";
type Row = Record<string, string>;
type SheetInfo = { name: string; rows: Row[]; headers: string[]; role: Role };

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const pick = (r: Row, ...keys: string[]) => {
  for (const k of keys) if (r[k] != null && String(r[k]).trim() !== "") return String(r[k]).trim();
  return "";
};

const A = {
  code: ["employeeid", "employeecode", "empid", "empno", "employeenumber", "staffid", "id", "code"],
  first: ["firstname", "first", "givenname", "forename"],
  last: ["lastname", "last", "surname", "familyname"],
  name: ["name", "fullname", "employee", "employeename", "staffname"],
  email: ["email", "emailaddress", "mail", "workemail"],
  dept: ["department", "dept", "team", "division"],
  rate: ["hourlyrate", "rate", "payrate", "wage", "hourlywage", "perhour"],
  phone: ["phone", "phonenumber", "mobile", "cell", "telephone", "tel"],
  title: ["jobtitle", "title", "position", "role"],
  addr1: ["address", "address1", "addressline1", "street", "streetaddress"],
  addr2: ["address2", "addressline2", "apt", "suite", "unit"],
  city: ["city", "town"],
  state: ["state", "province", "region", "stateregion"],
  zip: ["zip", "zipcode", "postalcode", "postcode", "postal"],
  country: ["country"],
  dob: ["dateofbirth", "dob", "birthdate", "birthday"],
  hire: ["hiredate", "startdate", "datehired", "joined", "joindate"],
  ecName: ["emergencycontact", "emergencycontactname", "emergencyname"],
  ecPhone: ["emergencyphone", "emergencycontactphone"],
  notes: ["notes", "note", "comments"],
  date: ["date", "workdate", "day", "shiftdate"],
  cin: ["clockin", "timein", "in", "start", "starttime"],
  cout: ["clockout", "timeout", "out", "end", "endtime"],
  lunch: ["lunchminutes", "lunch", "break", "breakminutes", "lunchmins"],
  hours: ["hours", "totalhours", "hoursworked", "hrs"],
};
const peopleKeys = new Set([...A.first, ...A.last, ...A.name, ...A.email, ...A.dept, ...A.rate, ...A.phone, ...A.title, ...A.addr1, ...A.city, ...A.zip, ...A.dob, ...A.hire]);
const recordKeys = new Set([...A.date, ...A.cin, ...A.cout, ...A.hours, ...A.lunch]);
const known = new Set(Object.values(A).flat());

function parseTime(v: string): string | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3]?.toLowerCase();
  if (ap?.startsWith("p") && h < 12) h += 12;
  if (ap?.startsWith("a") && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function parseDate(v: string): string | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const [, a = "", b = "", c = ""] = m;
    const y = c.length === 2 ? `20${c}` : c;
    return `${y}-${a.padStart(2, "0")}-${b.padStart(2, "0")}`;
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Finds the header row (tables may not start on row 1) and returns rows keyed by normalized header. */
function readSheet(ws: XLSX.WorkSheet): { rows: Row[]; headers: string[] } {
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "", dateNF: "yyyy-mm-dd", blankrows: false });
  let best = 0, bestScore = -1;
  grid.slice(0, 15).forEach((row, i) => {
    const score = row.filter((c) => known.has(norm(String(c)))).length * 10 + row.filter((c) => String(c).trim()).length;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  const rawHeaders = (grid[best] ?? []).map((c) => String(c).trim());
  const headers = rawHeaders.map(norm);
  const rows = grid.slice(best + 1).map((r) => {
    const o: Row = {};
    headers.forEach((h, i) => { if (h) o[h] = String(r[i] ?? "").trim(); });
    return o;
  }).filter((o) => Object.values(o).some((v) => v));
  return { rows, headers: rawHeaders.filter(Boolean) };
}

function guessRole(headers: string[]): Role {
  const n = headers.map(norm);
  const p = n.filter((h) => peopleKeys.has(h)).length;
  const r = n.filter((h) => recordKeys.has(h)).length;
  if (!p && !r) return "ignore";
  return r > p ? "records" : "people";
}

type PersonRow = { [K in keyof Employee]?: Employee[K] | undefined } & { employee_code: string; first_name: string; last_name: string };

function parsePeople(sheet: SheetInfo, existing: Employee[], seen: PersonRow[], defs: FieldDef[], taken: Set<string>) {
  const ok: PersonRow[] = [];
  const errs: string[] = [];
  const existByEmail = new Map(existing.filter((e) => e.email).map((e) => [e.email!.toLowerCase(), e]));
  const existByName = new Map(existing.map((e) => [`${e.first_name} ${e.last_name}`.toLowerCase(), e]));
  const seenByEmail = new Map(seen.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p]));
  const seenByName = new Map(seen.map((p) => [`${p.first_name} ${p.last_name}`.toLowerCase(), p]));
  const sheetByEmail = new Map<string, PersonRow>();
  const sheetByName = new Map<string, PersonRow>();
  const defByLabel = new Map(defs.map((d) => [norm(d.label), d.id]));
  let n = existing.length + seen.length + 1;
  sheet.rows.slice(0, 25000).forEach((r, i) => {
    const line = `${sheet.name} row ${i + 2}`;
    let first = pick(r, ...A.first), last = pick(r, ...A.last);
    if (!first && !last) {
      const full = pick(r, ...A.name);
      if (full.includes(",")) { [last = "", first = ""] = full.split(",").map((s) => s.trim()); }
      else { const parts = full.split(/\s+/); first = parts[0] ?? ""; last = parts.slice(1).join(" "); }
    }
    if (!first) { errs.push(`${line}: no name found`); return; }
    if (!last) last = "-";
    const email = pick(r, ...A.email);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { errs.push(`${line}: invalid email "${email}"`); return; }
    const emailKey = email ? email.toLowerCase() : "";
    const nameKey = `${first} ${last}`.toLowerCase();
    if ((emailKey && (seenByEmail.has(emailKey) || sheetByEmail.has(emailKey))) || seenByName.has(nameKey) || sheetByName.has(nameKey)) {
      errs.push(`${line}: duplicate employee "${first} ${last === "-" ? "" : last}"${emailKey ? ` <${email}>` : ""} — skipped`);
      return;
    }
    const rateRaw = pick(r, ...A.rate).replace(/[$,\s]/g, "");
    const rate = Number(rateRaw || 0);
    if (!Number.isFinite(rate) || rate < 0) { errs.push(`${line}: invalid hourly rate`); return; }
    const match = (emailKey && existByEmail.get(emailKey)) || existByName.get(nameKey);
    let code = pick(r, ...A.code) || match?.employee_code || "";
    if (!code) { do { code = `E${String(n++).padStart(3, "0")}`; } while (taken.has(code.toLowerCase())); }
    if (taken.has(code.toLowerCase()) && !match && !pick(r, ...A.code)) { errs.push(`${line}: duplicate ID ${code}`); return; }
    taken.add(code.toLowerCase());
    const custom: Record<string, string> = { ...((match?.custom_fields ?? {}) as Record<string, string>) };
    for (const [k, v] of Object.entries(r)) { const id = defByLabel.get(k); if (id && v) custom[id] = v.slice(0, 1000); }
    const opt = (keys: string[], max = 200) => pick(r, ...keys).slice(0, max) || undefined;
    const d = (keys: string[]) => parseDate(pick(r, ...keys)) ?? undefined;
    const row: PersonRow = {
      employee_code: code.slice(0, 40), first_name: first.slice(0, 80), last_name: last.slice(0, 80),
      email: email || match?.email || null, hourly_rate: rateRaw ? rate : Number(match?.hourly_rate ?? 0),
      department: opt(A.dept, 80), phone: opt(A.phone, 40), job_title: opt(A.title, 80),
      address_line1: opt(A.addr1), address_line2: opt(A.addr2), city: opt(A.city, 80), state: opt(A.state, 80),
      postal_code: opt(A.zip, 20), country: opt(A.country, 80), date_of_birth: d(A.dob), hire_date: d(A.hire),
      emergency_contact_name: opt(A.ecName, 120), emergency_contact_phone: opt(A.ecPhone, 40), notes: opt(A.notes, 2000),
      custom_fields: custom,
    };
    for (const k of Object.keys(row) as (keyof PersonRow)[]) if (row[k] === undefined) delete row[k];
    ok.push(row);
    if (emailKey) sheetByEmail.set(emailKey, row);
    sheetByName.set(nameKey, row);
  });
  return { ok, errs };
}

function parseRecords(sheet: SheetInfo, people: { id?: string | undefined; employee_code: string; email?: string | null | undefined; first_name: string; last_name: string }[]) {
  const ok: Record<string, unknown>[] = [];
  const errs: string[] = [];
  const byCode = new Map(people.map((e) => [e.employee_code.toLowerCase(), e]));
  const byEmail = new Map(people.filter((e) => e.email).map((e) => [e.email!.toLowerCase(), e]));
  const byName = new Map(people.map((e) => [`${e.first_name} ${e.last_name}`.toLowerCase(), e]));
  sheet.rows.slice(0, 25000).forEach((r, i) => {
    const line = `${sheet.name} row ${i + 2}`;
    const code = pick(r, ...A.code).toLowerCase();
    const email = pick(r, ...A.email).toLowerCase();
    const name = (pick(r, ...A.name) || `${pick(r, ...A.first)} ${pick(r, ...A.last)}`).trim().toLowerCase();
    const emp = byCode.get(code) ?? byEmail.get(email) ?? byName.get(name);
    if (!emp) { errs.push(`${line}: unknown employee "${code || email || name}"`); return; }
    const date = parseDate(pick(r, ...A.date));
    if (!date) { errs.push(`${line}: invalid date`); return; }
    const cin = parseTime(pick(r, ...A.cin));
    const cout = parseTime(pick(r, ...A.cout));
    const base = { employee_id: emp.id, _code: emp.employee_code, work_date: date };
    if (cin && cout) {
      const lunch = Number(pick(r, ...A.lunch) || 0);
      if (!Number.isFinite(lunch) || lunch < 0 || lunch > 600) { errs.push(`${line}: invalid lunch minutes`); return; }
      ok.push({ ...base, entry_mode: "clock", clock_in: cin, clock_out: cout, lunch_minutes: lunch });
    } else {
      const hours = Number(pick(r, ...A.hours));
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24) { errs.push(`${line}: needs clock in/out or hours (0–24)`); return; }
      ok.push({ ...base, entry_mode: "hours", hours });
    }
  });
  return { ok, errs };
}

const template = () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["Employee ID", "Name", "Email", "Phone", "Job title", "Department", "Hourly rate", "Address", "City", "State", "Zip", "Hire date"],
    ["E100", "Nadia Okafor", "nadia@example.com", "555-0100", "Picker", "Warehouse", 28, "12 Elm St", "Austin", "TX", "78701", "2026-01-15"],
  ]), "New people");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["Employee ID", "Date", "Clock in", "Clock out", "Lunch minutes", "Hours"],
    ["E100", "2026-10-05", "09:00", "17:30", 30, ""],
    ["E100", "2026-10-06", "", "", "", 7.5],
  ]), "Hours");
  XLSX.writeFile(wb, "payroll_import_template.xlsx");
};

function ImportPage() {
  const qc = useQueryClient();
  const { data: employees = [] } = useEmployees();
  const { data: defs = [] } = useFieldDefs();
  const [file, setFile] = useState("");
  const [sheets, setSheets] = useState<SheetInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) { toast.error("File must be under 10MB"); return; }
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
      const list = wb.SheetNames.map((name) => {
        const { rows, headers } = readSheet(wb.Sheets[name]!);
        return { name, rows, headers, role: rows.length ? guessRole(headers) : ("ignore" as Role) };
      });
      if (!list.some((s) => s.rows.length)) { toast.error("No tables found in this file"); return; }
      setFile(f.name);
      setSheets(list);
    } catch {
      toast.error("Couldn't read that file");
    }
  };

  const setRole = (name: string, role: Role) => setSheets((s) => s.map((x) => (x.name === name ? { ...x, role } : x)));

  // Preview — parse people sheets, accumulating seen rows so duplicates across sheets are skipped
  const taken = new Set(employees.map((e) => e.employee_code.toLowerCase()));
  const peopleRes: { ok: PersonRow[]; errs: string[] }[] = [];
  const accumulated: PersonRow[] = [];
  for (const s of sheets.filter((x) => x.role === "people")) {
    const res = parsePeople(s, employees, accumulated, defs, taken);
    peopleRes.push(res);
    accumulated.push(...res.ok);
  }
  const newPeople = accumulated;
  const pool = [...employees, ...newPeople.filter((p) => !employees.some((e) => e.employee_code === p.employee_code))];
  const recRes = sheets.filter((s) => s.role === "records").map((s) => parseRecords(s, pool));
  const recCount = recRes.reduce((n, r) => n + r.ok.length, 0);
  const errors = [...peopleRes, ...recRes].flatMap((r) => r.errs);
  const addedCount = newPeople.filter((p) => !employees.some((e) => e.employee_code.toLowerCase() === p.employee_code.toLowerCase())).length;

  const commit = async () => {
    setBusy(true);
    try {
      let fresh = employees;
      if (newPeople.length) {
        const { error } = await supabase.from("employees").upsert(newPeople as never, { onConflict: "employee_code" });
        if (error) throw error;
        const { data, error: e2 } = await supabase.from("employees").select("*");
        if (e2) throw e2;
        fresh = data;
      }
      const recs = sheets.filter((s) => s.role === "records").flatMap((s) => parseRecords(s, fresh).ok)
        .map(({ _code, ...rest }) => rest);
      if (recs.length) {
        const { error } = await supabase.from("time_records").insert(recs as never);
        if (error) throw error;
      }
      toast.success(`Saved ${newPeople.length} people and ${recs.length} time records`);
      setSheets([]); setFile("");
      qc.invalidateQueries();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const total = newPeople.length + recCount;
  return (
    <AppShell eyebrow="Import" title="Import from CSV or Excel">
      <div className="glass-panel space-y-4 p-6">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">Drop a file with one or more sheets. You choose which sheets list people and which list hours — columns are recognised automatically.</p>
          <button onClick={template} className={btnGhost}>Download template</button>
        </div>
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) handle(f); }}
          className={`cursor-pointer rounded-xl border-2 border-dashed p-12 text-center transition-colors ${drag ? "border-primary bg-accent" : "border-primary/30 bg-accent/50"}`}
        >
          <div className="font-mono text-sm text-accent-foreground">Drop CSV / XLSX</div>
          <div className="mt-1 text-xs text-muted-foreground">or click to browse · up to 25,000 rows per sheet</div>
          <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handle(f); e.target.value = ""; }} />
        </div>
      </div>

      {file && (
        <div className="glass-panel space-y-4 p-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-mono text-[12px]">{file}</div>
              <div className="text-xs text-muted-foreground">
                {newPeople.length} people ({addedCount} new, {newPeople.length - addedCount} updated) · {recCount} time records · {errors.length} with problems
              </div>
            </div>
            <button disabled={!total || busy} onClick={commit} className={btnPrimary}>{busy ? "Importing…" : `Import ${total} rows`}</button>
          </div>

          <div className="space-y-2">
            <div className="label-mono">What's on each sheet?</div>
            {sheets.map((s) => (
              <div key={s.name} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-secondary p-3 ring-1 ring-border">
                <div className="min-w-0">
                  <div className="font-medium">{s.name} <span className="text-xs font-normal text-muted-foreground">· {s.rows.length} rows</span></div>
                  <div className="truncate text-xs text-muted-foreground">{s.headers.slice(0, 10).join(" · ") || "Empty"}</div>
                </div>
                <div className="flex rounded-xl bg-background p-1 text-xs font-medium ring-1 ring-border">
                  {(["people", "records", "ignore"] as const).map((r) => (
                    <button key={r} onClick={() => setRole(s.name, r)} disabled={!s.rows.length}
                      className={`rounded-lg px-3 py-1.5 ${s.role === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                      {r === "people" ? "People" : r === "records" ? "Hours" : "Skip"}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {newPeople.length > 0 && (
            <div className="overflow-x-auto rounded-xl ring-1 ring-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                    {["ID", "Name", "Email", "Job title", "Rate", ""].map((h) => <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="text-[13px]">
                  {newPeople.slice(0, 50).map((p) => {
                    const isNew = !employees.some((e) => e.employee_code.toLowerCase() === p.employee_code.toLowerCase());
                    return (
                      <tr key={p.employee_code} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 font-mono">{p.employee_code}</td>
                        <td className="px-3 py-2">{p.first_name} {p.last_name === "-" ? "" : p.last_name}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.email ?? "—"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.job_title ?? "—"}</td>
                        <td className="px-3 py-2 font-mono">{Number(p.hourly_rate ?? 0).toFixed(2)}</td>
                        <td className="px-3 py-2 text-xs">{isNew ? <span className="text-accent-foreground">New</span> : <span className="text-muted-foreground">Update</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {newPeople.length > 50 && <div className="px-3 py-2 text-xs text-muted-foreground">…and {newPeople.length - 50} more</div>}
            </div>
          )}

          {errors.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-auto rounded-xl bg-secondary p-3 font-mono text-[11px] text-destructive">
              {errors.slice(0, 100).map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}
    </AppShell>
  );
}
