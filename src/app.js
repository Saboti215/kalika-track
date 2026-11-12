/* ==========================================================================
   kalika-track - application logic
   Time tracking with flextime/overtime calculation. Data is kept in
   Supabase and mirrored locally (see store.js), so the app also works
   offline and uploads changes on the next connection.
   ========================================================================== */

import './style.css';
import * as store from './store.js';
import { state } from './store.js';
import {
  initAuth,
  onUserChange,
  rememberUser,
  signupEnabled,
  signInWithPassword,
  signUp,
  signInWithGoogle,
  signOut,
  translateAuthError,
} from './auth.js';

// undefined = not resolved yet; null = signed out. Distinct so the first null still shows the login.
let currentUserId = undefined;

/* --------------------------------------------------------------------------
   Formatting helpers (time, dates)
   -------------------------------------------------------------------------- */

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Parses "8:00", "8", or "7,5" into a whole number of minutes. */
function parseHM(input) {
  if (input == null) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  if (trimmed.includes(':')) {
    const [hoursPart, minutesPart] = trimmed.split(':');
    const hours = parseInt(hoursPart, 10);
    const minutes = parseInt(minutesPart, 10);
    if (Number.isNaN(hours)) return null;
    return hours * 60 + (Number.isNaN(minutes) ? 0 : minutes);
  }
  const hoursFloat = parseFloat(trimmed.replace(',', '.'));
  if (Number.isNaN(hoursFloat)) return null;
  return Math.round(hoursFloat * 60);
}

/** Fills a linked hours/minutes number-input pair from a minute total (or clears both if null). */
function setHmInputs(hoursId, minutesId, totalMinutes) {
  const hoursEl = document.getElementById(hoursId);
  const minutesEl = document.getElementById(minutesId);
  if (totalMinutes == null) {
    hoursEl.value = '';
    minutesEl.value = '';
    return;
  }
  const minutes = Math.round(totalMinutes);
  hoursEl.value = Math.floor(minutes / 60);
  minutesEl.value = minutes % 60;
}

/** Reads a linked hours/minutes number-input pair back into a minute total, or null if both are empty. */
function readHmInputs(hoursId, minutesId) {
  const hoursValue = document.getElementById(hoursId).value;
  const minutesValue = document.getElementById(minutesId).value;
  if (hoursValue.trim() === '' && minutesValue.trim() === '') return null;
  const hours = parseInt(hoursValue, 10) || 0;
  const minutes = parseInt(minutesValue, 10) || 0;
  return hours * 60 + minutes;
}

