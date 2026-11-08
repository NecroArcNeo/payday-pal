-- Public holidays (each with its own pay rules: a rate for hours worked that day, and the hours paid to people who
-- are off) and saved weekly patterns (a usual week, and who works it). Backup schema becomes 14 (the app upgrades older
-- backups when restoring). Runs as one transaction: if any statement fails, nothing changes.

-- 1. The tables ---------------------------------------------------------------
create table public.holidays (
  owner_id uuid not null default auth.uid(),
  id uuid not null default gen_random_uuid(),
  holiday_date date not null,
  name text not null check (length(trim(name)) between 1 and 60),
  multiplier numeric(6,3) not null default 1 check (multiplier between 1 and 10),
  paid_hours numeric(5,2) not null default 0 check (paid_hours between 0 and 24),
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  unique (owner_id, holiday_date)
);

create table public.work_patterns (
  owner_id uuid not null default auth.uid(),
  id uuid not null default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 60),
  -- Monday to Sunday: null (off) or what's worked that day.
  days jsonb not null default '[null,null,null,null,null,null,null]'::jsonb,
  employee_ids jsonb not null default '[]'::jsonb,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (owner_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['holidays', 'work_patterns'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "Owner manages own %s" on public.%I for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))', t, t);
    execute format('create trigger %s_sync after insert or update or delete on public.%I for each statement execute function public.bump_sync_version()', t, t);
  end loop;
end $$;

-- 2. Sync functions at schema 14: the new tables go with everything else ----------------------------
create or replace function public.owner_snapshot(uid uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'format', 'meridian-payroll-backup', 'schema_version', 14, 'created_at', now(),
    'data', jsonb_build_object(
      'employee_field_defs', coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.employee_field_defs x where x.owner_id = uid), '[]'::jsonb),
      'shifts',              coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.sort_order, x.created_at, x.id) from public.shifts x where x.owner_id = uid), '[]'::jsonb),
      'employees',           coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.employees x where x.owner_id = uid), '[]'::jsonb),
      'pay_rates',           coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.pay_rates x where x.owner_id = uid), '[]'::jsonb),
      'time_records',        coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.time_records x where x.owner_id = uid), '[]'::jsonb),
      'pay_adjustments',     coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.pay_adjustments x where x.owner_id = uid), '[]'::jsonb),
      'deductions',          coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.deductions x where x.owner_id = uid), '[]'::jsonb),
      'pay_runs',            coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.pay_runs x where x.owner_id = uid), '[]'::jsonb),
      'pay_run_lines',       coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.pay_run_id, x.employee_name, x.id) from public.pay_run_lines x where x.owner_id = uid), '[]'::jsonb),
      'holidays',            coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.holiday_date, x.id) from public.holidays x where x.owner_id = uid), '[]'::jsonb),
      'work_patterns',       coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.sort_order, x.created_at, x.id) from public.work_patterns x where x.owner_id = uid), '[]'::jsonb),
      'payroll_settings',    coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.id) from public.payroll_settings x where x.owner_id = uid), '[]'::jsonb)))
$$;

create or replace function public.sync_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'version', coalesce(m.version, 0),
    'updated_at', m.updated_at,
    'has_data', public.owner_has_data(auth.uid()),
    'schema_version', 14,
    'pushed_by_device', m.pushed_by_device,
    'pushed_by_name', m.pushed_by_name,
    'pushed_at', m.pushed_at,
    'pushed_version', m.pushed_version)
  from (select auth.uid() as uid) u
  left join public.sync_meta m on m.owner_id = u.uid
  where u.uid is not null
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
  if p_snapshot->>'format' is distinct from 'meridian-payroll-backup' or (p_snapshot->>'schema_version')::int is distinct from 14 then
    raise exception 'SCHEMA_MISMATCH: this database expects backup schema 14';
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

  -- The settings (and so the lock) go first and come back last, so a push never meets its own lock.
  delete from public.payroll_settings where owner_id = uid;
  delete from public.work_patterns where owner_id = uid;
  delete from public.holidays where owner_id = uid;
  delete from public.pay_run_lines where owner_id = uid;
  delete from public.pay_runs where owner_id = uid;
  delete from public.deductions where owner_id = uid;
  delete from public.pay_adjustments where owner_id = uid;
  delete from public.time_records where owner_id = uid;
  delete from public.pay_rates where owner_id = uid;
  delete from public.employees where owner_id = uid;
  delete from public.shifts where owner_id = uid;
  delete from public.employee_field_defs where owner_id = uid;

  foreach t in array array['employee_field_defs', 'shifts', 'employees', 'pay_rates', 'time_records', 'pay_adjustments',
                           'deductions', 'pay_runs', 'pay_run_lines', 'holidays', 'work_patterns', 'payroll_settings'] loop
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

revoke execute on function public.owner_snapshot(uuid) from public, anon, authenticated;
revoke execute on function public.sync_status(), public.push_snapshot(jsonb, bigint) from public, anon;
grant execute on function public.sync_status(), public.push_snapshot(jsonb, bigint) to authenticated;
