/* ==========================================================================
   kalika-track - Supabase data layer
   Maps between database rows and the in-memory state shape used by app.js:
     sessions:      { id, start: ISO, end: ISO|null, breakMinutes, note }
     days:          { [dateKey]: { targetMinutes } }
     compensations: { id, date: dateKey, minutes, note }
     settings:      { defaultTargetMinutes, defaultBreakMinutes }
   Every function throws on a database error. Writes are idempotent (ids are
   generated on the client), so the offline outbox can safely retry them.
   ========================================================================== */

import { supabase } from './supabase.js';

const SESSIONS = 'kalika_track_sessions';
const DAYS = 'kalika_track_days';
const COMPENSATIONS = 'kalika_track_compensations';
const SETTINGS = 'kalika_track_settings';

const SESSION_COLUMNS = 'id, start_at, end_at, break_minutes, note';
const COMPENSATION_COLUMNS = 'id, day, minutes, note';

export const DEFAULT_SETTINGS = {
  defaultTargetMinutes: 480,
  defaultBreakMinutes: 30,
};

function unwrap({ data, error, status }) {
  if (error) {
    // status 0 = the request never reached the server (offline).
    error.status = status;
    throw error;
  }
  return data;
}

/** PostgREST caps a response (1000 rows by default), so page through larger tables. */
async function selectAll(table, columns, orderColumn) {
  const PAGE_SIZE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = unwrap(
      await supabase
        .from(table)
        .select(columns)
        .order(orderColumn)
        .range(from, from + PAGE_SIZE - 1)
    );
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function toSession(row) {
  return {
    id: row.id,
    start: new Date(row.start_at).toISOString(),
    end: row.end_at ? new Date(row.end_at).toISOString() : null,
    breakMinutes: row.break_minutes,
    note: row.note,
  };
}

function toCompensation(row) {
  return { id: row.id, date: row.day, minutes: row.minutes, note: row.note };
}

function toSettings(row) {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    defaultTargetMinutes: row.default_target_minutes,
    defaultBreakMinutes: row.default_break_minutes,
  };
}

/** Loads the signed-in user's complete state (RLS limits every query to their own rows). */
export async function fetchState() {
  const [sessionRows, dayRows, compensationRows, settingsRow] = await Promise.all([
    selectAll(SESSIONS, SESSION_COLUMNS, 'start_at'),
    selectAll(DAYS, 'day, target_minutes', 'day'),
    selectAll(COMPENSATIONS, COMPENSATION_COLUMNS, 'day'),
    supabase.from(SETTINGS).select('default_target_minutes, default_break_minutes').maybeSingle().then(unwrap),
  ]);

  const days = {};
  dayRows.forEach((row) => {
    days[row.day] = { targetMinutes: row.target_minutes };
  });

  return {
    sessions: sessionRows.map(toSession),
    days,
    compensations: compensationRows.map(toCompensation),
    settings: toSettings(settingsRow),
  };
}

function sessionRow(session) {
  return {
    id: session.id,
    start_at: session.start,
    end_at: session.end,
    break_minutes: session.breakMinutes,
    note: session.note || '',
  };
}

function compensationRow(compensation) {
  return { id: compensation.id, day: compensation.date, minutes: compensation.minutes, note: compensation.note || '' };
}

// Inserts skip rows that already exist, so a retried insert is a no-op.
const INSERT_ONCE = { onConflict: 'id', ignoreDuplicates: true };

/* ---------- Sessions ---------- */

export async function insertSession(session) {
  unwrap(await supabase.from(SESSIONS).upsert(sessionRow(session), INSERT_ONCE));
}

export async function updateSession(session) {
  const { id, ...changes } = sessionRow(session);
  unwrap(await supabase.from(SESSIONS).update(changes).eq('id', id));
}

export async function deleteSession(id) {
  unwrap(await supabase.from(SESSIONS).delete().eq('id', id));
}

/* ---------- Days ---------- */

export async function upsertDay(dateKey, targetMinutes) {
  unwrap(
    await supabase.from(DAYS).upsert({ day: dateKey, target_minutes: targetMinutes }, { onConflict: 'user_id,day' })
  );
}

/* ---------- Compensations ---------- */

export async function insertCompensation(compensation) {
  unwrap(await supabase.from(COMPENSATIONS).upsert(compensationRow(compensation), INSERT_ONCE));
}

export async function updateCompensation(compensation) {
  const { id, ...changes } = compensationRow(compensation);
  unwrap(await supabase.from(COMPENSATIONS).update(changes).eq('id', id));
}

export async function deleteCompensation(id) {
  unwrap(await supabase.from(COMPENSATIONS).delete().eq('id', id));
}

/* ---------- Settings ---------- */

export async function saveSettings(userId, settings) {
  unwrap(
    await supabase.from(SETTINGS).upsert({
      user_id: userId,
      default_target_minutes: settings.defaultTargetMinutes,
      default_break_minutes: settings.defaultBreakMinutes,
    })
  );
}

/* ---------- CSV import (one transaction via RPC, see migration 00002) ---------- */

export async function importEntries({ sessions, compensations, days }) {
  unwrap(
    await supabase.rpc('kalika_track_import', {
      p_sessions: sessions.map(sessionRow),
      p_compensations: compensations.map(compensationRow),
      p_days: Object.entries(days).map(([day, targetMinutes]) => ({ day, target_minutes: targetMinutes })),
    })
  );
}
