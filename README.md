# kalika-track

Eine mobile-first Progressive Web App (PWA) zur Zeiterfassung mit
Überstunden-/Flexzeitkonto. Läuft vollständig clientseitig (kein Backend,
keine Build-Tools) und speichert alle Daten lokal im `localStorage` des
Geräts.

## Features

- Start/Stopp-Zeiterfassung, mehrere Sitzungen pro Tag möglich
- Pausenzeit und Ziel-Arbeitszeit pro Tag einstellbar (Standard: 8:00h / 30min)
- Automatische Berechnung des globalen Überstundensaldos
- Ausgleich (Freizeitausgleich) bucht Zeit direkt vom Saldo ab
- Tage ohne Zeiterfassung wirken sich nicht negativ auf den Saldo aus
- Vollständige Listenansicht aller Einträge, gruppiert nach Tag
- Offline-fähig via Service Worker, installierbar auf dem iPhone-Homescreen

## Lokal testen

Da die App keine Build-Tools benötigt, reicht ein einfacher statischer
Webserver:

```bash
python3 -m http.server 8080
```

Anschließend `http://localhost:8080` im Browser öffnen.

## Deployment (GitHub Pages)

Das Repository enthält einen GitHub-Actions-Workflow
(`.github/workflows/deploy.yml`), der bei jedem Push auf `main` automatisch
auf GitHub Pages deployt.

Einmalig in den Repository-Einstellungen aktivieren:

**Settings → Pages → Source → "GitHub Actions"**

Danach ist die App unter `https://<user>.github.io/kalika-track/` erreichbar.

## Auf dem iPhone installieren

1. Die deployte URL in Safari öffnen.
2. Teilen-Symbol → "Zum Home-Bildschirm".
3. Die App startet danach im Standalone-Modus mit eigenem Icon.
