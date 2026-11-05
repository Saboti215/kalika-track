import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { supabase } from './supabase.js';

const LAST_USER_KEY = 'kalika-track:last-user';
// Offline, refreshing an expired token is retried with backoff for a long time; don't wait for that.
const SESSION_TIMEOUT_MS = 3000;

// Signup is on unless ENABLE_SIGNUP is explicitly "false". This only hides the UI;
// the real enforcement must happen in Supabase Auth (GOTRUE_DISABLE_SIGNUP).
export const signupEnabled = import.meta.env.ENABLE_SIGNUP !== 'false';

function getAppBaseUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

/**
 * Resolves the signed-in user (after exchanging a PKCE "?code=" in the URL) and strips auth params.
 * Offline, an expired access token can't be refreshed and Supabase reports no session even though
 * the user never signed out (or keeps retrying the refresh for a while). In that case the last known
 * user is returned so the app keeps working from its local cache; Supabase refreshes the token once
 * the connection is back and reports a real sign-out via onUserChange.
 */
export async function initAuth() {
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), SESSION_TIMEOUT_MS));
  const result = await Promise.race([supabase.auth.getSession(), timeout]);
  if (result.timedOut) return getLastUser();
  const { data, error } = result;

  const url = new URL(window.location.href);
  const authParams = ['code', 'error', 'error_code', 'error_description'];
  if (authParams.some((param) => url.searchParams.has(param))) {
    authParams.forEach((param) => url.searchParams.delete(param));
    window.history.replaceState(window.history.state, '', url.toString());
  }

  if (data.session) return data.session.user;
  if (isAuthRetryableFetchError(error)) return getLastUser();
  return null;
}

/** Remembers who was signed in last, for starting offline (see initAuth). */
export function rememberUser(user) {
  try {
    localStorage.setItem(LAST_USER_KEY, JSON.stringify({ id: user.id, email: user.email ?? '' }));
  } catch {
    // Without storage the app simply needs a connection to start.
  }
}

function getLastUser() {
  try {
    return JSON.parse(localStorage.getItem(LAST_USER_KEY));
  } catch {
    return null;
  }
}

/**
 * Calls back with the user on sign-in and with null on sign-out. Other events with a missing
 * session (e.g. a token that couldn't be refreshed offline) are ignored on purpose.
 */
export function onUserChange(callback) {
  supabase.auth.onAuthStateChange((event, session) => {
    // Supabase warns against awaiting other supabase calls inside this callback, so defer.
    if (event === 'SIGNED_OUT') setTimeout(() => callback(null), 0);
    else if (session) setTimeout(() => callback(session.user), 0);
  });
}

export function translateAuthError(error) {
  const message = error?.message ?? '';
  if (message.includes('Invalid login credentials')) return 'E-Mail oder Passwort ist falsch.';
  if (message.includes('Email not confirmed')) return 'Bitte bestätige zuerst deine E-Mail-Adresse.';
  if (message.includes('User already registered')) return 'Diese E-Mail-Adresse ist bereits registriert.';
  if (message.includes('Password should be')) return 'Das Passwort muss mindestens 6 Zeichen lang sein.';
  if (message.includes('Signups not allowed')) return 'Neue Registrierungen sind derzeit deaktiviert.';
  return 'Etwas ist schiefgelaufen. Bitte versuche es erneut.';
}

export async function signInWithPassword(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

/** Returns true if the user is signed in right away, false if an email confirmation is pending. */
export async function signUp(email, password) {
  if (!signupEnabled) throw new Error('Signups not allowed');
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: getAppBaseUrl() },
  });
  if (error) throw error;
  return Boolean(data.session);
}

export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: getAppBaseUrl() },
  });
  if (error) throw error;
}

export async function signOut() {
  localStorage.removeItem(LAST_USER_KEY);
  // Offline the server-side sign-out fails; then at least drop the session on this device.
  const { error } = await supabase.auth.signOut();
  if (error) await supabase.auth.signOut({ scope: 'local' });
}
