-- kalika-track: the backup reminder is gone (data lives in Supabase now),
-- so its bookkeeping columns are no longer read or written by the app.

alter table public.kalika_track_settings
  drop column if exists last_export_at,
  drop column if exists backup_reminder_snoozed_until;
