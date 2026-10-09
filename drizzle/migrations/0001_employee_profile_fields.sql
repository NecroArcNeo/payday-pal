ALTER TABLE public.employees
  ADD COLUMN phone text,
  ADD COLUMN job_title text,
  ADD COLUMN address_line1 text,
  ADD COLUMN address_line2 text,
  ADD COLUMN city text,
  ADD COLUMN state text,
  ADD COLUMN postal_code text,
  ADD COLUMN country text,
  ADD COLUMN date_of_birth date,
  ADD COLUMN hire_date date,
  ADD COLUMN emergency_contact_name text,
  ADD COLUMN emergency_contact_phone text,
  ADD COLUMN notes text;