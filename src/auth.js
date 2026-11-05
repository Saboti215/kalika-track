import { supabase } from './supabase.js';

// Signup is on unless ENABLE_SIGNUP is explicitly "false". This only hides the UI;
// the real enforcement must happen in Supabase Auth (GOTRUE_DISABLE_SIGNUP).
export const signupEnabled = import.meta.env.ENABLE_SIGNUP !== 'false';

function getAppBaseUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

/** Resolves the current session (after exchanging a PKCE "?code=" in the URL) and strips auth params. */
export async function initAuth() {
  const { data } = await supabase.auth.getSession();

  const url = new URL(window.location.href);
  const authParams = ['code', 'error', 'error_code', 'error_description'];
  if (authParams.some((param) => url.searchParams.has(param))) {
    authParams.forEach((param) => url.searchParams.delete(param));
    window.history.replaceState(window.history.state, '', url.toString());
  }

  return data.session;
}

/** Calls back with the new session (or null) whenever the signed-in user changes. */
export function onSessionChange(callback) {
  supabase.auth.onAuthStateChange((_event, session) => {
    // Supabase warns against awaiting other supabase calls inside this callback, so defer.
    setTimeout(() => callback(session), 0);
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
  await supabase.auth.signOut();
}
