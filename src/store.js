/* ==========================================================================
   kalika-track - offline-first store
   Every change is applied to the local state right away and queued as an
   operation in an outbox (persisted in localStorage). sync() uploads the
   outbox in order, then fetches the server state and replays whatever is
   still queued on top of it. So the app works offline and catches up on
   the next connection.

   Writes are idempotent (client-generated UUIDs, upserts, deletes by id),
   so retrying an operation whose response got lost never duplicates data.
   ========================================================================== */

import * as db from './db.js';
import { supabase } from './supabase.js';

const CACHE_PREFIX = 'kalika-track:cache:';
const OUTBOX_PREFIX = 'kalika-track:outbox:';
const RETRY_DELAYS_MS = [5000, 15000, 30000, 60000];

export function createEmptyState() {
  return {
    sessions: [], // { id, start: ISO string, end: ISO string|null, breakMinutes, note }
    days: {}, // dateKey -> { targetMinutes }
    compensations: [], // { id, date: dateKey, minutes, note }
    settings: { ...db.DEFAULT_SETTINGS },
  };
}

/** The local view (server state + queued changes). Read-only for importers. */
export let state = createEmptyState();

let userId = null;
let outbox = [];
let offline = false;
let syncing = false;
let syncChain = Promise.resolve();
let syncQueued = false;
let retryTimer = null;
let retryAttempt = 0;

const listeners = { change: () => {}, error: () => {} };

/**
 * onChange(dataChanged): the sync status changed, and with dataChanged=true also the state.
 * onError(message): a change was rejected by the server and dropped.
 */
export function subscribe({ onChange, onError }) {
  if (onChange) listeners.change = onChange;
  if (onError) listeners.error = onError;
}

export function getStatus() {
  return { pending: outbox.length, offline, syncing };
}

/* --------------------------------------------------------------------------
   Local persistence
   -------------------------------------------------------------------------- */

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error('kalika-track: could not write local cache.', error);
  }
}

function persist() {
  if (!userId) return;
  writeJson(CACHE_PREFIX + userId, state);
  writeJson(OUTBOX_PREFIX + userId, outbox);
}

/** Switches to a user and loads their cached state. Returns whether a cache existed. */
export function setUser(id) {
  userId = id;
  outbox = id ? readJson(OUTBOX_PREFIX + id) ?? [] : [];
  const cached = id ? readJson(CACHE_PREFIX + id) : null;
  state = cached ? { ...createEmptyState(), ...cached } : createEmptyState();
  offline = false;
  retryAttempt = 0;
  clearTimeout(retryTimer);
  return Boolean(cached);
}

/** Removes the user's cached data and unsynced changes from this device (explicit logout). */
export function forgetUser(id) {
  localStorage.removeItem(CACHE_PREFIX + id);
  localStorage.removeItem(OUTBOX_PREFIX + id);
}

/* --------------------------------------------------------------------------
   Operations: applied locally (applyOp) and sent to Supabase (sendOp)
   -------------------------------------------------------------------------- */

function upsertById(list, item) {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) list.push({ ...item });
  else list[index] = { ...item };
}

function replaceById(list, item) {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index !== -1) list[index] = { ...item };
}

function applyOp(target, op) {
  switch (op.type) {
    case 'session.insert':
      upsertById(target.sessions, op.session);
      break;
    case 'session.update':
      replaceById(target.sessions, op.session);
      break;
    case 'session.delete':
      target.sessions = target.sessions.filter((item) => item.id !== op.id);
      break;
    case 'day.set':
      target.days[op.date] = { targetMinutes: op.targetMinutes };
      break;
    case 'compensation.insert':
      upsertById(target.compensations, op.compensation);
      break;
    case 'compensation.update':
      replaceById(target.compensations, op.compensation);
      break;
    case 'compensation.delete':
      target.compensations = target.compensations.filter((item) => item.id !== op.id);
      break;
    case 'settings.set':
      target.settings = { ...op.settings };
      break;
    case 'import':
      op.sessions.forEach((session) => upsertById(target.sessions, session));
      op.compensations.forEach((comp) => upsertById(target.compensations, comp));
      Object.entries(op.days).forEach(([date, targetMinutes]) => {
        target.days[date] = { targetMinutes };
      });
      break;
    default:
      console.warn('kalika-track: unknown operation', op);
  }
  return target;
}

