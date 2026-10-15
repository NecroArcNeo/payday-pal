create type public.app_role as enum ('admin', 'employee');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role app_role not null,
  unique (user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create policy "Users read own roles" on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  employee_code text not null unique,
  first_name text not null,
  last_name text not null,
  email text,
  department text,
  hourly_rate numeric(10,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index employees_email_unique on public.employees (lower(email)) where email is not null;
grant select, insert, update, delete on public.employees to authenticated;
grant all on public.employees to service_role;
alter table public.employees enable row level security;
create policy "Admins manage employees" on public.employees for all to authenticated
  using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
create policy "Employees view self" on public.employees for select to authenticated
  using (user_id = auth.uid());

create table public.time_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  work_date date not null,
  entry_mode text not null default 'clock' check (entry_mode in ('clock','hours')),
  clock_in time,
  clock_out time,
  lunch_minutes integer not null default 0 check (lunch_minutes >= 0),
  hours numeric(6,2) not null default 0 check (hours >= 0),
  note text,
  created_at timestamptz not null default now()
);
create index time_records_emp_date on public.time_records (employee_id, work_date);
grant select, insert, update, delete on public.time_records to authenticated;
grant all on public.time_records to service_role;
alter table public.time_records enable row level security;
create policy "Admins manage records" on public.time_records for all to authenticated
  using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
create policy "Employees view own records" on public.time_records for select to authenticated
  using (exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid()));

create or replace function public.compute_record_hours()
returns trigger language plpgsql set search_path = public as $$
declare mins numeric;
begin
  if new.entry_mode = 'clock' then
    if new.clock_in is null or new.clock_out is null then
      raise exception 'Clock in and clock out are required';
    end if;
    mins := extract(epoch from (new.clock_out - new.clock_in)) / 60;
    if mins < 0 then mins := mins + 1440; end if;
    mins := mins - coalesce(new.lunch_minutes, 0);
    if mins < 0 then raise exception 'Lunch break longer than shift'; end if;
    new.hours := round(mins / 60.0, 2);
  else
    new.clock_in := null; new.clock_out := null; new.lunch_minutes := 0;
  end if;
  return new;
end $$;
create trigger time_records_hours before insert or update on public.time_records
  for each row execute function public.compute_record_hours();

-- link employee rows to accounts by email
create or replace function public.link_employee_on_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is null and new.email is not null then
    select id into new.user_id from auth.users where lower(email) = lower(new.email) limit 1;
  end if;
  return new;
end $$;
create trigger employees_link before insert or update of email on public.employees
  for each row execute function public.link_employee_on_insert();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.user_roles where role = 'admin') then
    insert into public.user_roles (user_id, role) values (new.id, 'admin');
  else
    insert into public.user_roles (user_id, role) values (new.id, 'employee');
  end if;
  update public.employees set user_id = new.id
    where user_id is null and email is not null and lower(email) = lower(new.email);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
