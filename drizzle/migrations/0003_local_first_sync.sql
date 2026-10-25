-- Local-first sync: each account owns its own copy of the payroll data.
--
-- * Every table gets owner_id (defaults to the signed-in user); RLS limits
--   each account to its own rows. Primary keys become (owner_id, id) so the
--   same data can be pushed to two accounts without colliding.
-- * Existing rows are assigned to the current admin account, and a full copy
--   of them is saved to cloud_backups before anything else changes.
-- * push_snapshot / pull_snapshot / sync_status are what the app's Sync page
--   calls. Every push first copies the replaced data into cloud_backups.
--
-- The whole file runs as one transaction (drizzle-kit migrate, or a single
-- run in the Supabase SQL editor): if any statement fails, nothing changes.

-- 1. Owner column, backfilled from the admin account -------------------------
alter table public.employee_field_defs add column owner_id uuid;
alter table public.employees           add column owner_id uuid;
alter table public.time_records        add column owner_id uuid;
alter table public.pay_adjustments     add column owner_id uuid;
alter table public.payroll_settings    add column owner_id uuid;

do $$
declare admin uuid;
begin
  select user_id into admin from public.user_roles where role = 'admin' order by user_id limit 1;
  update public.employee_field_defs set owner_id = admin where owner_id is null;
  update public.employees           set owner_id = admin where owner_id is null;
  update public.time_records        set owner_id = admin where owner_id is null;
  update public.pay_adjustments     set owner_id = admin where owner_id is null;
  update public.payroll_settings    set owner_id = admin where owner_id is null;
  if exists (select 1 from public.employees where owner_id is null)
     or exists (select 1 from public.time_records where owner_id is null)
     or exists (select 1 from public.pay_adjustments where owner_id is null)
     or exists (select 1 from public.employee_field_defs where owner_id is null)
     or exists (select 1 from public.payroll_settings where owner_id is null) then
    raise exception 'Existing payroll data has no admin account to belong to. Nothing was changed.';
  end if;
end $$;

-- 2. Safety copy of the pre-migration data -----------------------------------
create table public.cloud_backups (
  id bigint generated always as identity primary key,
  owner_id uuid not null,
  created_at timestamptz not null default now(),
  reason text not null,
  version bigint not null default 0,
  snapshot jsonb not null
);
create index cloud_backups_owner on public.cloud_backups (owner_id, id desc);

