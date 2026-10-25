-- Shifts with pay multipliers, manual pay for a day, and weekend overtime.
-- Backup schema becomes 2 (the app upgrades older backups when restoring).
-- Runs as one transaction: if any statement fails, nothing changes.

-- 1. Shifts, owned per account like every other table ------------------------
create table public.shifts (
  owner_id uuid not null default auth.uid(),
  id uuid not null default gen_random_uuid(),
  name text not null,
  multiplier numeric(6,3) not null default 1 check (multiplier > 0 and multiplier <= 10),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (owner_id, id)
);
grant select, insert, update, delete on public.shifts to authenticated;
grant all on public.shifts to service_role;
alter table public.shifts enable row level security;
create policy "Owner manages own shifts" on public.shifts for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create trigger shifts_sync after insert or update or delete on public.shifts for each statement execute function public.bump_sync_version();

-- Every account that already has data gets Day and Night (×1, so pay is unchanged).
insert into public.shifts (owner_id, name, multiplier, sort_order)
select o.owner_id, v.name, 1, v.sort_order
from (select owner_id from public.employees union select owner_id from public.sync_meta) o
cross join (values ('Day', 0), ('Night', 1)) as v(name, sort_order);

-- 2. New columns -------------------------------------------------------------
-- Deleting a shift moves its employees back to the default (first) shift.
alter table public.employees add column shift_id uuid;
alter table public.employees add constraint employees_shift_fkey
  foreign key (owner_id, shift_id) references public.shifts (owner_id, id) on delete set null (shift_id);
update public.employees e set shift_id = s.id from public.shifts s where s.owner_id = e.owner_id and s.name = 'Day';

alter table public.time_records add column pay_override numeric(10,2) check (pay_override >= 0);
alter table public.payroll_settings add column weekend_overtime boolean not null default true;

-- 3. Sync functions at schema 2 ----------------------------------------------
create or replace function public.owner_snapshot(uid uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'format', 'meridian-payroll-backup', 'schema_version', 2, 'created_at', now(),
    'data', jsonb_build_object(
      'employee_field_defs', coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.employee_field_defs x where x.owner_id = uid), '[]'::jsonb),
      'shifts',              coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.sort_order, x.created_at, x.id) from public.shifts x where x.owner_id = uid), '[]'::jsonb),
      'employees',           coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.employees x where x.owner_id = uid), '[]'::jsonb),
      'time_records',        coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.time_records x where x.owner_id = uid), '[]'::jsonb),
      'pay_adjustments',     coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.created_at, x.id) from public.pay_adjustments x where x.owner_id = uid), '[]'::jsonb),
      'payroll_settings',    coalesce((select jsonb_agg(to_jsonb(x) - 'owner_id' order by x.id) from public.payroll_settings x where x.owner_id = uid), '[]'::jsonb)))
$$;

create or replace function public.sync_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'version', coalesce((select version from public.sync_meta where owner_id = auth.uid()), 0),
    'updated_at', (select updated_at from public.sync_meta where owner_id = auth.uid()),
    'has_data', public.owner_has_data(auth.uid()),
    'schema_version', 2)
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
  if p_snapshot->>'format' is distinct from 'meridian-payroll-backup' or (p_snapshot->>'schema_version')::int is distinct from 2 then
    raise exception 'SCHEMA_MISMATCH: this database expects backup schema 2';
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
  delete from public.shifts where owner_id = uid;
  delete from public.employee_field_defs where owner_id = uid;
  delete from public.payroll_settings where owner_id = uid;

  foreach t in array array['employee_field_defs', 'shifts', 'employees', 'time_records', 'pay_adjustments', 'payroll_settings'] loop
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
