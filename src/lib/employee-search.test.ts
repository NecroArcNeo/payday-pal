import { describe, expect, it } from "vitest";
import type { Employee } from "@/lib/payroll";
import { describeEmployeeFilter, employeeFacets, isFiltering, matchesEmployee, NO_FILTER, searchEmployees, type EmployeeFilter } from "./employee-search";

const e = (o: Partial<Employee>) => ({ first_name: "", last_name: "", employee_code: "", active: true, custom_fields: {}, ...o }) as Employee;
const staff = [
  e({ id: "1", first_name: "Nadia", last_name: "Okafor", employee_code: "E100", job_title: "Shift Lead", department: "Warehouse", phone: "(555) 010-0100" }),
  e({ id: "2", first_name: "Sam", last_name: "Lee", employee_code: "E200", job_title: "Picker", department: "Warehouse", custom_fields: { shirt: "XL" } }),
  e({ id: "3", first_name: "Ana", last_name: "Leeds", employee_code: "E1000", job_title: "Driver", department: "Logistics", email: "ana@example.com", active: false }),
];
const ids = (q: string) => searchEmployees(staff, q).map((x) => x.id);

describe("employee search", () => {
  it("matches name, ID, position, department, email, phone digits and categories", () => {
    expect(ids("okafor")).toEqual(["1"]);
    expect(ids("e200")).toEqual(["2"]);
    expect(ids("picker")).toEqual(["2"]);
    expect(ids("logistics")).toEqual(["3"]);
    expect(ids("ana@")).toEqual(["3"]);
    expect(ids("5550100100")).toEqual(["1"]);
    expect(ids("xl")).toEqual(["2"]);
    expect(ids("inactive")).toEqual(["3"]);
  });

  it("needs every word to match, in any field", () => {
    expect(ids("warehouse lead")).toEqual(["1"]);
    expect(ids("warehouse driver")).toEqual([]);
    expect(matchesEmployee(staff[0]!, "  ")).toBe(true);
  });

  it("puts an exact ID first, then names that start with the query", () => {
    expect(ids("E100")).toEqual(["1", "3"]);
    expect(ids("lee")).toEqual(["2", "3"]);
  });
});

describe("department and position filters", () => {
  const f = (o: Partial<EmployeeFilter>) => searchEmployees(staff, { ...NO_FILTER, ...o }).map((x) => x.id);

  it("narrows to an exact department or position, ignoring case, alongside the typed text", () => {
    expect(f({ department: "warehouse" })).toEqual(["1", "2"]);
    expect(f({ department: "Warehouse", position: "Picker" })).toEqual(["2"]);
    expect(f({ position: "Lead" })).toEqual([]);
    expect(f({ department: "Warehouse", text: "nadia" })).toEqual(["1"]);
    expect(f({ department: "Logistics", text: "nadia" })).toEqual([]);
  });

  it("lists the departments and positions in use, and describes the filter", () => {
    expect(employeeFacets([...staff, e({ department: "warehouse " })])).toEqual({ departments: ["Logistics", "Warehouse"], positions: ["Driver", "Picker", "Shift Lead"] });
    expect(describeEmployeeFilter({ text: " ada ", department: "Warehouse", position: "" })).toBe("“ada” in Warehouse");
    expect(isFiltering(NO_FILTER)).toBe(false);
  });
});