/** Formats minutes as "H:MM" (no sign), e.g. 480 -> "8:00". */
function formatHM(totalMinutes) {
  const minutes = Math.round(totalMinutes);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}:${pad2(remainder)}`;
}

/** Formats a live-running duration in seconds as "H:MM:SS", e.g. "1:23:45". */
function formatElapsedClock(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainderSeconds = seconds % 60;
  return `${hours}:${pad2(minutes)}:${pad2(remainderSeconds)}`;
}

/** Formats a signed balance in minutes as "+HH:MMh" / "-HH:MMh". */
function formatBalance(totalMinutes) {
  const sign = totalMinutes < 0 ? '-' : '+';
  const absMinutes = Math.round(Math.abs(totalMinutes));
  const hours = Math.floor(absMinutes / 60);
  const remainder = absMinutes % 60;
  return `${sign}${pad2(hours)}:${pad2(remainder)}h`;
}

/** Formats an unsigned duration in minutes as "H:MMh", e.g. "3:45h". */
function formatDurationHours(totalMinutes) {
  const absMinutes = Math.round(Math.abs(totalMinutes));
  const hours = Math.floor(absMinutes / 60);
  const remainder = absMinutes % 60;
  return `${hours}:${pad2(remainder)}h`;
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

/** Converts a Date to a local "YYYY-MM-DD" key (never UTC, to avoid day-shift bugs). */
function toDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function todayKey() {
  return toDateKey(new Date());
}

function formatDateHeading(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat('de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

function formatMonthHeading(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  const date = new Date(year, month - 1, 1);
  return new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(date);
}

/** Converts an ISO timestamp to a local "HH:MM" value for <input type="time">. */
function toTimeInputValue(isoString) {
  const date = new Date(isoString);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Combines a "YYYY-MM-DD" date key with a "HH:MM" time value into a local Date. */
function combineDateAndTime(dateKey, timeValue) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hours, minutes] = timeValue.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function escapeHtml(value) {
  const container = document.createElement('div');
  container.textContent = value;
  return container.innerHTML;
}

/* --------------------------------------------------------------------------
   Core state mutations
   -------------------------------------------------------------------------- */

function getRunningSession() {
  return state.sessions.find((session) => session.end === null) || null;
}

/* Mutations update the local state immediately and queue the change for
   upload (store.commit), so they work the same online and offline. */

function startSession() {
  if (getRunningSession()) return; // guard against a double tap
  store.commit({
    type: 'session.insert',
    session: { id: crypto.randomUUID(), start: new Date().toISOString(), end: null, breakMinutes: 0, note: '' },
  });
}

function stopSession(sessionId, breakMinutes, targetMinutes, note) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  store.commit(
    { type: 'session.update', session: { ...session, end: new Date().toISOString(), breakMinutes, note: note || '' } },
    { type: 'day.set', date: toDateKey(new Date(session.start)), targetMinutes }
  );
}

function updateSession(sessionId, startIso, endIso, breakMinutes, note) {
  store.commit({
    type: 'session.update',
    session: { id: sessionId, start: startIso, end: endIso, breakMinutes, note: note || '' },
  });
}

/** Adds a completed session entered retroactively (Historie -> "Eintrag hinzufügen"). */
function addManualSession(startIso, endIso, breakMinutes, note) {
  store.commit({
    type: 'session.insert',
    session: { id: crypto.randomUUID(), start: startIso, end: endIso, breakMinutes, note: note || '' },
  });
}

function deleteSession(sessionId) {
  store.commit({ type: 'session.delete', id: sessionId });
}

function getDayMeta(dateKey) {
  const override = state.days[dateKey];
  return { targetMinutes: override?.targetMinutes ?? state.settings.defaultTargetMinutes };
}

function setDayMeta(dateKey, targetMinutes) {
  store.commit({ type: 'day.set', date: dateKey, targetMinutes });
}

function addCompensation(dateKey, minutes, note) {
  store.commit({
    type: 'compensation.insert',
    compensation: { id: crypto.randomUUID(), date: dateKey, minutes, note: note || '' },
  });
}

function updateCompensation(compensationId, dateKey, minutes, note) {
  store.commit({
    type: 'compensation.update',
    compensation: { id: compensationId, date: dateKey, minutes, note: note || '' },
  });
}

function deleteCompensation(compensationId) {
  store.commit({ type: 'compensation.delete', id: compensationId });
}

/**
 * Saves new per-user defaults. Days without their own target fall back to
 * the default, so changing it would silently rewrite the balance of past
 * days; those tracked days get the old default pinned in the same commit.
 */
function updateSettings(changes) {
  const nextSettings = { ...state.settings, ...changes };
  const previousTarget = state.settings.defaultTargetMinutes;
  const pinOps =
    nextSettings.defaultTargetMinutes === previousTarget
      ? []
      : getTrackedDateKeys()
          .filter((dateKey) => !state.days[dateKey])
          .map((dateKey) => ({ type: 'day.set', date: dateKey, targetMinutes: previousTarget }));
  store.commit(...pinOps, { type: 'settings.set', settings: nextSettings });
}

/* --------------------------------------------------------------------------
   Overtime / flextime calculations
   -------------------------------------------------------------------------- */

function getCompletedSessionsForDate(dateKey) {
  return state.sessions.filter(
    (session) => session.end !== null && toDateKey(new Date(session.start)) === dateKey
  );
}

/** Sum of all completed work sessions for a day, each minus its own break. */
function dayWorkedMinutes(dateKey) {
  return getCompletedSessionsForDate(dateKey).reduce((sum, session) => {
    const grossMinutes = (new Date(session.end) - new Date(session.start)) / 60000;
    return sum + grossMinutes - (session.breakMinutes || 0);
  }, 0);
}

/** Worked minutes minus that day's target. Only meaningful for tracked days. */
function dayBalanceMinutes(dateKey) {
  return dayWorkedMinutes(dateKey) - getDayMeta(dateKey).targetMinutes;
}

/** Every date that has at least one completed session (untracked days are excluded). */
function getTrackedDateKeys() {
  const keys = new Set();
  state.sessions.forEach((session) => {
    if (session.end !== null) keys.add(toDateKey(new Date(session.start)));
  });
  return Array.from(keys);
}

/**
 * Global overtime balance: sum of each tracked day's balance, minus all
 * compensation (time-off) minutes taken. Days with no tracked sessions are
 * never included, so they never reduce the balance.
 */
function globalBalanceMinutes() {
  const trackedTotal = getTrackedDateKeys().reduce((sum, dateKey) => sum + dayBalanceMinutes(dateKey), 0);
  const compensationTotal = state.compensations.reduce((sum, comp) => sum + comp.minutes, 0);
  return trackedTotal - compensationTotal;
}

/** Same as globalBalanceMinutes(), but scoped to a single "YYYY-MM" month. */
function monthBalanceMinutes(monthKey) {
  const trackedTotal = getTrackedDateKeys()
    .filter((dateKey) => dateKey.startsWith(monthKey))
    .reduce((sum, dateKey) => sum + dayBalanceMinutes(dateKey), 0);
  const compensationTotal = state.compensations
    .filter((comp) => comp.date.startsWith(monthKey))
    .reduce((sum, comp) => sum + comp.minutes, 0);
  return trackedTotal - compensationTotal;
}

/* --------------------------------------------------------------------------
   Day grouping (shared by the "Heute" card and the Historie list)
   -------------------------------------------------------------------------- */

function getSessionsForDate(dateKey) {
  return state.sessions
    .filter((session) => toDateKey(new Date(session.start)) === dateKey)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

function getCompensationsForDate(dateKey) {
  return state.compensations.filter((comp) => comp.date === dateKey);
}

function buildDayGroup(dateKey) {
  return { dateKey, sessions: getSessionsForDate(dateKey), compensations: getCompensationsForDate(dateKey) };
}

/** All dates with any entry (session or compensation), newest first. */
function buildHistoryGroups() {
  const dateKeys = new Set();
  state.sessions.forEach((session) => dateKeys.add(toDateKey(new Date(session.start))));
  state.compensations.forEach((comp) => dateKeys.add(comp.date));
  const groups = Array.from(dateKeys).map(buildDayGroup);
  groups.sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1));
  return groups;
}

/** Day groups bucketed by "YYYY-MM" month, newest month first (order inherited from buildHistoryGroups). */
function buildHistoryMonths() {
  const months = [];
  const byKey = new Map();
  buildHistoryGroups().forEach((dayGroup) => {
    const monthKey = dayGroup.dateKey.slice(0, 7);
    if (!byKey.has(monthKey)) {
      const month = { monthKey, days: [] };
      byKey.set(monthKey, month);
      months.push(month);
    }
    byKey.get(monthKey).days.push(dayGroup);
  });
  return months;
}

/* --------------------------------------------------------------------------
   CSV import / export
   Columns: Typ;Datum;Start;Ende;Pause;Ziel;Ausgleich;Notiz
   Export and import share this exact format, so exporting once (even with
   no data) gives a ready-made template for reshaping data from other tools.
   -------------------------------------------------------------------------- */

const CSV_COLUMNS = ['Typ', 'Datum', 'Start', 'Ende', 'Pause', 'Ziel', 'Ausgleich', 'Notiz'];

function csvEscapeField(value) {
  const str = String(value ?? '');
  if (/[;,"\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildExportCsv() {
  const rows = [CSV_COLUMNS];

  const completedSessions = state.sessions
    .filter((session) => session.end !== null)
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  completedSessions.forEach((session) => {
    const dateKey = toDateKey(new Date(session.start));
    const meta = getDayMeta(dateKey);
    rows.push([
      'Arbeitszeit',
      dateKey,
      toTimeInputValue(session.start),
      toTimeInputValue(session.end),
      formatHM(session.breakMinutes || 0),
      formatHM(meta.targetMinutes),
      '',
      session.note || '',
    ]);
  });

  const sortedCompensations = [...state.compensations].sort((a, b) => (a.date < b.date ? -1 : 1));
  sortedCompensations.forEach((comp) => {
    rows.push(['Ausgleich', comp.date, '', '', '', '', formatHM(comp.minutes), comp.note || '']);
  });

  return rows.map((row) => row.map(csvEscapeField).join(';')).join('\r\n');
}

function downloadTextFile(filename, content, mimeType) {
  // Prefix a UTF-8 BOM so Excel correctly detects encoding (umlauts in notes).
  const blob = new Blob(['﻿' + content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Attempts to hand the CSV off to the OS share sheet (iCloud Drive, AirDrop,
 * Mail, ...) via the Web Share API. Returns:
 * - 'shared'      the user completed a share (or a compatible download)
 * - 'cancelled'   the user dismissed the share sheet; respect that, no fallback
 * - 'unsupported' Web Share (with files) isn't available here; caller should fall back
 */
async function tryShareCsv(filename, csvContent) {
  if (!navigator.canShare || !navigator.share) return 'unsupported';
  try {
    const file = new File(['﻿' + csvContent], filename, { type: 'text/csv' });
    if (!navigator.canShare({ files: [file] })) return 'unsupported';
    await navigator.share({ files: [file], title: 'kalika-track Export' });
    return 'shared';
  } catch (error) {
    if (error?.name === 'AbortError') return 'cancelled';
    console.error('kalika-track: sharing the export failed, falling back to download.', error);
    return 'unsupported';
  }
}


async function exportEntriesAsCsv() {
  const filename = `kalika-track-export-${todayKey()}.csv`;
  const csvContent = buildExportCsv();
  const outcome = await tryShareCsv(filename, csvContent);
  if (outcome === 'cancelled') return; // user actively declined; don't force a download too
  if (outcome === 'unsupported') downloadTextFile(filename, csvContent, 'text/csv;charset=utf-8;');
}

function detectCsvDelimiter(text) {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] || '';
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semicolons >= commas ? ';' : ',';
}

/** Minimal RFC4180-style CSV parser: handles quoted fields, escaped quotes, and embedded delimiters. */
function parseCsvText(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // skip; \n (or end of input) closes the row
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Parses one data row into a session or compensation, given the header->column-index map. */
function parseImportRow(rawRow, headerIndex, rowNumber) {
  const get = (name) => {
    const idx = headerIndex[name];
    return idx == null || idx < 0 || idx >= rawRow.length ? '' : rawRow[idx].trim();
  };

  const typ = get('typ').toLowerCase();
  const dateKey = get('datum');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return { error: `Zeile ${rowNumber}: ungültiges oder fehlendes Datum ("${get('datum')}").` };
  }

  if (typ === 'ausgleich') {
    const minutes = parseHM(get('ausgleich'));
    if (minutes == null) {
      return { error: `Zeile ${rowNumber}: ungültiger Wert in Spalte "Ausgleich" ("${get('ausgleich')}").` };
    }
    return { compensation: { date: dateKey, minutes, note: get('notiz') } };
  }

  if (typ === 'arbeitszeit') {
    const startValue = get('start');
    const endValue = get('ende');
    if (!/^\d{1,2}:\d{2}$/.test(startValue) || !/^\d{1,2}:\d{2}$/.test(endValue)) {
      return { error: `Zeile ${rowNumber}: ungültige Start- oder Endzeit.` };
    }
    const startDate = combineDateAndTime(dateKey, startValue);
    const endDate = combineDateAndTime(dateKey, endValue);
    if (endDate <= startDate) endDate.setDate(endDate.getDate() + 1);
    const breakMinutes = parseHM(get('pause')) ?? 0;
    const targetRaw = get('ziel');
    const targetMinutes = targetRaw ? parseHM(targetRaw) : null;
    return {
      session: { startIso: startDate.toISOString(), endIso: endDate.toISOString(), breakMinutes, note: get('notiz') },
      dateKey,
      targetMinutes,
    };
  }

  return { error: `Zeile ${rowNumber}: unbekannter Typ ("${get('typ')}"), erwartet "Arbeitszeit" oder "Ausgleich".` };
}

/** Parses a full CSV file into importable entries plus any per-row error messages. */
function parseImportCsv(text) {
  const delimiter = detectCsvDelimiter(text);
  const rows = parseCsvText(text, delimiter);
  if (rows.length === 0) {
    return { sessions: [], compensations: [], dayTargets: {}, errors: ['Die Datei ist leer.'] };
  }

  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const headerIndex = {};
  ['typ', 'datum', 'start', 'ende', 'pause', 'ziel', 'ausgleich', 'notiz'].forEach((name) => {
    headerIndex[name] = header.indexOf(name);
  });
  if (headerIndex.typ < 0 || headerIndex.datum < 0) {
    return {
      sessions: [],
      compensations: [],
      dayTargets: {},
      errors: ['Spalten "Typ" und "Datum" wurden nicht gefunden. Bitte das Format der CSV-Vorlage (Export) verwenden.'],
    };
  }

  const sessions = [];
  const compensations = [];
  const dayTargets = {};
  const errors = [];

  rows.slice(1).forEach((row, index) => {
    const parsed = parseImportRow(row, headerIndex, index + 2);
    if (parsed.error) {
      errors.push(parsed.error);
      return;
    }
    if (parsed.compensation) compensations.push(parsed.compensation);
    if (parsed.session) {
      sessions.push(parsed.session);
      if (parsed.targetMinutes != null) dayTargets[parsed.dateKey] = parsed.targetMinutes;
    }
  });

  return { sessions, compensations, dayTargets, errors };
}

/** Queues parsed import results as one operation (one transaction on the server). */
function applyImportedEntries(sessions, compensations, dayTargets) {
  store.commit({
    type: 'import',
    sessions: sessions.map((session) => ({
      id: crypto.randomUUID(),
      start: session.startIso,
      end: session.endIso,
      breakMinutes: session.breakMinutes,
      note: session.note || '',
    })),
    compensations: compensations.map((comp) => ({
      id: crypto.randomUUID(),
      date: comp.date,
      minutes: comp.minutes,
      note: comp.note || '',
    })),
    days: { ...dayTargets },
  });
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */

// Shared inline icons (stroke-based, currentColor) so entry actions match the
// tab bar's style instead of relying on emoji, which render inconsistently
// across platforms/fonts.
const ICON_EDIT =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
const ICON_DELETE =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

const toggleTrackingBtn = document.getElementById('toggle-tracking-btn');
const addCompensationBtn = document.getElementById('add-compensation-btn');
const addManualEntryBtn = document.getElementById('add-manual-entry-btn');
const exportCsvBtn = document.getElementById('export-csv-btn');
const importCsvBtn = document.getElementById('import-csv-btn');
const globalBalanceEl = document.getElementById('global-balance');
const runningIndicatorEl = document.getElementById('running-indicator');
const historyListEl = document.getElementById('history-list');
const historyEmptyEl = document.getElementById('history-empty');
const todayWorkedEl = document.getElementById('today-worked');
const todayTargetEl = document.getElementById('today-target');
const todayBalanceEl = document.getElementById('today-balance');
const todayListEl = document.getElementById('today-list');
const todayEmptyEl = document.getElementById('today-empty');
let runningTimerInterval = null;
let lastGlobalBalanceMinutes = null;
let lastTodayBalanceMinutes = null;
/** Which "YYYY-MM" months are expanded in the Historie view. Empty = all collapsed. */
const expandedMonths = new Set();

/** Restarts a CSS animation on an element by toggling its class via a reflow. */
function playBounce(el) {
  el.classList.remove('number-bounce');
  void el.offsetWidth;
  el.classList.add('number-bounce');
}

/** Tweens an element's text between two minute values using formatFn, ease-out. */
function animateNumberChange(el, fromMinutes, toMinutes, formatFn, durationMs = 600) {
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = fromMinutes + (toMinutes - fromMinutes) * eased;
    el.textContent = formatFn(t < 1 ? current : toMinutes);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function renderAll() {
  renderGlobalBalance();
  renderToggleButton();
  renderRunningIndicator();
  renderToday();
  renderHistory();
}

function renderGlobalBalance() {
  const minutes = globalBalanceMinutes();
  if (lastGlobalBalanceMinutes === null) {
    globalBalanceEl.textContent = formatBalance(minutes);
  } else if (minutes !== lastGlobalBalanceMinutes) {
    animateNumberChange(globalBalanceEl, lastGlobalBalanceMinutes, minutes, formatBalance);
    playBounce(globalBalanceEl);
  }
  globalBalanceEl.classList.toggle('positive', minutes >= 0);
  globalBalanceEl.classList.toggle('negative', minutes < 0);
  lastGlobalBalanceMinutes = minutes;
}

function renderToggleButton() {
  const running = getRunningSession();
  toggleTrackingBtn.textContent = running ? 'Stopp' : 'Start';
  toggleTrackingBtn.classList.toggle('is-running', Boolean(running));
}

function renderRunningIndicator() {
  const running = getRunningSession();
  if (!running) {
    runningIndicatorEl.hidden = true;
    if (runningTimerInterval) {
      clearInterval(runningTimerInterval);
      runningTimerInterval = null;
    }
    return;
  }
  runningIndicatorEl.hidden = false;
  document.getElementById('running-since').textContent = formatTime(running.start);
  updateRunningElapsed(running.start);
  if (!runningTimerInterval) {
    runningTimerInterval = setInterval(() => updateRunningElapsed(running.start), 1000);
  }
}

function updateRunningElapsed(startIso) {
  const elapsedSeconds = (Date.now() - new Date(startIso).getTime()) / 1000;
  document.getElementById('running-elapsed').textContent = formatElapsedClock(elapsedSeconds);
}

/** Dashboard "Heute" card: today's worked/target/balance stats + today's entries. */
function renderToday() {
  const dateKey = todayKey();
  const meta = getDayMeta(dateKey);
  const worked = dayWorkedMinutes(dateKey);
  const balance = dayBalanceMinutes(dateKey);

  todayWorkedEl.textContent = formatDurationHours(worked);
  todayTargetEl.textContent = `${formatHM(meta.targetMinutes)}h`;
  if (lastTodayBalanceMinutes === null) {
    todayBalanceEl.textContent = formatBalance(balance);
  } else if (balance !== lastTodayBalanceMinutes) {
    animateNumberChange(todayBalanceEl, lastTodayBalanceMinutes, balance, formatBalance);
    playBounce(todayBalanceEl);
  }
  todayBalanceEl.classList.toggle('positive', balance >= 0);
  todayBalanceEl.classList.toggle('negative', balance < 0);
  lastTodayBalanceMinutes = balance;

  const group = buildDayGroup(dateKey);
  const hasEntries = group.sessions.length > 0 || group.compensations.length > 0;
  if (!hasEntries) {
    todayListEl.innerHTML = '';
    todayEmptyEl.hidden = false;
    return;
  }
  todayEmptyEl.hidden = true;
  todayListEl.innerHTML = group.sessions.map(renderSessionRow).join('') + group.compensations.map(renderCompensationRow).join('');
  applyStaggerIndex(todayListEl.querySelectorAll('.entry-row'));
}

/** Sets a CSS custom property used by the entry-row/day-group fly-in animation delay. */
function applyStaggerIndex(elements) {
  elements.forEach((el, index) => el.style.setProperty('--i', index));
}

function renderHistory() {
  const months = buildHistoryMonths();
  if (months.length === 0) {
    historyListEl.innerHTML = '';
    historyEmptyEl.hidden = false;
    return;
  }
  historyEmptyEl.hidden = true;
  historyListEl.innerHTML = months.map(renderMonthGroup).join('');
  applyStaggerIndex(historyListEl.querySelectorAll('.month-group'));
}

/** One collapsible month row: header (month name + month balance) plus its day groups. */
function renderMonthGroup(month) {
  const balance = monthBalanceMinutes(month.monthKey);
  const isExpanded = expandedMonths.has(month.monthKey);

  return `
    <div class="month-group ${isExpanded ? 'is-expanded' : ''}" data-month="${month.monthKey}">
      <button type="button" class="month-group-header" data-action="toggle-month" data-month="${month.monthKey}" aria-expanded="${isExpanded}">
        <svg class="month-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
        <span class="month-group-title">${escapeHtml(formatMonthHeading(month.monthKey))}</span>
        <span class="month-group-balance ${balance >= 0 ? 'positive' : 'negative'}">${formatBalance(balance)}</span>
      </button>
      <div class="month-group-body">
        ${month.days.map(renderDayGroup).join('')}
      </div>
    </div>
  `;
}

function renderDayGroup(group) {
  const meta = getDayMeta(group.dateKey);
  const hasCompletedSessions = group.sessions.some((session) => session.end !== null);
  const balanceMinutes = hasCompletedSessions ? dayBalanceMinutes(group.dateKey) : null;
  const balanceHtml =
    balanceMinutes === null
      ? ''
      : `<span class="day-group-balance ${balanceMinutes >= 0 ? 'positive' : 'negative'}">${formatBalance(balanceMinutes)}</span>`;

  return `
    <div class="day-group">
      <div class="day-group-header">
        <div>
          <div class="day-group-date">${escapeHtml(formatDateHeading(group.dateKey))}</div>
          <button type="button" class="day-group-meta" data-action="edit-day" data-date="${group.dateKey}">Ziel ${formatHM(meta.targetMinutes)}h</button>
        </div>
        ${balanceHtml}
      </div>
      ${group.sessions.map(renderSessionRow).join('')}
      ${group.compensations.map(renderCompensationRow).join('')}
    </div>
  `;
}

function renderSessionRow(session) {
  const isRunning = session.end === null;
  const startLabel = formatTime(session.start);
  const endLabel = isRunning ? '…' : formatTime(session.end);
  const durationLabel = isRunning
    ? 'läuft'
    : formatDurationHours((new Date(session.end) - new Date(session.start)) / 60000 - (session.breakMinutes || 0));
  const subLabel = isRunning ? 'Arbeitszeit' : `Arbeitszeit &middot; Pause ${session.breakMinutes || 0}min`;
  const noteHtml = session.note ? `<span class="entry-note">${escapeHtml(session.note)}</span>` : '';

  return `
    <div class="entry-row ${isRunning ? 'is-running' : ''}">
      <div class="entry-info">
        <span class="entry-time">${startLabel}&ndash;${endLabel}</span>
        <span class="entry-sub">${subLabel}</span>
        ${noteHtml}
      </div>
      <span class="entry-duration">${durationLabel}</span>
      <button type="button" class="entry-edit-btn" data-action="edit-session" data-id="${session.id}" aria-label="Sitzung bearbeiten">${ICON_EDIT}</button>
    </div>
  `;
}

function renderCompensationRow(comp) {
  return `
    <div class="entry-row is-compensation">
      <div class="entry-info">
        <span class="entry-time">Ausgleich</span>
        ${comp.note ? `<span class="entry-sub">${escapeHtml(comp.note)}</span>` : ''}
      </div>
      <span class="entry-duration">-${formatDurationHours(comp.minutes)}</span>
      <button type="button" class="entry-edit-btn" data-action="edit-compensation" data-id="${comp.id}" aria-label="Ausgleich bearbeiten">${ICON_EDIT}</button>
    </div>
  `;
}

/* --------------------------------------------------------------------------
   View switching (Dashboard <-> Historie via bottom tab bar)
   -------------------------------------------------------------------------- */

const views = {
  dashboard: document.getElementById('view-dashboard'),
  history: document.getElementById('view-history'),
};
const tabButtons = document.querySelectorAll('.tab-btn');

function switchView(name) {
  Object.entries(views).forEach(([key, el]) => el.classList.toggle('is-active', key === name));
  tabButtons.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.view === name));
  const activeView = views[name];
  activeView.classList.remove('view-enter');
  void activeView.offsetWidth;
  activeView.classList.add('view-enter');
}

/* --------------------------------------------------------------------------
   Dialog helpers
   -------------------------------------------------------------------------- */

const stopDialog = document.getElementById('stop-dialog');
const compensationDialog = document.getElementById('compensation-dialog');
const compensationEditDialog = document.getElementById('compensation-edit-dialog');
const daySettingsDialog = document.getElementById('day-settings-dialog');
const sessionEditDialog = document.getElementById('session-edit-dialog');
const settingsDialog = document.getElementById('settings-dialog');
const manualEntryDialog = document.getElementById('manual-entry-dialog');
const confirmDialog = document.getElementById('confirm-dialog');
const confirmMessageEl = document.getElementById('confirm-message');
const importDialog = document.getElementById('import-dialog');
const importSummaryEl = document.getElementById('import-summary');
const importErrorsEl = document.getElementById('import-errors');
const importConfirmBtn = document.getElementById('import-confirm-btn');
const importCsvInput = document.getElementById('import-csv-input');

let pendingStopSessionId = null;
let pendingCompensationEditId = null;
let pendingDayDateKey = null;
let pendingSessionEditId = null;
let pendingConfirmResolve = null;
let pendingImportResult = null;

/**
 * Custom replacement for the native confirm() dialog, styled and animated
 * like the rest of the app instead of the browser's default modal.
 * Resolves true if the user confirms, false if they cancel/dismiss.
 */
function showConfirmDialog(message, { title = 'Wirklich löschen?', confirmLabel = 'Löschen' } = {}) {
  return new Promise((resolve) => {
    pendingConfirmResolve = resolve;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-submit-btn').textContent = confirmLabel;
    confirmMessageEl.textContent = message;
    confirmDialog.returnValue = '';
    confirmDialog.showModal();
  });
}

function openStopDialog(sessionId) {
  pendingStopSessionId = sessionId;
  const session = state.sessions.find((item) => item.id === sessionId);
  const dateKey = toDateKey(new Date(session.start));
  const meta = getDayMeta(dateKey);
  document.getElementById('stop-break-minutes').value = state.settings.defaultBreakMinutes;
  setHmInputs('stop-target-hours', 'stop-target-minutes', meta.targetMinutes);
  document.getElementById('stop-note').value = '';
  stopDialog.returnValue = '';
  stopDialog.showModal();
}

function openCompensationDialog() {
  document.getElementById('compensation-date').value = todayKey();
  setHmInputs('compensation-hours', 'compensation-minutes', null);
  document.getElementById('compensation-note').value = '';
  compensationDialog.returnValue = '';
  compensationDialog.showModal();
}

function openCompensationEditDialog(compensationId) {
  pendingCompensationEditId = compensationId;
  const compensation = state.compensations.find((item) => item.id === compensationId);
  if (!compensation) return;
  document.getElementById('compensation-edit-date').value = compensation.date;
  setHmInputs('compensation-edit-hours', 'compensation-edit-minutes', compensation.minutes);
  document.getElementById('compensation-edit-note').value = compensation.note || '';
  compensationEditDialog.returnValue = '';
  compensationEditDialog.showModal();
}

function openDaySettingsDialog(dateKey) {
  pendingDayDateKey = dateKey;
  const meta = getDayMeta(dateKey);
  document.getElementById('day-settings-date').textContent = `(${formatDateHeading(dateKey)})`;
  setHmInputs('day-target-hours', 'day-target-minutes', meta.targetMinutes);
  daySettingsDialog.returnValue = '';
  daySettingsDialog.showModal();
}

function openSettingsDialog() {
  setHmInputs('settings-target-hours', 'settings-target-minutes', state.settings.defaultTargetMinutes);
  document.getElementById('settings-break-minutes').value = state.settings.defaultBreakMinutes;
  settingsDialog.returnValue = '';
  settingsDialog.showModal();
}

function openSessionEditDialog(sessionId) {
  pendingSessionEditId = sessionId;
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  document.getElementById('session-edit-start').value = toTimeInputValue(session.start);
  document.getElementById('session-edit-end').value = session.end ? toTimeInputValue(session.end) : '';
  document.getElementById('session-edit-break').value = session.breakMinutes || 0;
  document.getElementById('session-edit-note').value = session.note || '';
  sessionEditDialog.returnValue = '';
  sessionEditDialog.showModal();
}

function openManualEntryDialog() {
  document.getElementById('manual-entry-date').value = todayKey();
  document.getElementById('manual-entry-start').value = '';
  document.getElementById('manual-entry-end').value = '';
  document.getElementById('manual-entry-break').value = state.settings.defaultBreakMinutes;
  document.getElementById('manual-entry-note').value = '';
  manualEntryDialog.returnValue = '';
  manualEntryDialog.showModal();
}

function openImportDialog(result) {
  pendingImportResult = result;
  const total = result.sessions.length + result.compensations.length;
  const parts = [];
  if (result.sessions.length) parts.push(`${result.sessions.length} Arbeitszeit${result.sessions.length === 1 ? '' : 'en'}`);
  if (result.compensations.length) parts.push(`${result.compensations.length} Ausgleich${result.compensations.length === 1 ? '' : 'e'}`);

  importSummaryEl.textContent =
    total > 0
      ? `${total} ${total === 1 ? 'Eintrag' : 'Einträge'} gefunden: ${parts.join(', ')}.`
      : 'Keine gültigen Einträge gefunden.';

  if (result.errors.length > 0) {
    importErrorsEl.hidden = false;
    importErrorsEl.innerHTML = `<p>${result.errors.length} Zeile${result.errors.length === 1 ? '' : 'n'} übersprungen:</p><ul>${result.errors
      .map((error) => `<li>${escapeHtml(error)}</li>`)
      .join('')}</ul>`;
  } else {
    importErrorsEl.hidden = true;
    importErrorsEl.innerHTML = '';
  }

  importConfirmBtn.disabled = total === 0;
  importDialog.returnValue = '';
  importDialog.showModal();
}

/* --------------------------------------------------------------------------
   Event wiring
   -------------------------------------------------------------------------- */

function attachEventListeners() {
  toggleTrackingBtn.addEventListener('click', () => {
    const running = getRunningSession();
    if (running) {
      openStopDialog(running.id);
    } else {
      startSession();
    }
  });

  addCompensationBtn.addEventListener('click', openCompensationDialog);
  addManualEntryBtn.addEventListener('click', openManualEntryDialog);
  todayTargetEl.addEventListener('click', () => openDaySettingsDialog(todayKey()));

  exportCsvBtn.addEventListener('click', exportEntriesAsCsv);
  importCsvBtn.addEventListener('click', () => importCsvInput.click());
  importCsvInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    const text = await file.text();
    openImportDialog(parseImportCsv(text));
  });

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Generic cancel/delete buttons shared across all dialogs.
  document.querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog').close('cancel'));
  });
  document.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog').close('delete'));
  });

  stopDialog.addEventListener('close', () => {
    if (stopDialog.returnValue !== 'confirm' || !pendingStopSessionId) return;
    const breakMinutes = parseInt(document.getElementById('stop-break-minutes').value, 10) || 0;
    const targetMinutes = readHmInputs('stop-target-hours', 'stop-target-minutes') ?? state.settings.defaultTargetMinutes;
    const note = document.getElementById('stop-note').value.trim();
    const sessionId = pendingStopSessionId;
    pendingStopSessionId = null;
    stopSession(sessionId, breakMinutes, targetMinutes, note);
  });

  compensationDialog.addEventListener('close', () => {
    if (compensationDialog.returnValue !== 'confirm') return;
    const dateKey = document.getElementById('compensation-date').value || todayKey();
    const minutes = readHmInputs('compensation-hours', 'compensation-minutes');
    if (!minutes) return;
    const note = document.getElementById('compensation-note').value.trim();
    addCompensation(dateKey, minutes, note);
  });

  compensationEditDialog.addEventListener('close', async () => {
    if (compensationEditDialog.returnValue === 'delete' && pendingCompensationEditId) {
      const compensationIdToDelete = pendingCompensationEditId;
      pendingCompensationEditId = null;
      if (await showConfirmDialog('Ausgleichseintrag löschen?')) {
        deleteCompensation(compensationIdToDelete);
      }
      return;
    }
    if (compensationEditDialog.returnValue !== 'confirm' || !pendingCompensationEditId) return;
    const dateKey = document.getElementById('compensation-edit-date').value;
    const minutes = readHmInputs('compensation-edit-hours', 'compensation-edit-minutes');
    if (!dateKey || !minutes) return;
    const note = document.getElementById('compensation-edit-note').value.trim();
    const compensationId = pendingCompensationEditId;
    pendingCompensationEditId = null;
    updateCompensation(compensationId, dateKey, minutes, note);
  });

  daySettingsDialog.addEventListener('close', () => {
    if (daySettingsDialog.returnValue !== 'confirm' || !pendingDayDateKey) return;
    const targetMinutes = readHmInputs('day-target-hours', 'day-target-minutes') ?? state.settings.defaultTargetMinutes;
    const dateKey = pendingDayDateKey;
    pendingDayDateKey = null;
    setDayMeta(dateKey, targetMinutes);
  });

  document.getElementById('settings-btn').addEventListener('click', openSettingsDialog);
  settingsDialog.addEventListener('close', () => {
    if (settingsDialog.returnValue !== 'confirm') return;
    const defaultTargetMinutes = readHmInputs('settings-target-hours', 'settings-target-minutes');
    const defaultBreakMinutes = parseInt(document.getElementById('settings-break-minutes').value, 10);
    if (defaultTargetMinutes === null || Number.isNaN(defaultBreakMinutes) || defaultBreakMinutes < 0) return;
    updateSettings({ defaultTargetMinutes, defaultBreakMinutes });
  });

  sessionEditDialog.addEventListener('close', async () => {
    if (sessionEditDialog.returnValue === 'delete' && pendingSessionEditId) {
      const sessionIdToDelete = pendingSessionEditId;
      pendingSessionEditId = null;
      if (await showConfirmDialog('Diese Sitzung wirklich löschen?')) {
        deleteSession(sessionIdToDelete);
      }
      return;
    }
    if (sessionEditDialog.returnValue !== 'confirm' || !pendingSessionEditId) return;
    const session = state.sessions.find((item) => item.id === pendingSessionEditId);
    if (!session) return;
    const baseDate = new Date(session.start);

    const startValue = document.getElementById('session-edit-start').value;
    const [startHours, startMinutes] = startValue.split(':').map(Number);
    const startDate = new Date(baseDate);
    startDate.setHours(startHours, startMinutes, 0, 0);

    let endDate = null;
    const endValue = document.getElementById('session-edit-end').value;
    if (endValue) {
      const [endHours, endMinutes] = endValue.split(':').map(Number);
      endDate = new Date(baseDate);
      endDate.setHours(endHours, endMinutes, 0, 0);
      // If end time appears before start, assume it rolled over past midnight.
      if (endDate < startDate) endDate.setDate(endDate.getDate() + 1);
    }

    const breakMinutes = parseInt(document.getElementById('session-edit-break').value, 10) || 0;
    const note = document.getElementById('session-edit-note').value.trim();
    const sessionId = pendingSessionEditId;
    pendingSessionEditId = null;
    updateSession(sessionId, startDate.toISOString(), endDate ? endDate.toISOString() : null, breakMinutes, note);
  });

  manualEntryDialog.addEventListener('close', () => {
    if (manualEntryDialog.returnValue !== 'confirm') return;
    const dateKey = document.getElementById('manual-entry-date').value;
    const startValue = document.getElementById('manual-entry-start').value;
    const endValue = document.getElementById('manual-entry-end').value;
    if (!dateKey || !startValue || !endValue) return;

    const startDate = combineDateAndTime(dateKey, startValue);
    const endDate = combineDateAndTime(dateKey, endValue);
    // If end appears before/at start, assume it rolled over past midnight.
    if (endDate <= startDate) endDate.setDate(endDate.getDate() + 1);

    const breakMinutes = parseInt(document.getElementById('manual-entry-break').value, 10) || 0;
    const note = document.getElementById('manual-entry-note').value.trim();
    addManualSession(startDate.toISOString(), endDate.toISOString(), breakMinutes, note);
  });

  confirmDialog.addEventListener('close', () => {
    const resolve = pendingConfirmResolve;
    pendingConfirmResolve = null;
    resolve?.(confirmDialog.returnValue === 'confirm');
  });

  importDialog.addEventListener('close', () => {
    const result = pendingImportResult;
    pendingImportResult = null;
    if (importDialog.returnValue !== 'confirm' || !result) return;
    applyImportedEntries(result.sessions, result.compensations, result.dayTargets);
  });

  // Event delegation for dynamically rendered entry rows, shared by both lists.
  async function handleListClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'toggle-month') {
      const monthKey = target.dataset.month;
      const group = target.closest('.month-group');
      const nowExpanded = !expandedMonths.has(monthKey);
      if (nowExpanded) expandedMonths.add(monthKey); else expandedMonths.delete(monthKey);
      group.classList.toggle('is-expanded', nowExpanded);
      target.setAttribute('aria-expanded', String(nowExpanded));
    } else if (action === 'edit-day') {
      openDaySettingsDialog(target.dataset.date);
    } else if (action === 'edit-session') {
      openSessionEditDialog(target.dataset.id);
    } else if (action === 'edit-compensation') {
      openCompensationEditDialog(target.dataset.id);
    }
  }
  historyListEl.addEventListener('click', handleListClick);
  todayListEl.addEventListener('click', handleListClick);
}

/* --------------------------------------------------------------------------
   Header background animation (slowly drifting particle network)
   Purely decorative; pauses while the app is backgrounded to save battery
   and renders a single static frame if the user prefers reduced motion.
   -------------------------------------------------------------------------- */

function initHeaderNetworkAnimation() {
  const canvas = document.getElementById('header-canvas');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');

  // Scales with the header area so the wide desktop hero isn't sparse; phones keep 22.
  const MIN_PARTICLES = 22;
  const MAX_PARTICLES = 90;
  const AREA_PER_PARTICLE = 4000;
  const MAX_LINK_DISTANCE = 90;
  const SPEED = 0.12;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  let width = 0;
  let height = 0;
  let particles = [];
  let running = false;
  let animationFrameId = null;

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function createParticles() {
    particles = Array.from({ length: Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, Math.round((width * height) / AREA_PER_PARTICLE))) }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * SPEED,
      vy: (Math.random() - 0.5) * SPEED,
    }));
  }

  function drawFrame() {
    ctx.clearRect(0, 0, width, height);

    particles.forEach((particle) => {
      particle.x += particle.vx;
      particle.y += particle.vy;
      if (particle.x < 0) particle.x = width;
      if (particle.x > width) particle.x = 0;
      if (particle.y < 0) particle.y = height;
      if (particle.y > height) particle.y = 0;
    });

    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < MAX_LINK_DISTANCE) {
          ctx.strokeStyle = `rgba(255, 255, 255, ${0.22 * (1 - distance / MAX_LINK_DISTANCE)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.stroke();
        }
      }
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    particles.forEach((particle) => {
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    });

    if (running) animationFrameId = requestAnimationFrame(drawFrame);
  }

  function start() {
    if (running) return;
    running = true;
    animationFrameId = requestAnimationFrame(drawFrame);
  }

  function stop() {
    running = false;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  resizeCanvas();
  createParticles();

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) {
    drawFrame(); // single static frame, no ongoing animation
  } else {
    start();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else start();
    });
  }

  window.addEventListener('resize', () => {
    resizeCanvas();
    createParticles();
  });
}

