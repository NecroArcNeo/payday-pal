-- Remember which computer last pushed, so a push that would overwrite another computer's changes can say
-- whose, and when. Doesn't change any payroll table: the backup schema stays 7.
-- Runs as one transaction: if any statement fails, nothing changes.

-- 1. Who pushed last ---------------------------------------------------------
-- pushed_version is the cloud version that push produced: anything newer was edited directly in the cloud.
alter table public.sync_meta
  add column pushed_by_device text,
  add column pushed_by_name text,
  add column pushed_at timestamptz,
  add column pushed_version bigint;

-- 2. Status reports it -------------------------------------------------------
create or replace function public.sync_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'version', coalesce(m.version, 0),
    'updated_at', m.updated_at,
    'has_data', public.owner_has_data(auth.uid()),
    'schema_version', 7,
    'pushed_by_device', m.pushed_by_device,
    'pushed_by_name', m.pushed_by_name,
    'pushed_at', m.pushed_at,
    'pushed_version', m.pushed_version)
  from (select auth.uid() as uid) u
  left join public.sync_meta m on m.owner_id = u.uid
  where u.uid is not null
$$;

-- 3. Push records the computer, in the same transaction as the push ----------
create or replace function public.push_snapshot(p_snapshot jsonb, p_expected_version bigint, p_device_id text, p_device_name text)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v bigint;
begin
  v := public.push_snapshot(p_snapshot, p_expected_version);
  update public.sync_meta
     set pushed_by_device = left(p_device_id, 64), pushed_by_name = left(p_device_name, 100), pushed_at = now(), pushed_version = v
   where owner_id = auth.uid();
  return v;
end $$;

revoke execute on function public.push_snapshot(jsonb, bigint, text, text) from public, anon;
grant execute on function public.push_snapshot(jsonb, bigint, text, text) to authenticated;
