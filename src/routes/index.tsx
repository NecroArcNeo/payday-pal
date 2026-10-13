import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Meridian Payroll — Employees, hours & pay" },
      { name: "description", content: "Store employee details, track clock-in or daily hours, import CSV/Excel timesheets and calculate pay." },
      { property: "og:title", content: "Meridian Payroll" },
      { property: "og:description", content: "Employees, work hours and pay in one live ledger." },
    ],
  }),
  component: () => <Navigate to="/dashboard" />,
});
