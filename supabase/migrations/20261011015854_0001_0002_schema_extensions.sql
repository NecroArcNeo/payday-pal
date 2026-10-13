ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS job_title text,
  ADD COLUMN IF NOT EXISTS address_line1 text,
  ADD COLUMN IF NOT EXISTS address_line2 text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS hire_date date,
  ADD COLUMN IF NOT EXISTS emergency_contact_name text,
  ADD COLUMN IF NOT EXISTS emergency_contact_phone text,
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.employee_field_defs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  field_type text NOT NULL DEFAULT 'text',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_field_defs TO authenticated;
GRANT ALL ON public.employee_field_defs TO service_role;
ALTER TABLE public.employee_field_defs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins manage field defs" ON public.employee_field_defs;
CREATE POLICY "Admins manage field defs" ON public.employee_field_defs FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
DROP POLICY IF EXISTS "Signed in read field defs" ON public.employee_field_defs;
CREATE POLICY "Signed in read field defs" ON public.employee_field_defs FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.pay_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  pay_date date NOT NULL,
  category text NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pay_adjustments TO authenticated;
GRANT ALL ON public.pay_adjustments TO service_role;
ALTER TABLE public.pay_adjustments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins manage adjustments" ON public.pay_adjustments;
CREATE POLICY "Admins manage adjustments" ON public.pay_adjustments FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
DROP POLICY IF EXISTS "Employees view own adjustments" ON public.pay_adjustments;
CREATE POLICY "Employees view own adjustments" ON public.pay_adjustments FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.employees e WHERE e.id = pay_adjustments.employee_id AND e.user_id = auth.uid()));

CREATE TABLE IF NOT EXISTS public.payroll_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  ot_threshold numeric NOT NULL DEFAULT 40,
  ot_multiplier numeric NOT NULL DEFAULT 1.5,
  visible_columns text[] NOT NULL DEFAULT ARRAY['employee_code','days']::text[],
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.payroll_settings TO authenticated;
GRANT ALL ON public.payroll_settings TO service_role;
ALTER TABLE public.payroll_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins manage payroll settings" ON public.payroll_settings;
CREATE POLICY "Admins manage payroll settings" ON public.payroll_settings FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
DROP POLICY IF EXISTS "Signed in read payroll settings" ON public.payroll_settings;
CREATE POLICY "Signed in read payroll settings" ON public.payroll_settings FOR SELECT TO authenticated USING (true);
