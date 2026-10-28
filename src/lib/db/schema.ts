// Local (on-device) database schema. Mirrors the cloud tables in
// drizzle/migrations minus auth/RLS/owner columns, so a snapshot moves between
// the two without translation. Bump SCHEMA_VERSION (here and in the cloud
// sync functions) whenever a table's columns change.
export const SCHEMA_VERSION = 10;

/** Tables in foreign-key order: parents first. Deletes run in reverse. */
export const TABLES = ["employee_field_defs", "shifts", "employees", "pay_rates", "time_records", "pay_adjustments", "payroll_settings"] as const;
export type TableName = (typeof TABLES)[number];

/** Each entry runs once, in order, inside a transaction. Never edit a shipped entry — append a new one. */
export const LOCAL_MIGRATIONS: string[] = [
  /* 1 */ `
  create table _meta (key text primary key, value text not null);
  insert into _meta values ('change_seq', '0');

  create table employee_field_defs (
    id uuid primary key default gen_random_uuid(),
    label text not null,
    field_type text not null default 'text',
    sort_order integer not null default 0,
    created_at timestamptz not null default now()
  );

  create table employees (
    id uuid primary key default gen_random_uuid(),
    user_id uuid,
    employee_code text not null unique,
    first_name text not null,
    last_name text not null,
    email text,
    department text,
    hourly_rate numeric(10,2) not null default 0,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    phone text, job_title text, address_line1 text, address_line2 text, city text, state text,
    postal_code text, country text, date_of_birth date, hire_date date,
    emergency_contact_name text, emergency_contact_phone text, notes text,
    custom_fields jsonb not null default '{}'::jsonb
  );
  create unique index employees_email_unique on employees (lower(email)) where email is not null;

  create table time_records (
    id uuid primary key default gen_random_uuid(),
    employee_id uuid not null references employees(id) on delete cascade,
    work_date date not null,
    entry_mode text not null default 'clock' check (entry_mode in ('clock','hours')),
    clock_in time,
    clock_out time,
    lunch_minutes integer not null default 0 check (lunch_minutes >= 0),
    hours numeric(6,2) not null default 0 check (hours >= 0),
    note text,
    created_at timestamptz not null default now()
  );
  create index time_records_emp_date on time_records (employee_id, work_date);

  create table pay_adjustments (
    id uuid primary key default gen_random_uuid(),
    employee_id uuid not null references employees(id) on delete cascade,
    pay_date date not null,
    category text not null,
    amount numeric not null default 0,
    note text,
    created_at timestamptz not null default now()
  );

  create table payroll_settings (
    id boolean primary key default true check (id),
    ot_threshold numeric not null default 40,
    ot_multiplier numeric not null default 1.5,
    visible_columns text[] not null default array['employee_code','days']::text[],
    updated_at timestamptz not null default now()
  );

  -- Same formula as the cloud trigger, so imports and manual entries agree on both sides.
  create function compute_record_hours() returns trigger language plpgsql as $$
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
  create trigger time_records_hours before insert or update on time_records
    for each row execute function compute_record_hours();

  -- Any write bumps change_seq, so sync can tell whether local data changed since the last push/pull.
  create function bump_change_seq() returns trigger language plpgsql as $$
  begin
    update _meta set value = (value::bigint + 1)::text where key = 'change_seq';
    return null;
  end $$;
  create trigger employee_field_defs_seq after insert or update or delete on employee_field_defs for each statement execute function bump_change_seq();
  create trigger employees_seq after insert or update or delete on employees for each statement execute function bump_change_seq();
  create trigger time_records_seq after insert or update or delete on time_records for each statement execute function bump_change_seq();
  create trigger pay_adjustments_seq after insert or update or delete on pay_adjustments for each statement execute function bump_change_seq();
  create trigger payroll_settings_seq after insert or update or delete on payroll_settings for each statement execute function bump_change_seq();
  `,
  /* 2 — shifts with pay multipliers, manual day pay, weekend overtime */ `
  create table shifts (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    multiplier numeric(6,3) not null default 1 check (multiplier > 0 and multiplier <= 10),
    sort_order integer not null default 0,
    created_at timestamptz not null default now()
  );
  create trigger shifts_seq after insert or update or delete on shifts for each statement execute function bump_change_seq();
  insert into shifts (name, multiplier, sort_order) values ('Day', 1, 0), ('Night', 1, 1);

  -- Deleting a shift moves its employees back to the default (first) shift.
  alter table employees add column shift_id uuid references shifts(id) on delete set null;
  update employees set shift_id = (select id from shifts where name = 'Day');

  -- When set, the day is paid exactly this amount instead of the calculated pay.
  alter table time_records add column pay_override numeric(10,2) check (pay_override >= 0);

  alter table payroll_settings add column weekend_overtime boolean not null default true;
  `,
  /* 3 — hourly or salaried employees */ `
  -- Salaried employees are paid a full week (the overtime threshold, 40 h) at their rate for every week they work.
  alter table employees add column pay_type text not null default 'hourly' check (pay_type in ('hourly', 'salary'));
  `,
  /* 4 — gender and nationality on profiles (free text) */ `
  alter table employees add column gender text, add column nationality text;
  `,
  /* 5 — default profile for new employees */ `
  -- Values every new employee starts with: employee columns plus custom_fields, keyed like the employees row.
  alter table payroll_settings add column employee_defaults jsonb not null default '{}'::jsonb;
  `,
  /* 6 — ID documents on profiles, and sections for custom categories */ `
  alter table employees add column passport_no text, add column ssn text, add column residential_status text;
  -- Which profile section a category shows under: a built-in section's title, or a name the user made up. Null = "Other details".
  alter table employee_field_defs add column section text;
  `,
  /* 7 — a day can be worked on a different shift than the employee's own */ `
  -- Null = the employee's own shift. Deleting a shift puts its days back on the employee's shift.
  alter table time_records add column shift_id uuid references shifts(id) on delete set null;
  `,
  /* 8 — a shift's usual start, end and break, used to fill in new time records */ `
  -- All optional: a shift without them leaves the times to whoever adds the record.
  alter table shifts
    add column default_clock_in time,
    add column default_clock_out time,
    add column default_lunch_minutes integer check (default_lunch_minutes between 0 and 600);
  `,
  /* 9 — pay rate history, so a raise doesn't change what past days paid */ `
  -- "From this day, this rate." A day is paid at the latest rate starting on or before it; days before the first entry
  -- at the first entry's rate. An employee with no entries is paid employees.hourly_rate every day, which is also
  -- always the latest entry's rate (entries can't start after today).
  create table pay_rates (
    id uuid primary key default gen_random_uuid(),
    employee_id uuid not null references employees(id) on delete cascade,
    effective_from date not null,
    hourly_rate numeric(10,2) not null check (hourly_rate >= 0),
    created_at timestamptz not null default now(),
    unique (employee_id, effective_from)
  );
  create trigger pay_rates_seq after insert or update or delete on pay_rates for each statement execute function bump_change_seq();

  -- However a rate is changed (profile, bulk edit, import), the old one is kept for the days before: the first
  -- change keeps the old rate for every earlier day, and a change the app didn't already date starts today.
  create function record_rate_change() returns trigger language plpgsql as $$
  begin
    if new.hourly_rate is not distinct from old.hourly_rate then return null; end if;
    insert into pay_rates (employee_id, effective_from, hourly_rate)
      select old.id, date '0001-01-01', old.hourly_rate
      where not exists (select 1 from pay_rates where employee_id = old.id);
    if (select hourly_rate from pay_rates where employee_id = new.id order by effective_from desc limit 1) is distinct from new.hourly_rate then
      insert into pay_rates (employee_id, effective_from, hourly_rate) values (new.id, current_date, new.hourly_rate)
        on conflict (employee_id, effective_from) do update set hourly_rate = excluded.hourly_rate;
    end if;
    return null;
  end $$;
  create trigger employees_rate_history after update of hourly_rate on employees for each row execute function record_rate_change();
  `,
  /* 10 — lock paid days: nothing on or before payroll_settings.locked_through can be added, changed or deleted */ `
  alter table payroll_settings add column locked_through date;

  -- Refuses a write touching a locked day. tg_argv[0] is the row's date column. Restores replace everything
  -- (settings first), so they never meet a lock; the setting meridian.bypass_lock lets a trigger write what changes no paid day.
  create function refuse_locked() returns trigger language plpgsql as $$
  declare
    lim date := (select locked_through from payroll_settings limit 1);
  begin
    if lim is null or coalesce(current_setting('meridian.bypass_lock', true), '') = 'on' then return null; end if;
    if (tg_op <> 'INSERT' and (to_jsonb(old)->>tg_argv[0])::date <= lim) or (tg_op <> 'DELETE' and (to_jsonb(new)->>tg_argv[0])::date <= lim) then
      raise exception 'Days up to % are locked as paid. Unlock them on the Payroll page to change them.', to_char(lim, 'Dy YYYY-MM-DD');
    end if;
    return null;
  end $$;
  create trigger time_records_lock after insert or update or delete on time_records for each row execute function refuse_locked('work_date');
  create trigger pay_adjustments_lock after insert or update or delete on pay_adjustments for each row execute function refuse_locked('pay_date');

  -- A rate entry starting on or before the lock changes what locked days paid, except the first change of a rate
  -- keeping the current one "since the start" (rate unchanged for every locked day).
  create function refuse_locked_rate() returns trigger language plpgsql as $$
  declare
    lim date := (select locked_through from payroll_settings limit 1);
  begin
    if lim is null or coalesce(current_setting('meridian.bypass_lock', true), '') = 'on' then return null; end if;
    if tg_op = 'INSERT' and new.effective_from = date '0001-01-01'
       and new.hourly_rate = (select hourly_rate from employees where id = new.employee_id)
       and not exists (select 1 from pay_rates where employee_id = new.employee_id and id <> new.id) then return null; end if;
    if (tg_op <> 'INSERT' and old.effective_from <= lim) or (tg_op <> 'DELETE' and new.effective_from <= lim) then
      raise exception 'Days up to % are locked as paid, so their pay rate can''t change. Unlock them on the Payroll page first.', to_char(lim, 'Dy YYYY-MM-DD');
    end if;
    return null;
  end $$;
  create trigger pay_rates_lock after insert or update or delete on pay_rates for each row execute function refuse_locked_rate();

  -- The rate trigger keeps the old rate "since the start" after the employee row already has the new one, which the
  -- check above can't tell apart from a real change, so it writes that entry with the lock bypassed.
  create or replace function record_rate_change() returns trigger language plpgsql as $$
  declare
    was text := coalesce(current_setting('meridian.bypass_lock', true), '');
  begin
    if new.hourly_rate is not distinct from old.hourly_rate then return null; end if;
    perform set_config('meridian.bypass_lock', 'on', true);
    insert into pay_rates (employee_id, effective_from, hourly_rate)
      select old.id, date '0001-01-01', old.hourly_rate
      where not exists (select 1 from pay_rates where employee_id = old.id);
    perform set_config('meridian.bypass_lock', was, true);
    if (select hourly_rate from pay_rates where employee_id = new.id order by effective_from desc limit 1) is distinct from new.hourly_rate then
      insert into pay_rates (employee_id, effective_from, hourly_rate) values (new.id, current_date, new.hourly_rate)
        on conflict (employee_id, effective_from) do update set hourly_rate = excluded.hourly_rate;
    end if;
    return null;
  end $$;
  `,
];