/* --------------------------------------------------------------------------
   Sync status + error feedback
   -------------------------------------------------------------------------- */

const toastEl = document.getElementById('toast');
const syncStatusEl = document.getElementById('sync-status');
let toastTimeout = null;

function showToast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastEl.hidden = true;
  }, 6000);
}

function pendingLabel(count) {
  return `${count} ${count === 1 ? 'Änderung' : 'Änderungen'} ausstehend`;
}

/** Small pill in the header: hidden while everything is synced. */
function renderSyncStatus() {
  const { pending, offline } = store.getStatus();
  let text = '';
  if (offline) text = pending > 0 ? `Offline · ${pendingLabel(pending)}` : 'Offline';
  else if (pending > 0) text = 'Wird synchronisiert …';
  syncStatusEl.textContent = text;
  syncStatusEl.hidden = !text;
  syncStatusEl.classList.toggle('is-offline', offline);
}

store.subscribe({
  onChange(dataChanged) {
    if (dataChanged) renderAll();
    renderSyncStatus();
  },
  onError: showToast,
});

/* --------------------------------------------------------------------------
   Login screen + session handling
   -------------------------------------------------------------------------- */

const loginScreenEl = document.getElementById('login-screen');
const appShellEl = document.getElementById('app-shell');
const loadingScreenEl = document.getElementById('loading-screen');
const loginFormEl = document.getElementById('login-form');
const loginSubtitleEl = document.getElementById('login-subtitle');
const loginEmailEl = document.getElementById('login-email');
const loginPasswordEl = document.getElementById('login-password');
const loginSubmitBtn = document.getElementById('login-submit-btn');
const loginErrorEl = document.getElementById('login-error');
const loginInfoEl = document.getElementById('login-info');
const loginToggleEl = document.getElementById('login-toggle');
const loginTogglePromptEl = document.getElementById('login-toggle-prompt');
const loginToggleBtn = document.getElementById('login-toggle-btn');
const privateNoticeEl = document.getElementById('private-notice');