insert into public.cloud_backups (owner_id, reason, snapshot)
select o.owner_id, 'before-local-first-migration', jsonb_build_object(
  'format', 'meridian-payroll-backup', 'schema_version', 1, 'created_at', now(),
  'data', jsonb_build_object(
    'employee_field_defs', coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id') from public.employee_field_defs x where x.owner_id = o.owner_id), '[]'::jsonb),
    'employees',           coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id') from public.employees x where x.owner_id = o.owner_id), '[]'::jsonb),
    'time_records',        coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id') from public.time_records x where x.owner_id = o.owner_id), '[]'::jsonb),
    'pay_adjustments',     coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id') from public.pay_adjustments x where x.owner_id = o.owner_id), '[]'::jsonb),
    'payroll_settings',    coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id') from public.payroll_settings x where x.owner_id = o.owner_id), '[]'::jsonb)))
from (select owner_id from public.employees union select owner_id from public.time_records
      union select owner_id from public.pay_adjustments union select owner_id from public.employee_field_defs
      union select owner_id from public.payroll_settings) o;

-- 3. Retire the shared admin/employee model ----------------------------------
-- (user_roles and has_role stay in place, unused, so no account data is dropped.)
drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists employees_link on public.employees;
drop function if exists public.handle_new_user();
drop function if exists public.link_employee_on_insert();

drop policy if exists "Admins manage employees" on public.employees;
drop policy if exists "Employees view self" on public.employees;
drop policy if exists "Admins manage records" on public.time_records;
drop policy if exists "Employees view own records" on public.time_records;
drop policy if exists "Admins manage field defs" on public.employee_field_defs;
drop policy if exists "Signed in read field defs" on public.employee_field_defs;
drop policy if exists "Admins manage adjustments" on public.pay_adjustments;
drop policy if exists "Employees view own adjustments" on public.pay_adjustments;
drop policy if exists "Admins manage payroll settings" on public.payroll_settings;
drop policy if exists "Signed in read payroll settings" on public.payroll_settings;

-- 4. Keys scoped by owner ----------------------------------------------------
alter table public.time_records    drop constraint time_records_employee_id_fkey;
alter table public.pay_adjustments drop constraint pay_adjustments_employee_id_fkey;
alter table public.employees       drop constraint employees_employee_code_key;
drop index public.employees_email_unique;

alter table public.employee_field_defs drop constraint employee_field_defs_pkey;
alter table public.employees           drop constraint employees_pkey;
alter table public.time_records        drop constraint time_records_pkey;
alter table public.pay_adjustments     drop constraint pay_adjustments_pkey;
alter table public.payroll_settings    drop constraint payroll_settings_pkey;

alter table public.employee_field_defs alter column owner_id set not null, alter column owner_id set default auth.uid();
alter table public.employees           alter column owner_id set not null, alter column owner_id set default auth.uid();
alter table public.time_records        alter column owner_id set not null, alter column owner_id set default auth.uid();
alter table public.pay_adjustments     alter column owner_id set not null, alter column owner_id set default auth.uid();
alter table public.payroll_settings    alter column owner_id set not null, alter column owner_id set default auth.uid();

alter table public.employee_field_defs add primary key (owner_id, id);
alter table public.employees           add primary key (owner_id, id);
alter table public.time_records        add primary key (owner_id, id);
alter table public.pay_adjustments     add primary key (owner_id, id);
alter table public.payroll_settings    add primary key (owner_id);

alter table public.employees add constraint employees_owner_code_key unique (owner_id, employee_code);
create unique index employees_owner_email_unique on public.employees (owner_id, lower(email)) where email is not null;
alter table public.time_records add constraint time_records_employee_fkey
  foreign key (owner_id, employee_id) references public.employees (owner_id, id) on delete cascade;
alter table public.pay_adjustments add constraint pay_adjustments_employee_fkey
  foreign key (owner_id, employee_id) references public.employees (owner_id, id) on delete cascade;
drop index if exists public.time_records_emp_date;
create index time_records_owner_emp_date on public.time_records (owner_id, employee_id, work_date);

-- 5. Owner-only access -------------------------------------------------------
create policy "Owner manages own field defs" on public.employee_field_defs for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Owner manages own employees" on public.employees for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Owner manages own records" on public.time_records for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Owner manages own adjustments" on public.pay_adjustments for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Owner manages own settings" on public.payroll_settings for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

alter table public.cloud_backups enable row level security;
grant select on public.cloud_backups to authenticated;
grant all on public.cloud_backups to service_role;
create policy "Owner reads own backups" on public.cloud_backups for select to authenticated
  using (owner_id = (select auth.uid()));

-- 6. Change tracking: any write by a user bumps that user's version -----------
create table public.sync_meta (
  owner_id uuid primary key,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.sync_meta enable row level security;
grant select on public.sync_meta to authenticated;
grant all on public.sync_meta to service_role;
create policy "Owner reads own sync state" on public.sync_meta for select to authenticated
  using (owner_id = (select auth.uid()));
insert into public.sync_meta (owner_id, version)
select distinct owner_id, 1 from public.cloud_backups;

create or replace function public.bump_sync_version()
returns trigger language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is not null then
    insert into public.sync_meta (owner_id, version, updated_at) values (uid, 1, now())
    on conflict (owner_id) do update set version = public.sync_meta.version + 1, updated_at = now();
  end if;
  return null;
end $$;
create trigger employee_field_defs_sync after insert or update or delete on public.employee_field_defs for each statement execute function public.bump_sync_version();
create trigger employees_sync after insert or update or delete on public.employees for each statement execute function public.bump_sync_version();
create trigger time_records_sync after insert or update or delete on public.time_records for each statement execute function public.bump_sync_version();
create trigger pay_adjustments_sync after insert or update or delete on public.pay_adjustments for each statement execute function public.bump_sync_version();
create trigger payroll_settings_sync after insert or update or delete on public.payroll_settings for each statement execute function public.bump_sync_version();

-- 7. Sync functions ----------------------------------------------------------
-- One statement, so the copy is a consistent point-in-time read.
create or replace function public.owner_snapshot(uid uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'format', 'meridian-payroll-backup', 'schema_version', 1, 'created_at', now(),
    'data', jsonb_build_object(
      'employee_field_defs', coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.employee_field_defs x where x.owner_id = uid), '[]'::jsonb),
      'employees',           coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.employees x where x.owner_id = uid), '[]'::jsonb),
      'time_records',        coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.time_records x where x.owner_id = uid), '[]'::jsonb),
      'pay_adjustments',     coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.pay_adjustments x where x.owner_id = uid), '[]'::jsonb),
      'payroll_settings',    coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.id) from public.payroll_settings x where x.owner_id = uid), '[]'::jsonb)))
