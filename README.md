# kalika-track

Eine mobile-first Progressive Web App (PWA) zur Zeiterfassung mit
Überstunden-/Flexzeitkonto. Die Daten liegen in Supabase, angemeldet wird
per E-Mail/Passwort oder Google, so dass dieselben Daten auf allen Geräten verfügbar sind.

## Features

- Start/Stopp-Zeiterfassung, mehrere Sitzungen pro Tag möglich, geräteübergreifend
  (Start am Handy, Stopp am Rechner)
- Pausenzeit und Ziel-Arbeitszeit pro Tag einstellbar (Standard: 8:00h / 30min)
- Automatische Berechnung des globalen Überstundensaldos
- Ausgleich (Freizeitausgleich) bucht Zeit direkt vom Saldo ab
- Tage ohne Zeiterfassung wirken sich nicht negativ auf den Saldo aus
- Historie gruppiert nach Monat und Tag
- CSV-Export und -Import (Backup, Umzug aus der alten localStorage-Version)
- Offline-Modus: Änderungen werden lokal zwischengespeichert und bei der nächsten Verbindung hochgeladen
- Installierbar auf dem iPhone-Homescreen

## Setup

1. Supabase einrichten, Schritt für Schritt in **[docs/supabase-setup.md](docs/supabase-setup.md)**
   (Schema, Login, Docker, Datenübernahme).
2. `cp .env.example .env` und Werte eintragen
3. `npm install && npm run dev` → <http://localhost:5173>

## Konfiguration (`.env`)

| Variable | Bedeutung |
|---|---|
| `VITE_SUPABASE_URL` | Project URL von Supabase |
| `VITE_SUPABASE_ANON_KEY` | öffentlicher anon/publishable Key |
| `ENABLE_SIGNUP` | `false` blendet die Registrierung aus und zeigt den Hinweis auf eine private App |

Dieselben Variablen wie bei kalika-whish; beide Apps können sich ein Supabase-Projekt teilen.

## Deployment (Docker)

```bash
cp .env.example .env   # Supabase-URL und Anon-Key eintragen
docker compose up -d --build
```

Die App läuft danach auf Port `8081`, Details siehe
[Supabase-Anleitung, Schritt 6](docs/supabase-setup.md#6-self-hosting-mit-docker).

## Auf dem iPhone installieren

1. Die App-URL in Safari öffnen und anmelden.
2. Teilen-Symbol → "Zum Home-Bildschirm".
