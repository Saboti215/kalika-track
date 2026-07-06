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

## Struktur

Die eigentliche Anwendung liegt im Unterordner `app/`. Die `index.html` im
Repository-Root ist eine schlichte Landingpage mit einem Button, der zur App
verlinkt — der direkte Aufruf der Root-URL zeigt also nicht sofort die
laufende Anwendung.

```
index.html   Landingpage (Root)
app/         eigentliche PWA (index.html, app.js, style.css, manifest.json, sw.js, icons/)
```

Hinweis: Das ist eine reine UX-Weiche, keine Zugriffskontrolle — GitHub Pages
ist statisches Hosting ohne Backend/Login, `app/` bleibt für jeden mit dem
direkten Link erreichbar.

## Lokal testen

Da die App keine Build-Tools benötigt, reicht ein einfacher statischer
Webserver im Repository-Root:

```bash
python3 -m http.server 8080
```

Anschließend `http://localhost:8080` (Landingpage) oder direkt
`http://localhost:8080/app/` (App) im Browser öffnen.

## Deployment (GitHub Pages)

Das Repository enthält einen GitHub-Actions-Workflow
(`.github/workflows/deploy.yml`), der bei jedem Push auf `main` automatisch
auf GitHub Pages deployt.

Einmalig in den Repository-Einstellungen aktivieren:

**Settings → Pages → Source → "GitHub Actions"**

Danach ist die Landingpage unter `https://<user>.github.io/kalika-track/`
und die App direkt unter `https://<user>.github.io/kalika-track/app/`
erreichbar.

## Auf dem iPhone installieren

1. Die deployte URL in Safari öffnen und auf "App öffnen" tippen (das führt
   zu `/app/` — genau von dort aus installieren, nicht von der Landingpage).
2. Teilen-Symbol → "Zum Home-Bildschirm".
3. Die App startet danach im Standalone-Modus mit eigenem Icon direkt in
   `/app/`, ohne über die Landingpage zu gehen.

> Falls die App vor dieser Umstrukturierung bereits auf dem Home-Bildschirm
> installiert war, zeigt das alte Icon jetzt die Landingpage statt der App.
> Einmalig entfernen und über Schritt 1–3 neu hinzufügen, damit es wieder
> direkt in die App startet.
