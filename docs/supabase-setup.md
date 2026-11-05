# Supabase einrichten

kalika-track nutzt dieselben Bausteine wie kalika-whish: Supabase für Datenbank und Login
(E-Mail/Passwort und Google) und ein Docker-Image mit nginx für die statische App.

> **Gleiches Supabase-Projekt wie kalika-whish?** Das geht problemlos: Alle Tabellen haben das Präfix
> `kalika_track_` und kollidieren nicht mit `kalika_whish_*`. Login-Konten werden geteilt.
> Dann sind nur **Schritt 3** (Schema) und **Schritt 5** (Redirect-URL der neuen Domain) nötig, und
> in die `.env` kommen dieselben Werte wie bei kalika-whish.

## 1. Projekt anlegen (nur bei eigenem Projekt)

1. Auf [supabase.com](https://supabase.com) einloggen → **New project**.
2. Region: **Central EU (Frankfurt)**, ein sicheres Datenbank-Passwort vergeben.

## 2. API-Schlüssel eintragen

1. Dashboard → **Project Settings → API Keys**.
2. **Project URL** und **anon / publishable key** notieren.
   ⚠️ Den `service_role`- bzw. `secret`-Key **niemals** ins Frontend oder in `.env` eintragen.
3. Im Projektordner `cp .env.example .env` und eintragen:

   ```
   VITE_SUPABASE_URL=https://abcdefgh.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
   ENABLE_SIGNUP=true
   ```

## 3. Datenbank-Schema einspielen

**Variante A – SQL Editor:** Dashboard → **SQL Editor** → **New query** → Inhalt von
[`supabase/migrations/00001_initial_schema.sql`](../supabase/migrations/00001_initial_schema.sql) einfügen → **Run**.

**Variante B – Supabase CLI:**

```bash
npx supabase login
npx supabase link --project-ref abcdefgh
npx supabase db push
```

Kontrolle unter **Table Editor**: `kalika_track_sessions`, `kalika_track_days`, `kalika_track_compensations`
und `kalika_track_settings`, alle mit „RLS enabled“.

## 4. Auth: E-Mail/Passwort und Google (nur bei eigenem Projekt)

Identisch zu kalika-whish, siehe dort `docs/supabase-setup.md`, Schritte 6 und 7:
Email-Provider aktivieren, Google OAuth-Client anlegen (Redirect-URI
`https://<ref>.supabase.co/auth/v1/callback`) und Client ID/Secret unter
**Authentication → Sign In / Providers → Google** hinterlegen.

Bei geteiltem Projekt: In der Google Cloud Console beim bestehenden OAuth-Client unter
**Authorized JavaScript origins** zusätzlich `https://<kalika-track-domain>` eintragen.

## 5. Auth: URLs konfigurieren

Dashboard → **Authentication → URL Configuration** → **Redirect URLs** ergänzen:

| Wert |
|---|
| `http://localhost:5173/**` |
| `https://<kalika-track-domain>/**` |

Ohne diesen Eintrag leitet Supabase nach Google-Login oder Bestätigungs-Mail nicht zurück zur App.

## 6. Self-Hosting mit Docker

```bash
cp .env.example .env   # Werte eintragen
docker compose up -d --build
```

Die App läuft auf Port **8081**, damit sie neben kalika-whish (8080) auf demselben Host laufen kann.
Davor einen Reverse Proxy mit HTTPS setzen (z. B. Nginx Proxy Manager, Caddy, Traefik).

Die Supabase-Werte werden beim Build ins JavaScript eingebaut. Nach einer Änderung an `.env`
oder einem `git pull` daher erneut `docker compose up -d --build` ausführen.

### Registrierung abschalten

Mit `ENABLE_SIGNUP=false` blendet die App die Registrierung aus und zeigt den Hinweis
„Private Anwendung. Kein öffentliches Angebot, keine Registrierung möglich.“
Das ist nur die Oberfläche. Damit wirklich niemand ein Konto anlegen kann (auch nicht per Google-Login
oder direkt über die Auth-API), zusätzlich in Supabase Auth `GOTRUE_DISABLE_SIGNUP=true` setzen
(im Supabase-Docker-Setup: `DISABLE_SIGNUP=true`; in Supabase Cloud: **Authentication → Sign In / Providers →
Allow new users to sign up** aus). Bestehende Konten können sich weiterhin anmelden.

## 7. Daten aus der alten Version übernehmen

Die alte Version speicherte alles im `localStorage` des Geräts. Umzug per CSV:

1. In der **alten** App: Historie → **CSV exportieren**.
2. In der **neuen** App anmelden → Historie → **CSV importieren** → Datei wählen → **Importieren**.

Der Import läuft in einer einzigen Transaktion (alles oder nichts). Er prüft nicht auf Duplikate,
die Datei also nur **einmal** importieren. Eine gerade laufende Sitzung wird nicht exportiert;
sie vorher in der alten App stoppen.

## Fehlerbehebung

| Problem | Ursache / Lösung |
|---|---|
| Weiße Seite, Konsole: „Missing VITE_SUPABASE_URL …“ | `.env` fehlt bzw. Image ohne Build-Args gebaut. |
| „Speichern fehlgeschlagen“ / „Daten konnten nicht geladen werden“ | Schema (Schritt 3) fehlt oder keine Verbindung. |
| Nach Google-Login falsche Seite / localhost:3000 | Redirect-URL in Schritt 5 fehlt. |
| Google-Login: „redirect_uri_mismatch“ | Redirect-URI im Google-Client stimmt nicht mit `https://<ref>.supabase.co/auth/v1/callback` überein. |
