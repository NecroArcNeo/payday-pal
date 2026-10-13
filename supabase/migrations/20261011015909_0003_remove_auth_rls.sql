/*
# Remove authentication-based RLS policies — switch to local/no-auth mode

## Summary
This app is being converted from a multi-user authenticated app to a local single-user app
with no sign-in screen. All RLS policies that checked `auth.uid()` or `has_role()` are being
replaced with policies that allow the `anon` role full CRUD access, since the anon-key
frontend client is now the only client.

## Changes
1. employees — drop existing admin/employee-scoped policies; add anon+authenticated CRUD policies
2. time_records — drop existing admin/employee-scoped policies; add anon+authenticated CRUD policies
3. employee_field_defs — drop existing admin/read policies; add anon+authenticated CRUD policies
4. pay_adjustments — drop existing admin/employee policies; add anon+authenticated CRUD policies
5. payroll_settings — drop existing admin/read policies; add anon+authenticated CRUD policies
6. user_roles — grant select to anon (kept for backward compat; no longer used by frontend)

## Security
- Data is intentionally shared/public for this local app — USING (true) is correct here.
- All policies use TO anon, authenticated so the anon-key client can read and write.
*/

-- employees
DROP POLICY IF EXISTS "Admins manage employees" ON public.employees;
DROP POLICY IF EXISTS "Employees view self" ON public.employees;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees TO anon, authenticated;
DROP POLICY IF EXISTS "anon_select_employees" ON public.employees;
CREATE POLICY "anon_select_employees" ON public.employees FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_employees" ON public.employees;
CREATE POLICY "anon_insert_employees" ON public.employees FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_employees" ON public.employees;
CREATE POLICY "anon_update_employees" ON public.employees FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_employees" ON public.employees;
CREATE POLICY "anon_delete_employees" ON public.employees FOR DELETE
  TO anon, authenticated USING (true);

-- time_records
DROP POLICY IF EXISTS "Admins manage records" ON public.time_records;
DROP POLICY IF EXISTS "Employees view own records" ON public.time_records;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.time_records TO anon, authenticated;
DROP POLICY IF EXISTS "anon_select_time_records" ON public.time_records;
CREATE POLICY "anon_select_time_records" ON public.time_records FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_time_records" ON public.time_records;
CREATE POLICY "anon_insert_time_records" ON public.time_records FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_time_records" ON public.time_records;
CREATE POLICY "anon_update_time_records" ON public.time_records FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_time_records" ON public.time_records;
CREATE POLICY "anon_delete_time_records" ON public.time_records FOR DELETE
  TO anon, authenticated USING (true);

-- employee_field_defs
DROP POLICY IF EXISTS "Admins manage field defs" ON public.employee_field_defs;
DROP POLICY IF EXISTS "Signed in read field defs" ON public.employee_field_defs;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_field_defs TO anon, authenticated;
DROP POLICY IF EXISTS "anon_select_field_defs" ON public.employee_field_defs;
CREATE POLICY "anon_select_field_defs" ON public.employee_field_defs FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_field_defs" ON public.employee_field_defs;
CREATE POLICY "anon_insert_field_defs" ON public.employee_field_defs FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_field_defs" ON public.employee_field_defs;
CREATE POLICY "anon_update_field_defs" ON public.employee_field_defs FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_field_defs" ON public.employee_field_defs;
CREATE POLICY "anon_delete_field_defs" ON public.employee_field_defs FOR DELETE
  TO anon, authenticated USING (true);

-- pay_adjustments
DROP POLICY IF EXISTS "Admins manage adjustments" ON public.pay_adjustments;
DROP POLICY IF EXISTS "Employees view own adjustments" ON public.pay_adjustments;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pay_adjustments TO anon, authenticated;
DROP POLICY IF EXISTS "anon_select_pay_adjustments" ON public.pay_adjustments;
CREATE POLICY "anon_select_pay_adjustments" ON public.pay_adjustments FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_pay_adjustments" ON public.pay_adjustments;
CREATE POLICY "anon_insert_pay_adjustments" ON public.pay_adjustments FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_pay_adjustments" ON public.pay_adjustments;
CREATE POLICY "anon_update_pay_adjustments" ON public.pay_adjustments FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_pay_adjustments" ON public.pay_adjustments;
CREATE POLICY "anon_delete_pay_adjustments" ON public.pay_adjustments FOR DELETE
  TO anon, authenticated USING (true);

-- payroll_settings
DROP POLICY IF EXISTS "Admins manage payroll settings" ON public.payroll_settings;
DROP POLICY IF EXISTS "Signed in read payroll settings" ON public.payroll_settings;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_settings TO anon, authenticated;
DROP POLICY IF EXISTS "anon_select_payroll_settings" ON public.payroll_settings;
CREATE POLICY "anon_select_payroll_settings" ON public.payroll_settings FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_payroll_settings" ON public.payroll_settings;
CREATE POLICY "anon_insert_payroll_settings" ON public.payroll_settings FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_payroll_settings" ON public.payroll_settings;
CREATE POLICY "anon_update_payroll_settings" ON public.payroll_settings FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_payroll_settings" ON public.payroll_settings;
CREATE POLICY "anon_delete_payroll_settings" ON public.payroll_settings FOR DELETE
  TO anon, authenticated USING (true);

-- user_roles: grant anon read access for backward compat
GRANT SELECT ON public.user_roles TO anon;
