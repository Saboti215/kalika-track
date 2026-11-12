-- kalika-track: make the CSV import idempotent for the offline outbox.
-- The client now sends its own UUIDs; rows that already exist are skipped,
-- so a retried import (e.g. after a lost response) never creates duplicates.

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
  insert into public.kalika_track_sessions (id, start_at, end_at, break_minutes, note)
  select coalesce((s ->> 'id')::uuid, gen_random_uuid()),
         (s ->> 'start_at')::timestamptz,
         (s ->> 'end_at')::timestamptz,
         coalesce((s ->> 'break_minutes')::integer, 0),
         coalesce(s ->> 'note', '')
  from jsonb_array_elements(coalesce(p_sessions, '[]'::jsonb)) as s
  on conflict (id) do nothing;

  insert into public.kalika_track_compensations (id, day, minutes, note)
  select coalesce((c ->> 'id')::uuid, gen_random_uuid()),
         (c ->> 'day')::date,
         (c ->> 'minutes')::integer,
         coalesce(c ->> 'note', '')
  from jsonb_array_elements(coalesce(p_compensations, '[]'::jsonb)) as c
  on conflict (id) do nothing;

  insert into public.kalika_track_days (day, target_minutes)
  select (d ->> 'day')::date, (d ->> 'target_minutes')::integer
  from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) as d
  on conflict (user_id, day) do update set target_minutes = excluded.target_minutes;
$$;

revoke execute on function public.kalika_track_import(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.kalika_track_import(jsonb, jsonb, jsonb) to authenticated;
