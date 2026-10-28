-- Lock paid days: nothing on or before payroll_settings.locked_through can be added, changed or deleted.
-- Backup schema becomes 10 (the app upgrades older backups when restoring).
-- Runs as one transaction: if any statement fails, nothing changes.

-- 1. The lock date -------------------------------------------------------------
alter table public.payroll_settings add column locked_through date;

-- 2. Refuse writes touching a locked day ---------------------------------------
create or replace function public.refuse_locked() returns trigger language plpgsql set search_path = public as $$
declare
  lim date := (select locked_through from public.payroll_settings where owner_id = coalesce(new.owner_id, old.owner_id));
begin
  if lim is null or coalesce(current_setting('meridian.bypass_lock', true), '') = 'on' then return null; end if;
  if (tg_op <> 'INSERT' and (to_jsonb(old)->>tg_argv[0])::date <= lim) or (tg_op <> 'DELETE' and (to_jsonb(new)->>tg_argv[0])::date <= lim) then
    raise exception 'Days up to % are locked as paid. Unlock them on the Payroll page to change them.', to_char(lim, 'Dy YYYY-MM-DD');
  end if;
  return null;
end $$;
create trigger time_records_lock after insert or update or delete on public.time_records for each row execute function public.refuse_locked('work_date');
create trigger pay_adjustments_lock after insert or update or delete on public.pay_adjustments for each row execute function public.refuse_locked('pay_date');

create or replace function public.refuse_locked_rate() returns trigger language plpgsql set search_path = public as $$
declare
  lim date := (select locked_through from public.payroll_settings where owner_id = coalesce(new.owner_id, old.owner_id));
begin
  if lim is null or coalesce(current_setting('meridian.bypass_lock', true), '') = 'on' then return null; end if;
  if tg_op = 'INSERT' and new.effective_from = date '0001-01-01'
     and new.hourly_rate = (select hourly_rate from public.employees where owner_id = new.owner_id and id = new.employee_id)
     and not exists (select 1 from public.pay_rates where owner_id = new.owner_id and employee_id = new.employee_id and id <> new.id) then return null; end if;
  if (tg_op <> 'INSERT' and old.effective_from <= lim) or (tg_op <> 'DELETE' and new.effective_from <= lim) then
    raise exception 'Days up to % are locked as paid, so their pay rate can''t change. Unlock them on the Payroll page first.', to_char(lim, 'Dy YYYY-MM-DD');
  end if;
  return null;
end $$;
create trigger pay_rates_lock after insert or update or delete on public.pay_rates for each row execute function public.refuse_locked_rate();

create or replace function public.record_rate_change() returns trigger language plpgsql set search_path = public as $$
declare
  was text := coalesce(current_setting('meridian.bypass_lock', true), '');
begin
  if new.hourly_rate is not distinct from old.hourly_rate then return null; end if;
  perform set_config('meridian.bypass_lock', 'on', true);
  insert into public.pay_rates (owner_id, employee_id, effective_from, hourly_rate)
    select old.owner_id, old.id, date '0001-01-01', old.hourly_rate
    where not exists (select 1 from public.pay_rates where owner_id = old.owner_id and employee_id = old.id);
  perform set_config('meridian.bypass_lock', was, true);
  if (select hourly_rate from public.pay_rates where owner_id = new.owner_id and employee_id = new.id order by effective_from desc limit 1) is distinct from new.hourly_rate then
    insert into public.pay_rates (owner_id, employee_id, effective_from, hourly_rate) values (new.owner_id, new.id, current_date, new.hourly_rate)
      on conflict (owner_id, employee_id, effective_from) do update set hourly_rate = excluded.hourly_rate;
  end if;
  return null;
end $$;

-- 3. Sync functions at schema 10. A push deletes the settings (and so the lock) first and inserts them last, so it
--    never meets its own lock. ----------------------------------------------
create or replace function public.owner_snapshot(uid uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'format', 'meridian-payroll-backup', 'schema_version', 10, 'created_at', now(),
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
    'schema_version', 10,
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
  if p_snapshot->>'format' is distinct from 'meridian-payroll-backup' or (p_snapshot->>'schema_version')::int is distinct from 10 then
    raise exception 'SCHEMA_MISMATCH: this database expects backup schema 10';
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

  delete from public.payroll_settings where owner_id = uid;
  delete from public.pay_adjustments where owner_id = uid;
  delete from public.time_records where owner_id = uid;
  delete from public.pay_rates where owner_id = uid;
  delete from public.employees where owner_id = uid;
  delete from public.shifts where owner_id = uid;
  delete from public.employee_field_defs where owner_id = uid;

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
