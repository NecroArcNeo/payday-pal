import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { localDb } from "@/lib/local-db";
import { AppShell, btnGhost, btnPrimary, inputCls } from "@/components/AppShell";
import { useEmployees, useFieldDefs, type Employee, type FieldDef } from "@/lib/payroll";
import { ChevronDown, ChevronRight, MapPin } from "lucide-react";

export const Route = createFileRoute("/_authenticated/import")({
  head: () => ({ meta: [{ title: "Import — Meridian Payroll" }] }),
  component: ImportPage,
});

type Role = "people" | "records" | "ignore";
type Row = Record<string, string>;

interface SheetInfo {
  name: string;
  rows: Row[];
  headers: string[];
  normHeaders: string[];
  role: Role;
  /** manual column mapping: normHeader -> field key */
  columnMap: Record<string, string>;
  /** row range */
  rowStart: number;
  rowEnd: number;
  /** which columns are selected for import */
  selectedColumns: string[];
  expanded: boolean;
}

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/** All mappable fields for people sheets */
const PEOPLE_FIELDS: { key: string; label: string; aliases: string[] }[] = [
  { key: "employee_code", label: "Employee ID", aliases: ["employeeid", "employeecode", "empid", "empno", "employeenumber", "staffid", "id", "code"] },
  { key: "first_name", label: "First name", aliases: ["firstname", "first", "givenname", "forename"] },
  { key: "last_name", label: "Last name", aliases: ["lastname", "last", "surname", "familyname"] },
  { key: "full_name", label: "Full name (auto-split)", aliases: ["name", "fullname", "employee", "employeename", "staffname"] },
  { key: "email", label: "Email", aliases: ["email", "emailaddress", "mail", "workemail"] },
  { key: "department", label: "Department", aliases: ["department", "dept", "team", "division"] },
  { key: "hourly_rate", label: "Hourly rate", aliases: ["hourlyrate", "rate", "payrate", "wage", "hourlywage", "perhour"] },
  { key: "phone", label: "Phone", aliases: ["phone", "phonenumber", "mobile", "cell", "telephone", "tel"] },
  { key: "job_title", label: "Job title", aliases: ["jobtitle", "title", "position", "role"] },
  { key: "address_line1", label: "Address line 1", aliases: ["address", "address1", "addressline1", "street", "streetaddress"] },
  { key: "address_line2", label: "Address line 2", aliases: ["address2", "addressline2", "apt", "suite", "unit"] },
  { key: "city", label: "City", aliases: ["city", "town"] },
  { key: "state", label: "State / Region", aliases: ["state", "province", "region", "stateregion"] },
  { key: "postal_code", label: "Postal code", aliases: ["zip", "zipcode", "postalcode", "postcode", "postal"] },
  { key: "country", label: "Country", aliases: ["country"] },
  { key: "date_of_birth", label: "Date of birth", aliases: ["dateofbirth", "dob", "birthdate", "birthday"] },
  { key: "hire_date", label: "Hire date", aliases: ["hiredate", "startdate", "datehired", "joined", "joindate"] },
  { key: "emergency_contact_name", label: "Emergency contact name", aliases: ["emergencycontact", "emergencycontactname", "emergencyname"] },
  { key: "emergency_contact_phone", label: "Emergency contact phone", aliases: ["emergencyphone", "emergencycontactphone"] },
  { key: "notes", label: "Notes", aliases: ["notes", "note", "comments"] },
];

const RECORD_FIELDS: { key: string; label: string; aliases: string[] }[] = [
  { key: "employee_code", label: "Employee ID", aliases: ["employeeid", "employeecode", "empid", "empno", "employeenumber", "staffid", "id", "code"] },
  { key: "full_name", label: "Full name", aliases: ["name", "fullname", "employee", "employeename", "staffname"] },
  { key: "first_name", label: "First name", aliases: ["firstname", "first", "givenname", "forename"] },
  { key: "last_name", label: "Last name", aliases: ["lastname", "last", "surname", "familyname"] },
  { key: "email", label: "Email", aliases: ["email", "emailaddress", "mail", "workemail"] },
  { key: "work_date", label: "Date", aliases: ["date", "workdate", "day", "shiftdate"] },
  { key: "clock_in", label: "Clock in", aliases: ["clockin", "timein", "in", "start", "starttime"] },
  { key: "clock_out", label: "Clock out", aliases: ["clockout", "timeout", "out", "end", "endtime"] },
  { key: "lunch_minutes", label: "Lunch minutes", aliases: ["lunchminutes", "lunch", "break", "breakminutes", "lunchmins"] },
  { key: "hours", label: "Hours", aliases: ["hours", "totalhours", "hoursworked", "hrs"] },
];

