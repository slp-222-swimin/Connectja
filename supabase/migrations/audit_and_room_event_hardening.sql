-- Audit trail and stronger room event handling.

create extension if not exists pgcrypto schema extensions;

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  action text not null,
  room_id text,
  row_id text,
  actor_user_id text,
  actor_user_name text,
  actor_user_color text,
  old_row jsonb,
  new_row jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_room_id_created_at_idx
  on public.audit_log (room_id, created_at desc);

alter table public.audit_log enable row level security;

drop policy if exists "Audit log read denied" on public.audit_log;
create policy "Audit log read denied"
  on public.audit_log for select
  using (false);

drop policy if exists "Audit log write denied" on public.audit_log;
create policy "Audit log write denied"
  on public.audit_log for insert
  with check (false);

create or replace function public.current_request_header(header_name text)
returns text
language sql
stable
as $$
  select coalesce((coalesce(current_setting('request.headers', true), '{}')::json ->> lower(header_name)), '');
$$;

create or replace function public.sanitize_audit_text(value text, max_len int default 80)
returns text
language sql
immutable
as $$
  select nullif(
    left(
      regexp_replace(coalesce(value, ''), '[\u0000-\u001f\u007f<>"''`]', '', 'g'),
      max_len
    ),
    ''
  );
$$;

create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id text;
  v_row_id text;
begin
  v_room_id :=
    coalesce(
      nullif(coalesce(current_setting('request.headers', true), '{}')::json ->> 'x-room-id', ''),
      coalesce((to_jsonb(new) ->> 'room_id'), (to_jsonb(old) ->> 'room_id'))
    );

  v_row_id :=
    coalesce(
      coalesce((to_jsonb(new) ->> 'id'), (to_jsonb(old) ->> 'id')),
      null
    );

  insert into public.audit_log (
    table_name,
    action,
    room_id,
    row_id,
    actor_user_id,
    actor_user_name,
    actor_user_color,
    old_row,
    new_row
  ) values (
    tg_table_name,
    tg_op,
    v_room_id,
    v_row_id,
    public.sanitize_audit_text(public.current_request_header('x-user-id'), 80),
    public.sanitize_audit_text(public.current_request_header('x-user-name'), 80),
    public.sanitize_audit_text(public.current_request_header('x-user-color'), 40),
    case when tg_op = 'DELETE' then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists audit_notes on public.notes;
create trigger audit_notes
after insert or update or delete on public.notes
for each row execute function public.write_audit_log();

drop trigger if exists audit_commands on public.commands;
create trigger audit_commands
after insert or update or delete on public.commands
for each row execute function public.write_audit_log();

drop trigger if exists audit_rooms on public.rooms;
create trigger audit_rooms
after insert or update or delete on public.rooms
for each row execute function public.write_audit_log();

drop trigger if exists audit_room_events on public.room_events;
create trigger audit_room_events
after insert or update or delete on public.room_events
for each row execute function public.write_audit_log();

alter table public.room_events enable row level security;
drop policy if exists "Public RoomEvents Insert" on public.room_events;
drop policy if exists "Public RoomEvents Delete" on public.room_events;
drop policy if exists "Public RoomEvents Select" on public.room_events;
create policy "Room Events Select"
  on public.room_events for select
  using (true);

create or replace function public.log_room_event(
  target_room_id text,
  event_kind text,
  target_user_id text,
  target_user_name text,
  target_user_color text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_name text := public.sanitize_audit_text(target_user_name, 80);
  safe_color text := public.sanitize_audit_text(target_user_color, 40);
begin
  if event_kind not in ('join', 'leave') then
    raise exception 'invalid event kind';
  end if;

  if not public.room_password_ok(target_room_id) then
    raise exception 'room access denied';
  end if;

  insert into public.room_events (
    room_id,
    event_type,
    user_id,
    user_name,
    user_color
  ) values (
    target_room_id,
    event_kind,
    public.sanitize_audit_text(target_user_id, 80),
    coalesce(safe_name, 'Unknown'),
    safe_color
  );
end;
$$;
