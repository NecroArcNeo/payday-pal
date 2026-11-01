-- Email reset of the desktop app's password (opt-in). For each computer that turns it on, the account keeps an
-- "escrow key": with it, the computer's own keyring.json unlocks that computer's payroll data. Neither half works
-- alone: the cloud never sees the data key or the data, and a stolen laptop's keyring needs this account too.
-- Not a payroll table: nothing is synced, and the payroll schema version doesn't change.
--
-- The desktop app gets the key after the user signs in with a one-time code sent by email. Supabase's
-- "Magic Link" email template must include the code ({{ .Token }}): a link can't open the desktop app.
-- Runs as one transaction: if any statement fails, nothing changes.

create table public.key_escrow (
  owner_id uuid not null default auth.uid(),
  keyring_id uuid not null,
  escrow_key text not null,
  device_name text,
  created_at timestamptz not null default now(),
  primary key (owner_id, keyring_id)
);

-- Owner-only, and only through the functions below (no policies: the table itself can't be read or written).
alter table public.key_escrow enable row level security;
revoke all on public.key_escrow from public, anon, authenticated;

create or replace function public.set_key_escrow(p_keyring_id uuid, p_escrow_key text, p_device_name text)
returns void language sql security definer set search_path = public as $$
  insert into public.key_escrow (owner_id, keyring_id, escrow_key, device_name)
  select auth.uid(), p_keyring_id, p_escrow_key, left(p_device_name, 100)
  where auth.uid() is not null
  on conflict (owner_id, keyring_id) do update
    set escrow_key = excluded.escrow_key, device_name = excluded.device_name, created_at = now()
$$;

create or replace function public.get_key_escrow(p_keyring_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select escrow_key from public.key_escrow where owner_id = auth.uid() and keyring_id = p_keyring_id
$$;

create or replace function public.delete_key_escrow(p_keyring_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.key_escrow where owner_id = auth.uid() and keyring_id = p_keyring_id
$$;

revoke execute on function public.set_key_escrow(uuid, text, text) from public, anon;
revoke execute on function public.get_key_escrow(uuid) from public, anon;
revoke execute on function public.delete_key_escrow(uuid) from public, anon;
grant execute on function public.set_key_escrow(uuid, text, text) to authenticated;
grant execute on function public.get_key_escrow(uuid) to authenticated;
grant execute on function public.delete_key_escrow(uuid) to authenticated;
