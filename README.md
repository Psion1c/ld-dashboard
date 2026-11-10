# Lantaw-Dagat — shoreline monitoring station

Dashboard rebuilt so it mirrors the Node-RED node **Function 1 (vessel tracker)**.
Same tuning constants, same geo maths, same no-fix rules, same bangka icon,
same popup card — a boat looks identical on worldmap and here.

## Folder layout

```
lantaw-dagat/
├── index.html
├── style.css
├── app.js                 ← all dashboard logic (ported from Function 1)
└── lib/
    └── leaflet/
        ├── leaflet.js
        ├── leaflet.css
        └── images/
            ├── layers.png
            ├── layers-2x.png
            ├── marker-icon.png
            ├── marker-icon-2x.png
            └── marker-shadow.png
```

Keep your existing `lib/leaflet` folder exactly where it is — the paths haven't changed.
Nothing is loaded from a CDN except the OSM tiles, so the page still works offline
once you point the tile layer at your local tile server.

## Node-RED wiring

```
[ serial / MQTT in ]
        │
   [ Function 1 ]  ← paste function1-vessel-tracker.js, set Outputs = 2
     │        │
 output 1   output 2
     │        │
[worldmap] [websocket out]   URL: /ws/telemetry, "Send/Receive: entire message" OFF
```

With "entire message" off, Node-RED sends only `msg.payload` — which is what the
dashboard expects. It also accepts the wrapped `{topic, payload}` form, and raw
`P,ID,...,lat,lon,sos` strings, so a plain serial→websocket bridge works too.

## What each tuning constant does

Both files carry the same block at the top. Change them in **both** places or the
map and the dashboard will disagree.

| Constant | Meaning |
|---|---|
| `TRAIL_POINTS` | breadcrumb points kept per vessel |
| `COMET_POINTS` | how many get the bright recent wake |
| `MIN_MOVE_M` | GPS jitter below this is ignored |
| `TTL_SEC` / `TTL_SOS_SEC` | how long a silent marker survives |
| `STALE_SEC` | dashboard only — dims a row that's gone quiet |
| `NO_FIX_FALLBACK` / `HOME_POS` | where an SOS with no fix and no history goes |
| `MAP_NOFIX_NORMAL` | map non-distress packets that have no fix |
| `WS_URL` | dashboard only — the gateway websocket |

## Demo feed

The **Start demo feed** button in the top bar runs four simulated bangkas, one of
which loses its GPS fix and then calls for help without one. Nothing is transmitted
while the demo is running — the return-to-port button says so instead of pretending.
Stop it (or connect a real gateway) before any live watch.

## Deployment (GitHub Pages)

To publish this static dashboard as a website via GitHub Pages:

- Create a new repository on GitHub and push this project to it.
- The supplied GitHub Actions workflow will publish the repository root to the `gh-pages` branch on pushes to `main`.

Example commands (PowerShell):

```powershell
git init
git branch -M main
git add .
git commit -m "Initial commit"
# Create the remote (replace <OWNER> and <REPO>), then push:
git remote add origin https://github.com/<OWNER>/<REPO>.git
git push -u origin main
```

After the first push the `Deploy to GitHub Pages` workflow will run and publish the site to GitHub Pages at `https://<OWNER>.github.io/<REPO>/`.