function sendOp(op) {
  switch (op.type) {
    case 'session.insert':
      return db.insertSession(op.session);
    case 'session.update':
      return db.updateSession(op.session);
    case 'session.delete':
      return db.deleteSession(op.id);
    case 'day.set':
      return db.upsertDay(op.date, op.targetMinutes);
    case 'compensation.insert':
      return db.insertCompensation(op.compensation);
    case 'compensation.update':
      return db.updateCompensation(op.compensation);
    case 'compensation.delete':
      return db.deleteCompensation(op.id);
    case 'settings.set':
      return db.saveSettings(userId, op.settings);
    case 'import':
      return db.importEntries(op);
    default:
      return Promise.resolve();
  }
}

/**
 * Applies changes locally, queues them for upload and starts a sync.
 * Several ops passed together (e.g. stop session + set day target) are
 * queued in one go.
 */
export function commit(...ops) {
  ops.forEach((op) => {
    applyOp(state, op);
    outbox.push(op);
  });
  persist();
  listeners.change(true);
  sync();
}

/* --------------------------------------------------------------------------
   Sync
   -------------------------------------------------------------------------- */

/**
 * Postgres rejected the data itself (constraint/permission violation): retrying
 * can never succeed. Everything else (no network, timeouts, 5xx, expired JWT)
 * is treated as temporary and retried later.
 */
function isPermanentError(error) {
  return /^(22|23|42)/.test(String(error?.code ?? ''));
}

export function describeRejection(error) {
  if (error?.code === '23505') return 'Es lief bereits eine Sitzung (evtl. auf einem anderen Gerät). Die Änderung wurde verworfen.';
  if (error?.code === '23514') return 'Ungültige Eingabe (z. B. Ende vor Start). Die Änderung wurde verworfen.';
  return 'Eine Änderung wurde vom Server abgelehnt und verworfen.';
}

class OfflineError extends Error {}

async function requireSession() {
  // Without a valid session requests would run as "anon" and fail with a
  // permission error, which must not be mistaken for a rejected change.
  // Offline, refreshing an expired token is retried for a long time, so give up early.
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ data: { session: null } }), 5000));
  const { data } = await Promise.race([supabase.auth.getSession(), timeout]);
  if (!data.session) throw new OfflineError('no session');
}

async function runSync() {
  if (!userId) return;
  const syncUserId = userId;
  let dataChanged = false;
  syncing = true;
  listeners.change(false);
  try {
    await requireSession();

    while (outbox.length > 0) {
      const op = outbox[0];
      try {
        await sendOp(op);
      } catch (error) {
        if (!isPermanentError(error)) throw error;
        console.error('kalika-track: change rejected by server, dropping it.', op, error);
        listeners.error(describeRejection(error));
      }
      if (userId !== syncUserId) return;
      outbox.shift();
      persist();
    }

    const serverState = await db.fetchState();
    if (userId !== syncUserId) return;
    // Changes made while fetching are still in the outbox, so replay them on top.
    const nextState = outbox.reduce(applyOp, serverState);
    dataChanged = JSON.stringify(nextState) !== JSON.stringify(state);
    state = nextState;
    persist();
    offline = false;
    retryAttempt = 0;
  } catch (error) {
    if (!(error instanceof OfflineError)) console.warn('kalika-track: sync failed, will retry.', error);
    offline = true;
    scheduleRetry();
  } finally {
    syncing = false;
    listeners.change(dataChanged);
  }
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
  retryAttempt += 1;
  retryTimer = setTimeout(sync, delay);
}

/** Uploads queued changes and refreshes from the server. Calls are serialized. */
export function sync() {
  clearTimeout(retryTimer);
  // A run that hasn't started yet will pick up everything, so don't queue another.
  if (syncQueued) return syncChain;
  syncQueued = true;
  syncChain = syncChain.then(() => {
    syncQueued = false;
    return runSync();
  });
  return syncChain;
}

window.addEventListener('online', () => {
  retryAttempt = 0;
  sync();
});
