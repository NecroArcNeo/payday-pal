import { fullName, type Employee } from "@/lib/payroll";

// Employee IDs must be unique. The database only refuses exact repeats, so "E1" and "e1 " are caught here,
// where an ID is typed, with a message that says who already has it.

const norm = (code: string) => code.trim().toLowerCase();

/** The employee already using this ID, ignoring case and surrounding spaces. `exceptId` skips the employee being edited. */
export function employeeWithCode<T extends Pick<Employee, "id" | "employee_code" | "first_name" | "last_name">>(employees: T[], code: string, exceptId?: string): T | undefined {
  const c = norm(code);
  return c ? employees.find((e) => e.id !== exceptId && norm(e.employee_code) === c) : undefined;
}

export const codeTakenMessage = (code: string, owner: Pick<Employee, "first_name" | "last_name">) =>
  `Employee ID "${code.trim()}" is already used by ${fullName(owner)}. Each employee needs their own ID.`;

/** The database's own refusal of a repeated ID, in plain words (for the rare case the check above missed it, e.g. an edit made elsewhere). */
export const friendlySaveError = (message: string) =>
  /employee_code|owner_code/.test(message) && /duplicate|unique/i.test(message) ? "That employee ID is already used by someone else. Each employee needs their own ID." : message;
