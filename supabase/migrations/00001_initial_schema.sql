-- kalika-track: initial schema
-- Every row belongs to exactly one user; RLS restricts all access to the owner.
-- Tables are prefixed so the schema can share a Supabase project with kalika-whish.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Work sessions. end_at is NULL while a session is running.
create table public.kalika_track_sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  start_at       timestamptz not null,
  end_at         timestamptz check (end_at is null or end_at >= start_at),
  break_minutes  integer not null default 0 check (break_minutes >= 0),
  note           text not null default '' check (char_length(note) <= 1000),
  created_at     timestamptz not null default now()
);

create index kalika_track_sessions_user_start_idx on public.kalika_track_sessions (user_id, start_at);

-- At most one running session per user, even when starting on two devices at once.
create unique index kalika_track_sessions_one_running_idx
  on public.kalika_track_sessions (user_id) where end_at is null;

-- Per-day target time override (days without a row use the user's default target).
create table public.kalika_track_days (
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day             date not null,
  target_minutes  integer not null check (target_minutes >= 0),
  primary key (user_id, day)
);

-- Time off taken from the overtime balance.
create table public.kalika_track_compensations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day         date not null,
  minutes     integer not null,
  note        text not null default '' check (char_length(note) <= 1000),
  created_at  timestamptz not null default now()
);

create index kalika_track_compensations_user_day_idx on public.kalika_track_compensations (user_id, day);

-- One settings row per user, created on first write.
create table public.kalika_track_settings (
  user_id                        uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  default_target_minutes         integer not null default 480 check (default_target_minutes >= 0),
  default_break_minutes          integer not null default 30 check (default_break_minutes >= 0),
  last_export_at                 timestamptz,
  backup_reminder_snoozed_until  timestamptz
);

-- ---------------------------------------------------------------------------
-- Row Level Security: owner-only access on every table
-- ---------------------------------------------------------------------------

alter table public.kalika_track_sessions      enable row level security;
alter table public.kalika_track_days          enable row level security;
alter table public.kalika_track_compensations enable row level security;
alter table public.kalika_track_settings      enable row level security;

create policy "Owners manage their sessions"
  on public.kalika_track_sessions for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Owners manage their days"
  on public.kalika_track_days for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Owners manage their compensations"
  on public.kalika_track_compensations for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Owners manage their settings"
  on public.kalika_track_settings for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.kalika_track_sessions, public.kalika_track_days,
  public.kalika_track_compensations, public.kalika_track_settings from anon;

-- ---------------------------------------------------------------------------
-- CSV import: inserts everything in one transaction (all rows or none).
-- SECURITY INVOKER, so RLS and the auth.uid() column defaults apply as usual.
-- ---------------------------------------------------------------------------

create or replace function public.kalika_track_import(
  p_sessions jsonb,
  p_compensations jsonb,
  p_days jsonb
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  insert into public.kalika_track_sessions (start_at, end_at, break_minutes, note)
  select (s ->> 'start_at')::timestamptz,
         (s ->> 'end_at')::timestamptz,
         coalesce((s ->> 'break_minutes')::integer, 0),
         coalesce(s ->> 'note', '')
  from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb)) as s;

  insert into public.kalika_track_compensations (day, minutes, note)
  select (c ->> 'day')::date,
         (c ->> 'minutes')::integer,
         coalesce(c ->> 'note', '')
  from jsonb_array_elements(coalesce(p_compensations, '[]'::jsonb)) as c;

  insert into public.kalika_track_days (day, target_minutes)
  select (d ->> 'day')::date, (d ->> 'target_minutes')::integer
  from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) as d
  on conflict (user_id, day) do update set target_minutes = excluded.target_minutes;
$$;

revoke execute on function public.kalika_track_import(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.kalika_track_import(jsonb, jsonb, jsonb) to authenticated;