$$;

create or replace function public.owner_has_data(uid uuid)
returns boolean language sql stable set search_path = public as $$
  select exists (select 1 from public.employees where owner_id = uid)
      or exists (select 1 from public.employee_field_defs where owner_id = uid)
      or exists (select 1 from public.payroll_settings where owner_id = uid)
$$;

create or replace function public.sync_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'version', coalesce((select version from public.sync_meta where owner_id = auth.uid()), 0),
    'updated_at', (select updated_at from public.sync_meta where owner_id = auth.uid()),
    'has_data', public.owner_has_data(auth.uid()),
    'schema_version', 1)
  where auth.uid() is not null
$$;

create or replace function public.pull_snapshot()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'version', coalesce((select version from public.sync_meta where owner_id = auth.uid()), 0),
    'snapshot', public.owner_snapshot(auth.uid()))
  where auth.uid() is not null
$$;

create or replace function public.push_snapshot(p_snapshot jsonb, p_expected_version bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  cur bigint;
  t text;
  expected_rows integer;
  actual_rows integer;
begin
  if uid is null then raise exception 'Sign in before pushing'; end if;
  if p_snapshot->>'format' is distinct from 'meridian-payroll-backup' or (p_snapshot->>'schema_version')::int is distinct from 1 then
    raise exception 'SCHEMA_MISMATCH: this database expects backup schema 1';
  end if;

  -- Lock this owner's version so concurrent pushes queue up, then refuse if it moved.
  insert into public.sync_meta (owner_id) values (uid) on conflict (owner_id) do nothing;
  select version into cur from public.sync_meta where owner_id = uid for update;
  if cur is distinct from p_expected_version then
    raise exception 'SYNC_CONFLICT: cloud is at version %, expected %', cur, p_expected_version;
  end if;

  if public.owner_has_data(uid) then
    insert into public.cloud_backups (owner_id, reason, version, snapshot)
    values (uid, 'before-push', cur, public.owner_snapshot(uid));
  end if;

  delete from public.pay_adjustments where owner_id = uid;
  delete from public.time_records where owner_id = uid;
  delete from public.employees where owner_id = uid;
  delete from public.employee_field_defs where owner_id = uid;
  delete from public.payroll_settings where owner_id = uid;

  foreach t in array array['employee_field_defs', 'employees', 'time_records', 'pay_adjustments', 'payroll_settings'] loop
    execute format(
      'insert into public.%1$I select * from jsonb_populate_recordset(null::public.%1$I,
         (select jsonb_agg(r || jsonb_build_object(''owner_id'', $1)) from jsonb_array_elements(coalesce($2->''data''->%2$L, ''[]''::jsonb)) r))',
      t, t) using uid, p_snapshot;
    expected_rows := jsonb_array_length(coalesce(p_snapshot->'data'->t, '[]'::jsonb));
    execute format('select count(*) from public.%I where owner_id = $1', t) into actual_rows using uid;
    if actual_rows <> expected_rows then
      raise exception 'Push check failed for %: sent % rows, stored %', t, expected_rows, actual_rows;
    end if;
  end loop;

  -- Keep the 30 most recent push backups per account (the pre-migration copy is never pruned).
  delete from public.cloud_backups where owner_id = uid and reason = 'before-push' and id not in (
    select id from public.cloud_backups where owner_id = uid and reason = 'before-push' order by id desc limit 30);

  update public.sync_meta set version = version + 1, updated_at = now() where owner_id = uid returning version into cur;
  return cur;
end $$;

revoke execute on function public.owner_snapshot(uuid), public.owner_has_data(uuid) from public, anon, authenticated;
revoke execute on function public.sync_status(), public.pull_snapshot(), public.push_snapshot(jsonb, bigint) from public, anon;
grant execute on function public.sync_status(), public.pull_snapshot(), public.push_snapshot(jsonb, bigint) to authenticated;
