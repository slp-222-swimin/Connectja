-- Secure room password support.
-- Store only a hash, expose only whether a password exists.
create extension if not exists pgcrypto schema extensions;

alter table public.rooms
add column if not exists room_password_hash text;

alter table public.rooms
add column if not exists has_password boolean generated always as (room_password_hash is not null) stored;

create or replace function public.set_room_password(target_room_id text, new_password text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.rooms
  set room_password_hash = extensions.crypt(new_password, extensions.gen_salt('bf'))
  where id = target_room_id;
end;
$$;

create or replace function public.clear_room_password(target_room_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.rooms
  set room_password_hash = null
  where id = target_room_id;
end;
$$;

create or replace function public.verify_room_password(target_room_id text, candidate_password text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select extensions.crypt(candidate_password, room_password_hash) = room_password_hash
      from public.rooms
      where id = target_room_id
    ),
    false
  );
$$;