const allPeopleAliases = new Set(PEOPLE_FIELDS.flatMap((f) => f.aliases));
const allRecordAliases = new Set(RECORD_FIELDS.flatMap((f) => f.aliases));
const allKnownAliases = new Set([...allPeopleAliases, ...allRecordAliases]);

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

function readSheet(ws: XLSX.WorkSheet): { rows: Row[]; headers: string[]; normHeaders: string[] } {
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "", dateNF: "yyyy-mm-dd", blankrows: false });
  let best = 0, bestScore = -1;
  grid.slice(0, 15).forEach((row, i) => {
    const score = row.filter((c) => allKnownAliases.has(norm(String(c)))).length * 10 + row.filter((c) => String(c).trim()).length;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  const rawHeaders = (grid[best] ?? []).map((c) => String(c).trim());
  const normHeaders = rawHeaders.map(norm);
  const rows = grid.slice(best + 1).map((r) => {
    const o: Row = {};
    normHeaders.forEach((h, i) => { if (h) o[h] = String(r[i] ?? "").trim(); });
    return o;
  }).filter((o) => Object.values(o).some((v) => v));
  return { rows, headers: rawHeaders.filter(Boolean), normHeaders: normHeaders.filter(Boolean) };
}

function guessRole(normHeaders: string[]): Role {
  const p = normHeaders.filter((h) => allPeopleAliases.has(h)).length;
  const r = normHeaders.filter((h) => allRecordAliases.has(h)).length;
  if (!p && !r) return "ignore";
  return r > p ? "records" : "people";
}

function autoMapColumns(normHeaders: string[], role: Role): Record<string, string> {
  const fields = role === "people" ? PEOPLE_FIELDS : RECORD_FIELDS;
  const map: Record<string, string> = {};
  for (const nh of normHeaders) {
    const field = fields.find((f) => f.aliases.includes(nh));
    if (field) map[nh] = field.key;
  }
  return map;
}

type PersonRow = { [K in keyof Employee]?: Employee[K] | undefined } & { employee_code: string; first_name: string; last_name: string };

function parsePeople(
  sheet: SheetInfo,
  existing: Employee[],
  seen: PersonRow[],
  defs: FieldDef[],
  taken: Set<string>,
): { ok: PersonRow[]; errs: string[] } {
  const ok: PersonRow[] = [];
  const errs: string[] = [];
  const existByEmail = new Map(existing.filter((e) => e.email).map((e) => [e.email!.toLowerCase(), e]));
  const existByName = new Map(existing.map((e) => [`${e.first_name} ${e.last_name}`.toLowerCase(), e]));
  const seenByEmail = new Map(seen.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p]));
  const seenByName = new Map(seen.map((p) => [`${p.first_name} ${p.last_name}`.toLowerCase(), p]));
  const sheetByEmail = new Map<string, PersonRow>();
  const sheetByName = new Map<string, PersonRow>();
  let n = existing.length + seen.length + 1;

  const start = Math.max(0, sheet.rowStart - 1);
  const end = Math.min(sheet.rows.length, sheet.rowEnd);
  const selectedCols = sheet.selectedColumns.length ? sheet.selectedColumns : sheet.normHeaders;

  sheet.rows.slice(start, end).forEach((r, i) => {
    const line = `${sheet.name} row ${start + i + 2}`;
    const get = (fieldKey: string): string => {
      const nh = Object.entries(sheet.columnMap).find(([, k]) => k === fieldKey)?.[0];
      if (!nh) return "";
      return r[nh] ?? "";
    };

    let first = get("first_name");
    let last = get("last_name");
    if (!first && !last) {
      const full = get("full_name");
      if (full.includes(",")) { [last = "", first = ""] = full.split(",").map((s) => s.trim()); }
      else { const parts = full.split(/\s+/); first = parts[0] ?? ""; last = parts.slice(1).join(" "); }
    }
    if (!first) { errs.push(`${line}: no name found`); return; }
    if (!last) last = "-";

    const email = get("email");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { errs.push(`${line}: invalid email "${email}"`); return; }
    const emailKey = email ? email.toLowerCase() : "";
    const nameKey = `${first} ${last}`.toLowerCase();
    if ((emailKey && (seenByEmail.has(emailKey) || sheetByEmail.has(emailKey))) || seenByName.has(nameKey) || sheetByName.has(nameKey)) {
      errs.push(`${line}: duplicate employee "${first} ${last === "-" ? "" : last}"${emailKey ? ` <${email}>` : ""} — skipped`);
      return;
    }

    const rateRaw = get("hourly_rate").replace(/[$,\s]/g, "");
    const rate = Number(rateRaw || 0);
    if (rateRaw && (!Number.isFinite(rate) || rate < 0)) { errs.push(`${line}: invalid hourly rate`); return; }
    const match = (emailKey && existByEmail.get(emailKey)) || existByName.get(nameKey);
    let code = get("employee_code") || match?.employee_code || "";
    if (!code) { do { code = `E${String(n++).padStart(3, "0")}`; } while (taken.has(code.toLowerCase())); }
    if (taken.has(code.toLowerCase()) && !match && !get("employee_code")) { errs.push(`${line}: duplicate ID ${code}`); return; }
    taken.add(code.toLowerCase());

    const opt = (fieldKey: string, max = 200) => {
      const v = get(fieldKey).slice(0, max);
      return v || undefined;
    };
    const d = (fieldKey: string) => parseDate(get(fieldKey)) ?? undefined;

    const row: PersonRow = {
      employee_code: code.slice(0, 40),
      first_name: first.slice(0, 80),
      last_name: last.slice(0, 80),
      email: email || match?.email || null,
      hourly_rate: rateRaw ? rate : Number(match?.hourly_rate ?? 0),
      department: opt("department", 80),
      phone: opt("phone", 40),
      job_title: opt("job_title", 80),
      address_line1: opt("address_line1"),
      address_line2: opt("address_line2"),
      city: opt("city", 80),
      state: opt("state", 80),
      postal_code: opt("postal_code", 20),
      country: opt("country", 80),
      date_of_birth: d("date_of_birth"),
      hire_date: d("hire_date"),
      emergency_contact_name: opt("emergency_contact_name", 120),
      emergency_contact_phone: opt("emergency_contact_phone", 40),
      notes: opt("notes", 2000),
      custom_fields: {},
    };
    for (const k of Object.keys(row) as (keyof PersonRow)[]) if (row[k] === undefined) delete row[k];
    ok.push(row);
    if (emailKey) sheetByEmail.set(emailKey, row);
    sheetByName.set(nameKey, row);
  });
  return { ok, errs };
}

