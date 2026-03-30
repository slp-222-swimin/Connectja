-- Harden room access and timestamp integrity.
-- Applies password-gated RLS for chart data and forces server-side last_modified_at.

create extension if not exists pgcrypto schema extensions;

-- Read password from request header sent by the client.
create or replace function public.request_room_password()
returns text
language sql
stable
as $$
  select coalesce((coalesce(current_setting('request.headers', true), '{}')::json ->> 'x-room-password'), '');
$$;

create or replace function public.room_password_ok(target_room_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select
        case
          when room_password_hash is null then true
          else extensions.crypt(public.request_room_password(), room_password_hash) = room_password_hash
        end
      from public.rooms
      where id = target_room_id
    ),
    false
  );
$$;

-- Ensure modification timestamp columns exist and are server-controlled.
alter table public.notes
  add column if not exists last_modified_at bigint,
  add column if not exists last_modified_by text;

alter table public.commands
  add column if not exists last_modified_at bigint,
  add column if not exists last_modified_by text;

create or replace function public.set_server_last_modified_at()
returns trigger
language plpgsql
as $$
begin
  new.last_modified_at := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  return new;
end;
$$;

drop trigger if exists notes_set_last_modified_at on public.notes;
create trigger notes_set_last_modified_at
before insert or update on public.notes
for each row execute function public.set_server_last_modified_at();

drop trigger if exists commands_set_last_modified_at on public.commands;
create trigger commands_set_last_modified_at
before insert or update on public.commands
for each row execute function public.set_server_last_modified_at();

-- Replace permissive chart policies with password-aware ones.
alter table public.notes enable row level security;
alter table public.commands enable row level security;
alter table public.rooms enable row level security;

drop policy if exists "Public Notes Select" on public.notes;
drop policy if exists "Public Notes Insert" on public.notes;
drop policy if exists "Public Notes Update" on public.notes;
drop policy if exists "Public Notes Delete" on public.notes;
drop policy if exists "Room Notes Select" on public.notes;
drop policy if exists "Room Notes Insert" on public.notes;
drop policy if exists "Room Notes Update" on public.notes;
drop policy if exists "Room Notes Delete" on public.notes;

create policy "Room Notes Select"
  on public.notes for select
  using (public.room_password_ok(room_id));

create policy "Room Notes Insert"
  on public.notes for insert
  with check (public.room_password_ok(room_id));

create policy "Room Notes Update"
  on public.notes for update
  using (public.room_password_ok(room_id))
  with check (public.room_password_ok(room_id));

create policy "Room Notes Delete"
  on public.notes for delete
  using (public.room_password_ok(room_id));

drop policy if exists "Public Commands Select" on public.commands;
drop policy if exists "Public Commands Insert" on public.commands;
drop policy if exists "Public Commands Update" on public.commands;
drop policy if exists "Public Commands Delete" on public.commands;
drop policy if exists "Room Commands Select" on public.commands;
drop policy if exists "Room Commands Insert" on public.commands;
drop policy if exists "Room Commands Update" on public.commands;
drop policy if exists "Room Commands Delete" on public.commands;

create policy "Room Commands Select"
  on public.commands for select
  using (public.room_password_ok(room_id));

create policy "Room Commands Insert"
  on public.commands for insert
  with check (public.room_password_ok(room_id));

create policy "Room Commands Update"
  on public.commands for update
  using (public.room_password_ok(room_id))
  with check (public.room_password_ok(room_id));

create policy "Room Commands Delete"
  on public.commands for delete
  using (public.room_password_ok(room_id));

drop policy if exists "Public Rooms Update" on public.rooms;
drop policy if exists "Public Rooms Insert" on public.rooms;
drop policy if exists "Public Rooms Select" on public.rooms;
drop policy if exists "Rooms Select" on public.rooms;
drop policy if exists "Rooms Insert" on public.rooms;
drop policy if exists "Rooms Update" on public.rooms;

create policy "Rooms Select"
  on public.rooms for select
  using (true);

create policy "Rooms Insert"
  on public.rooms for insert
  with check (true);

create policy "Rooms Update"
  on public.rooms for update
  using (public.room_password_ok(id))
  with check (public.room_password_ok(id));
