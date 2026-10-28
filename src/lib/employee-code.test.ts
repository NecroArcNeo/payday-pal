import { describe, expect, it } from "vitest";
import { codeTakenMessage, employeeWithCode, friendlySaveError } from "./employee-code";

const staff = [
  { id: "1", employee_code: "E100", first_name: "Nadia", last_name: "Okafor" },
  { id: "2", employee_code: "e200", first_name: "Sam", last_name: "Lee" },
];

describe("employee IDs", () => {
  it("finds who already has an ID, ignoring case and spaces, but not the employee being edited", () => {
    expect(employeeWithCode(staff, " e100 ")?.id).toBe("1");
    expect(employeeWithCode(staff, "E200")?.id).toBe("2");
    expect(employeeWithCode(staff, "E100", "1")).toBeUndefined();
    expect(employeeWithCode(staff, "E300")).toBeUndefined();
    expect(employeeWithCode(staff, "  ")).toBeUndefined();
  });

  it("says who has it, and turns the database's refusal into plain words", () => {
    expect(codeTakenMessage(" E100", staff[0]!)).toBe('Employee ID "E100" is already used by Nadia Okafor. Each employee needs their own ID.');
    expect(friendlySaveError('duplicate key value violates unique constraint "employees_employee_code_key"')).toMatch(/already used/);
    expect(friendlySaveError("something else")).toBe("something else");
  });
});