function parseRecords(
  sheet: SheetInfo,
  people: { id?: string | undefined; employee_code: string; email?: string | null | undefined; first_name: string; last_name: string }[],
): { ok: Record<string, unknown>[]; errs: string[] } {
  const ok: Record<string, unknown>[] = [];
  const errs: string[] = [];
  const byCode = new Map(people.map((e) => [e.employee_code.toLowerCase(), e]));
  const byEmail = new Map(people.filter((e) => e.email).map((e) => [e.email!.toLowerCase(), e]));
  const byName = new Map(people.map((e) => [`${e.first_name} ${e.last_name}`.toLowerCase(), e]));

  const start = Math.max(0, sheet.rowStart - 1);
  const end = Math.min(sheet.rows.length, sheet.rowEnd);

  sheet.rows.slice(start, end).forEach((r, i) => {
    const line = `${sheet.name} row ${start + i + 2}`;
    const get = (fieldKey: string): string => {
      const nh = Object.entries(sheet.columnMap).find(([, k]) => k === fieldKey)?.[0];
      if (!nh) return "";
      return r[nh] ?? "";
    };

    const code = get("employee_code").toLowerCase();
    const email = get("email").toLowerCase();
    const name = (get("full_name") || `${get("first_name")} ${get("last_name")}`).trim().toLowerCase();
    const emp = byCode.get(code) ?? byEmail.get(email) ?? byName.get(name);
    if (!emp) { errs.push(`${line}: unknown employee "${code || email || name}"`); return; }

    const date = parseDate(get("work_date"));
    if (!date) { errs.push(`${line}: invalid or missing date`); return; }

    const cin = parseTime(get("clock_in"));
    const cout = parseTime(get("clock_out"));
    const base = { employee_id: emp.id, _code: emp.employee_code, work_date: date };
    if (cin && cout) {
      const lunch = Number(get("lunch_minutes") || 0);
      if (!Number.isFinite(lunch) || lunch < 0 || lunch > 600) { errs.push(`${line}: invalid lunch minutes`); return; }
      ok.push({ ...base, entry_mode: "clock", clock_in: cin, clock_out: cout, lunch_minutes: lunch });
    } else {
      const hours = Number(get("hours"));
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
      const list: SheetInfo[] = wb.SheetNames.map((name) => {
        const { rows, headers, normHeaders } = readSheet(wb.Sheets[name]!);
        const role = rows.length ? guessRole(normHeaders) : ("ignore" as Role);
        const columnMap = autoMapColumns(normHeaders, role);
        return {
          name, rows, headers, normHeaders, role, columnMap,
          rowStart: 1, rowEnd: Math.min(rows.length, 25000),
          selectedColumns: [...normHeaders],
          expanded: false,
        };
      });
      if (!list.some((s) => s.rows.length)) { toast.error("No tables found in this file"); return; }
      setFile(f.name);
      setSheets(list);
    } catch {
      toast.error("Couldn't read that file");
    }
  };

  const updateSheet = (name: string, patch: Partial<SheetInfo>) =>
    setSheets((s) => s.map((x) => (x.name === name ? { ...x, ...patch } : x)));

  const setRole = (name: string, role: Role) => {
    const sheet = sheets.find((s) => s.name === name);
    if (!sheet) return;
    updateSheet(name, { role, columnMap: autoMapColumns(sheet.normHeaders, role) });
  };

  const toggleColumn = (name: string, nh: string) => {
    const sheet = sheets.find((s) => s.name === name);
    if (!sheet) return;
    const on = sheet.selectedColumns.includes(nh);
    updateSheet(name, {
      selectedColumns: on ? sheet.selectedColumns.filter((c) => c !== nh) : [...sheet.selectedColumns, nh],
    });
  };

  const setColumnMapping = (name: string, nh: string, fieldKey: string) => {
    const sheet = sheets.find((s) => s.name === name);
    if (!sheet) return;
    const newMap = { ...sheet.columnMap };
    // Remove any existing mapping to this field from other columns
    for (const [k, v] of Object.entries(newMap)) {
      if (v === fieldKey && k !== nh) delete newMap[k];
    }
    if (fieldKey === "") delete newMap[nh];
    else newMap[nh] = fieldKey;
    updateSheet(name, { columnMap: newMap });
  };

  // Compute parsed results from current sheets
  const { newPeople, recCount, errors, addedCount } = useMemo(() => {
    const taken = new Set(employees.map((e) => e.employee_code.toLowerCase()));
    const accumulated: PersonRow[] = [];
    const allErrs: string[] = [];
    let recTotal = 0;

    for (const s of sheets.filter((x) => x.role === "people")) {
      const res = parsePeople(s, employees, accumulated, defs, taken);
      accumulated.push(...res.ok);
      allErrs.push(...res.errs);
    }
    const pool = [...employees, ...accumulated.filter((p) => !employees.some((e) => e.employee_code === p.employee_code))];
    for (const s of sheets.filter((x) => x.role === "records")) {
      const res = parseRecords(s, pool);
      recTotal += res.ok.length;
      allErrs.push(...res.errs);
    }
    const added = accumulated.filter((p) => !employees.some((e) => e.employee_code.toLowerCase() === p.employee_code.toLowerCase())).length;
    return { newPeople: accumulated, recCount: recTotal, errors: allErrs, addedCount: added };
  }, [sheets, employees, defs]);

  const commit = async () => {
    setBusy(true);
    try {
      let fresh = employees;
      if (newPeople.length) {
        for (const p of newPeople) await localDb.upsertEmployee(p as never);
        fresh = await localDb.getEmployees();
      }
      const recs = sheets.filter((s) => s.role === "records").flatMap((s) => parseRecords(s, fresh).ok)
        .map(({ _code, ...rest }) => rest);
      if (recs.length) await localDb.insertRecords(recs as never);
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
          <p className="text-sm text-muted-foreground">
            Drop a file with one or more sheets. You choose which sheets to import, which columns map to which fields, and which rows to include.
          </p>
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

          {/* Sheet list with role selection */}
          <div className="space-y-2">
            <div className="label-mono">Sheets in this file</div>
            {sheets.map((s) => (
              <div key={s.name} className="rounded-xl bg-secondary ring-1 ring-border overflow-hidden">
                {/* Sheet header row */}
                <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <button
                      onClick={() => updateSheet(s.name, { expanded: !s.expanded })}
                      className="flex items-center gap-2 text-left"
                    >
                      {s.expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                      <div>
                        <div className="font-medium">{s.name} <span className="text-xs font-normal text-muted-foreground">· {s.rows.length} rows · {s.headers.length} columns</span></div>
                        <div className="truncate text-xs text-muted-foreground">{s.headers.slice(0, 8).join(" · ") || "Empty"}</div>
                      </div>
                    </button>
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

                {/* Expanded sheet config */}
                {s.expanded && s.role !== "ignore" && (
                  <div className="space-y-4 border-t border-border p-4">
                    {/* Row range */}
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="label-mono">Rows to import</span>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        From
                        <input
                          type="number" min={1} max={s.rows.length}
                          className={`${inputCls} max-w-[6rem] py-1`}
                          value={s.rowStart}
                          onChange={(e) => updateSheet(s.name, { rowStart: Math.max(1, Math.min(Number(e.target.value), s.rows.length)) })}
                        />
                      </label>
                      <span className="text-muted-foreground">→</span>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        To
                        <input
                          type="number" min={1} max={s.rows.length}
                          className={`${inputCls} max-w-[6rem] py-1`}
                          value={s.rowEnd}
                          onChange={(e) => updateSheet(s.name, { rowEnd: Math.max(1, Math.min(Number(e.target.value), s.rows.length)) })}
                        />
                      </label>
                      <span className="text-xs text-muted-foreground">of {s.rows.length} total</span>
                    </div>

                    {/* Column mapping */}
                    <div>
                      <div className="mb-2 flex items-center gap-2">
                        <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="label-mono">Column mapping</span>
                        <span className="text-xs text-muted-foreground">— assign each column to a field, or set to "—" to skip it</span>
                      </div>
                      <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                        {s.normHeaders.map((nh, i) => {
                          const mapped = s.columnMap[nh] ?? "";
                          const isSelected = s.selectedColumns.includes(nh);
                          const fieldList = s.role === "people" ? PEOPLE_FIELDS : RECORD_FIELDS;
                          return (
                            <div key={nh} className={`rounded-lg p-2 ring-1 ${isSelected ? "bg-background ring-primary/30" : "bg-secondary ring-border opacity-50"}`}>
                              <div className="flex items-center justify-between gap-2">
                                <label className="flex items-center gap-2 text-xs">
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleColumn(s.name, nh)}
                                    className="h-3.5 w-3.5"
                                  />
                                  <span className="font-mono text-[11px] text-foreground">{s.headers[i]}</span>
                                </label>
                              </div>
                              <select
                                value={mapped}
                                onChange={(e) => setColumnMapping(s.name, nh, e.target.value)}
                                disabled={!isSelected}
                                className={`${inputCls} mt-1.5 py-1 text-xs`}
                              >
                                <option value="">— Skip this column —</option>
                                {fieldList.map((f) => (
                                  <option key={f.key} value={f.key}>{f.label}</option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Data preview */}
                    <div>
                      <div className="label-mono mb-2">Preview · first 5 rows</div>
                      <div className="overflow-x-auto rounded-lg ring-1 ring-border">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="border-b border-border bg-secondary font-mono uppercase tracking-wider text-muted-foreground">
                              {s.normHeaders.filter((nh) => s.selectedColumns.includes(nh)).map((nh, i) => {
                                const origHeader = s.headers[s.normHeaders.indexOf(nh)];
                                const mapped = s.columnMap[nh];
                                return (
                                  <th key={nh} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">
                                    {origHeader}
                                    {mapped && <span className="ml-1 text-accent-foreground">→ {mapped}</span>}
                                  </th>
                                );
                              })}
                            </tr>
                          </thead>
                          <tbody className="font-mono">
                            {s.rows.slice(Math.max(0, s.rowStart - 1), Math.min(s.rowStart + 4, s.rowEnd)).map((r, i) => (
                              <tr key={i} className="border-b border-border last:border-0">
                                {s.normHeaders.filter((nh) => s.selectedColumns.includes(nh)).map((nh) => (
                                  <td key={nh} className="px-2 py-1 whitespace-nowrap text-muted-foreground max-w-[12rem] truncate">{r[nh] || "—"}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
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