let loginMode = 'signIn';
let headerAnimationStarted = false;

function setLoginMessage(errorText = '', infoText = '') {
  loginErrorEl.textContent = errorText;
  loginErrorEl.hidden = !errorText;
  loginInfoEl.textContent = infoText;
  loginInfoEl.hidden = !infoText;
}

function renderLoginMode() {
  const isSignIn = loginMode === 'signIn';
  loginSubtitleEl.textContent = isSignIn
    ? 'Melde dich an, um deine Arbeitszeit zu erfassen.'
    : 'Erstelle ein Konto für deine Zeiterfassung.';
  loginSubmitBtn.textContent = isSignIn ? 'Anmelden' : 'Registrieren';
  loginPasswordEl.autocomplete = isSignIn ? 'current-password' : 'new-password';
  loginTogglePromptEl.textContent = isSignIn ? 'Noch kein Konto?' : 'Schon registriert?';
  loginToggleBtn.textContent = isSignIn ? 'Registrieren' : 'Anmelden';
}

function showScreen(name) {
  loadingScreenEl.hidden = name !== 'loading';
  loginScreenEl.hidden = name !== 'login';
  appShellEl.hidden = name !== 'app';
  document.body.classList.toggle('has-tab-bar', name === 'app');

  // The header canvas measures itself, so it can only start once it's visible.
  if (name === 'app' && !headerAnimationStarted) {
    headerAnimationStarted = true;
    initHeaderNetworkAnimation();
  }
}

