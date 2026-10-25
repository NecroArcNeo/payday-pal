// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FieldDef } from "@/lib/payroll";
import { fieldSuggestions, OTHER_SECTION, profileSections, sectionNames, withDefaults } from "./employee-fields";

const def = (id: string, section: string | null) => ({ id, label: id, field_type: "text", section, sort_order: 0, created_at: "" }) as FieldDef;

describe("profile sections", () => {
  it("puts categories in built-in sections (any case), then the user's own in first-use order, then Other details", () => {
    const defs = [def("a", "personal"), def("b", "Uniform"), def("c", null), def("d", "Certifications"), def("e", "uniform"), def("f", "  ")];
    const s = profileSections(defs);
    expect(s.map((x) => x.title)).toEqual(["Payroll", "Personal", "Contact", "Address", "Emergency contact", "Uniform", "Certifications", OTHER_SECTION]);
    expect(s.find((x) => x.title === "Personal")!.defs.map((d) => d.id)).toEqual(["a"]);
    expect(s.find((x) => x.title === "Uniform")).toMatchObject({ custom: true, fields: [] });
    expect(s.find((x) => x.title === "Uniform")!.defs.map((d) => d.id)).toEqual(["b", "e"]);
    expect(s.at(-1)!.defs.map((d) => d.id)).toEqual(["c", "f"]);
    expect(sectionNames(defs)).toEqual(["Payroll", "Personal", "Contact", "Address", "Emergency contact", "Uniform", "Certifications"]);
  });

  it("has the ID-document fields under Personal", () => {
    expect(profileSections([])[1]!.fields.map((f) => f.k)).toEqual(expect.arrayContaining(["passport_no", "ssn", "residential_status"]));
    expect(fieldSuggestions("residential_status", [])).toContain("Permanent resident");
  });

  it("never copies per-person ID numbers from the default profile", () => {
    expect(withDefaults({ employee_code: "E1" }, { passport_no: "X1", ssn: "123", residential_status: "Citizen" })).toEqual({ employee_code: "E1", residential_status: "Citizen" });
  });
});
