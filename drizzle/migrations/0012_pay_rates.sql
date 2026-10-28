-- Pay rate history: "from this day, this rate", so a raise doesn't change what past days paid.
-- Backup schema becomes 9 (the app upgrades older backups when restoring).
-- Runs as one transaction: if any statement fails, nothing changes.

-- 1. The table ---------------------------------------------------------------
create table public.pay_rates (
  owner_id uuid not null default auth.uid(),
  id uuid not null default gen_random_uuid(),
  employee_id uuid not null,
  effective_from date not null,
  hourly_rate numeric(10,2) not null check (hourly_rate >= 0),
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  unique (owner_id, employee_id, effective_from),
  foreign key (owner_id, employee_id) references public.employees (owner_id, id) on delete cascade
);
grant select, insert, update, delete on public.pay_rates to authenticated;
grant all on public.pay_rates to service_role;
alter table public.pay_rates enable row level security;
create policy "Owner manages own pay rates" on public.pay_rates for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create trigger pay_rates_sync after insert or update or delete on public.pay_rates for each statement execute function public.bump_sync_version();

-- 2. Keep the old rate whenever a rate changes ---------------------------------
-- The first change keeps the old rate for every earlier day; a change the app didn't already date starts today.
create or replace function public.record_rate_change() returns trigger language plpgsql set search_path = public as $$
begin
  if new.hourly_rate is not distinct from old.hourly_rate then return null; end if;
  insert into public.pay_rates (owner_id, employee_id, effective_from, hourly_rate)
    select old.owner_id, old.id, date '0001-01-01', old.hourly_rate
    where not exists (select 1 from public.pay_rates where owner_id = old.owner_id and employee_id = old.id);
  if (select hourly_rate from public.pay_rates where owner_id = new.owner_id and employee_id = new.id order by effective_from desc limit 1) is distinct from new.hourly_rate then
    insert into public.pay_rates (owner_id, employee_id, effective_from, hourly_rate) values (new.owner_id, new.id, current_date, new.hourly_rate)
      on conflict (owner_id, employee_id, effective_from) do update set hourly_rate = excluded.hourly_rate;
  end if;
  return null;
end $$;
create trigger employees_rate_history after update of hourly_rate on public.employees for each row execute function public.record_rate_change();

-- 3. Sync functions at schema 9: pay_rates goes with everything else ----------------------------------------------
create or replace function public.owner_snapshot(uid uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'format', 'meridian-payroll-backup', 'schema_version', 9, 'created_at', now(),
    'data', jsonb_build_object(
      'employee_field_defs', coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.employee_field_defs x where x.owner_id = uid), '[]'::jsonb),
      'shifts',              coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.sort_order, x.created_at, x.id) from public.shifts x where x.owner_id = uid), '[]'::jsonb),
      'employees',           coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.employees x where x.owner_id = uid), '[]'::jsonb),
      'pay_rates',           coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.pay_rates x where x.owner_id = uid), '[]'::jsonb),
      'time_records',        coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.time_records x where x.owner_id = uid), '[]'::jsonb),
      'pay_adjustments',     coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.pay_adjustments x where x.owner_id = uid), '[]'::jsonb),
      'payroll_settings',    coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.id) from public.payroll_settings x where x.owner_id = uid), '[]'::jsonb)))
$$;

create or replace function public.sync_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'version', coalesce(m.version, 0),
    'updated_at', m.updated_at,
    'has_data', public.owner_has_data(auth.uid()),
    'schema_version', 9,
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
  if p_snapshot->>'format' is distinct from 'meridian-payroll-backup' or (p_snapshot->>'schema_version')::int is distinct from 9 then
    raise exception 'SCHEMA_MISMATCH: this database expects backup schema 9';
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
  delete from public.pay_rates where owner_id = uid;
  delete from public.employees where owner_id = uid;
  delete from public.shifts where owner_id = uid;
  delete from public.employee_field_defs where owner_id = uid;
  delete from public.payroll_settings where owner_id = uid;

  foreach t in array array['employee_field_defs', 'shifts', 'employees', 'pay_rates', 'time_records', 'pay_adjustments', 'payroll_settings'] loop
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