/** Switches the UI to whoever is signed in now (or to the login screen). */
async function handleUser(user) {
  const userId = user?.id ?? null;
  if (userId === currentUserId) return; // token refresh etc., nothing changed

  currentUserId = userId;
  lastGlobalBalanceMinutes = null;
  lastTodayBalanceMinutes = null;
  const hasCache = store.setUser(userId);

  if (!userId) {
    renderAll();
    renderSyncStatus();
    setLoginMessage();
    loginPasswordEl.value = '';
    showScreen('login');
    return;
  }

  rememberUser(user);
  document.getElementById('account-email').textContent = user.email ?? '';

  // With a local copy the app is usable right away (also offline); otherwise wait for the first load.
  if (!hasCache) {
    showScreen('loading');
    await store.sync();
    if (currentUserId !== userId) return; // signed out while loading
  } else {
    store.sync();
  }
  renderAll();
  renderSyncStatus();
  showScreen('app');
}

function attachLoginListeners() {
  if (signupEnabled) {
    loginToggleEl.hidden = false;
    loginToggleBtn.addEventListener('click', () => {
      loginMode = loginMode === 'signIn' ? 'signUp' : 'signIn';
      setLoginMessage();
      renderLoginMode();
    });
  } else {
    privateNoticeEl.hidden = false;
  }

  loginFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    setLoginMessage();
    loginSubmitBtn.disabled = true;
    loginSubmitBtn.textContent = 'Bitte warten …';
    try {
      if (loginMode === 'signIn') {
        await signInWithPassword(loginEmailEl.value, loginPasswordEl.value);
      } else if (!(await signUp(loginEmailEl.value, loginPasswordEl.value))) {
        setLoginMessage('', 'Fast geschafft! Bitte bestätige deine E-Mail-Adresse über den Link, den wir dir geschickt haben.');
      }
    } catch (error) {
      setLoginMessage(translateAuthError(error));
    } finally {
      loginSubmitBtn.disabled = false;
      renderLoginMode();
    }
  });

  document.getElementById('login-google-btn').addEventListener('click', async () => {
    setLoginMessage();
    try {
      await signInWithGoogle();
    } catch (error) {
      setLoginMessage(translateAuthError(error));
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    const { pending } = store.getStatus();
    const message =
      pending > 0
        ? `Es gibt noch ${pendingLabel(pending)}, die nicht hochgeladen wurden. Beim Abmelden gehen sie verloren.`
        : 'Möchtest du dich abmelden?';
    if (!(await showConfirmDialog(message, { title: 'Abmelden', confirmLabel: 'Abmelden' }))) return;
    // Explicit logout removes this user's data from the device. Switch away first so a
    // sync that's still running can't write the cache back.
    const userId = currentUserId;
    handleUser(null); // also covers offline, where Supabase may not emit SIGNED_OUT
    store.forgetUser(userId);
    await signOut();
  });

  // Data may have changed on another device while the app was in the background.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentUserId) store.sync();
  });
}

/* --------------------------------------------------------------------------
   Service worker registration (offline start of the app shell)
   -------------------------------------------------------------------------- */

function registerServiceWorker() {
  // The dev server would fight with a caching service worker, so production only.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.error('kalika-track: service worker registration failed.', error);
    });
  });
}

/* --------------------------------------------------------------------------
   Init
   -------------------------------------------------------------------------- */

attachEventListeners();
attachLoginListeners();
renderLoginMode();
registerServiceWorker();

initAuth().then(async (user) => {
  await handleUser(user);
  onUserChange(handleUser);
});
