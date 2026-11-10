// ─────────────────────────────────────────────────────────────
//  Function 1 — Vessel tracker  (v3)
//  Output 1 → node-red-contrib-web-worldmap
//  Output 2 → websocket out (/ws/telemetry) → the dashboard
//
//  v3 changes, all for the dashboard's benefit:
//    • output 2 now carries fix / positionSource / fixAgeMin /
//      source, so index.html can draw exactly what worldmap draws
//    • battery is read off the packet instead of being hard "--"
//    • the "drop" branch still emits on output 2 (it used to go
//      silent, so the dashboard never learned about that SOS)
//    • every early return keeps the two-output shape
// ─────────────────────────────────────────────────────────────

// ── Tuning ───────────────────────────────────────────────────
const TRAIL_POINTS = 60;    // total breadcrumb points kept per vessel
const COMET_POINTS = 10;    // how many of those get the bright "recent" line
const MIN_MOVE_M = 8;     // ignore GPS jitter smaller than this (metres)
const ICON_PX = 46;    // on-screen icon size
const TTL_SEC = 900;   // marker disappears after this long with no update
const TTL_SOS_SEC = 3600;  // SOS markers linger much longer
const SHOW_LABEL = false; // true = name always visible, false = on hover
const MOVE_ON_BACKLOG = true; // let "B" packets move the live marker too

// The gateway CSV is:  P/B , id , seq , hops , lat , lng , sos
// There is no battery field in it — index 3 is the mesh hop count. Leave
// BATT_INDEX null unless you add a volts field to the vessel packet, or the
// dashboard will happily report "0.00 V" for every boat.
const BATT_INDEX = null;

// What to do with an SOS that has no GPS fix and NO position history:
//   "home"  → drop it on HOME_POS below (recommended: your base station)
//   "null"  → drop it on 0,0 (Null Island, off Africa — usually not useful)
//   "drop"  → don't map it at all, but still send the alert message
const NO_FIX_FALLBACK = "home";
const HOME_POS = [10.3157, 123.8854];   // Cebu City — change to your base

// Non-SOS packets with no fix are always ignored. Set true to map them too.
const MAP_NOFIX_NORMAL = false;

// ── Parse ────────────────────────────────────────────────────
const parts = String(msg.payload).trim().split(",");
if (parts.length < 7) { return [null, null]; }
if (parts[0] !== "P" && parts[0] !== "B") { return [null, null]; }

const vesselId = parts[1];
const isBacklog = parts[0] === "B";
const hops = parts[3];
const latRaw = parseFloat(parts[4]);
const lonRaw = parseFloat(parts[5]);
const sos = parts[6] === "1";

let battery = "--";
if (BATT_INDEX !== null && parts[BATT_INDEX] !== undefined) {
    const b = parseFloat(parts[BATT_INDEX]);
    if (isFinite(b)) { battery = b.toFixed(2); }
}

if (!isFinite(latRaw) || !isFinite(lonRaw)) { return [null, null]; }
if (Math.abs(latRaw) > 90 || Math.abs(lonRaw) > 180) { return [null, null]; }

// Either coordinate being exactly zero means the module hasn't locked yet.
// (A genuine 0.000000 is in the Atlantic/Gulf of Guinea, so this is safe here.)
const noFix = (latRaw === 0 || lonRaw === 0);

// A no-fix ping is only interesting if it's a distress call.
if (noFix && !sos && !MAP_NOFIX_NORMAL) { return [null, null]; }

// ── Geo helpers ──────────────────────────────────────────────
const rad = (d) => d * Math.PI / 180;

function metresBetween(la1, lo1, la2, lo2) {
    const R = 6371000;
    const dLa = rad(la2 - la1);
    const dLo = rad(lo2 - lo1);
    const a = Math.sin(dLa / 2) ** 2 +
        Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingBetween(la1, lo1, la2, lo2) {
    const y = Math.sin(rad(lo2 - lo1)) * Math.cos(rad(la2));
    const x = Math.cos(rad(la1)) * Math.sin(rad(la2)) -
        Math.sin(rad(la1)) * Math.cos(rad(la2)) * Math.cos(rad(lo2 - lo1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ── History (per vessel, kept in flow context) ───────────────
const KEY = "wake_" + vesselId;
const now = Date.now();
const state = flow.get(KEY) || { pts: [], t: 0, brg: 0, kts: 0 };

// Only real fixes are allowed to touch the trail, bearing and speed.
if (!noFix) {
    let movedM = null;
    if (state.pts.length) {
        const [pLat, pLon] = state.pts[state.pts.length - 1];
        movedM = metresBetween(pLat, pLon, latRaw, lonRaw);
    }

    if (movedM === null || movedM >= MIN_MOVE_M) {
        if (movedM !== null) {
            const [pLat, pLon] = state.pts[state.pts.length - 1];
            state.brg = bearingBetween(pLat, pLon, latRaw, lonRaw);
            const dtS = (now - state.t) / 1000;
            if (dtS > 0.5 && dtS < 3600) { state.kts = (movedM / dtS) * 1.94384; }
        }
        state.pts.push([latRaw, lonRaw]);
        if (state.pts.length > TRAIL_POINTS) { state.pts = state.pts.slice(-TRAIL_POINTS); }
        state.t = now;
        flow.set(KEY, state);
    }
}

// ── Timestamp helpers ────────────────────────────────────────
const stamp = new Date().toLocaleTimeString("en-PH", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: true, timeZone: "Asia/Manila"
});

// Builds the object the dashboard's ingest() expects.
function dashboardMsg(o) {
    return {
        topic: "vessel/telemetry",
        payload: {
            id: vesselId,
            lat: o.lat,
            lon: o.lon,
            status: sos ? "SOS" : "Normal",
            speed: o.knots === null ? "--" : o.knots.toFixed(1),
            heading: o.heading,
            battery: battery,
            hops: hops,
            timestamp: stamp,
            fix: !noFix,
            positionSource: o.posSource,
            fixAgeMin: o.fixAgeMin,
            source: isBacklog ? "Backlog" : "Live",
            mapped: o.mapped,
            ts: now
        }
    };
}

// ── Where do we actually draw it? ────────────────────────────
let lat, lon, posSource, fixAgeMin = null;

if (!noFix) {
    lat = latRaw; lon = lonRaw;
    posSource = "GPS fix";
} else if (state.pts.length) {
    [lat, lon] = state.pts[state.pts.length - 1];
    posSource = "Last known";
    if (state.t) { fixAgeMin = Math.round((now - state.t) / 60000); }
} else if (NO_FIX_FALLBACK === "home") {
    [lat, lon] = HOME_POS;
    posSource = "No fix - base station";
} else if (NO_FIX_FALLBACK === "null") {
    lat = 0; lon = 0;
    posSource = "No fix - 0,0";
} else {
    // "drop": nothing on the map, but the alert and the dashboard
    // still hear about it — a silent SOS is the worst outcome here.
    const alert = {
        topic: "vessel/alert",
        payload: {
            vessel: vesselId, sos: sos, fix: false, mapped: false,
            reason: "SOS received with no GPS fix and no position history",
            ts: now
        }
    };
    return [
        [alert],
        dashboardMsg({ lat: 0, lon: 0, knots: null, heading: 0,
                       posSource: "No fix - not mapped", fixAgeMin: null, mapped: false })
    ];
}

const heading = Math.round(state.brg);
const knots = noFix ? 0 : state.kts;
const underway = knots > 0.3;

// ── The boat ─────────────────────────────────────────────────
// Top-down bangka: hull, bamboo outriggers (katig), canopy, wake.
// Rotation is baked into the SVG so it works on any worldmap version.
function pumpboatIcon(deg, distress, moving, nofix) {
    const hull = distress ? "#7f1d1d" : "#12435f";
    const deck = distress ? "#fde7e7" : "#e6f4f7";
    const canopy = distress ? "#e63946" : "#3f92c4";
    const katig = distress ? "#e0a458" : "#c9a227";
    const outline = "#08202c";

    const pulse = distress ? `
    <circle cx="32" cy="32" r="13" fill="none" stroke="#e63946" stroke-width="2.5">
      <animate attributeName="r" values="12;29;12" dur="1.6s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.85;0;0.85" dur="1.6s" repeatCount="indefinite"/>
    </circle>` : "";

    // Dashed ring + "?" badge = position is not trustworthy.
    const fixWarn = nofix ? `
    <circle cx="32" cy="32" r="22" fill="none" stroke="#94a3b8" stroke-width="2"
            stroke-dasharray="4 5" opacity="0.95"/>
    <g transform="translate(50,13)">
      <circle r="9.5" fill="#0f172a" opacity="0.9"/>
      <text x="0" y="4.5" text-anchor="middle" font-family="system-ui,sans-serif"
            font-size="13" font-weight="700" fill="#f8fafc">?</text>
    </g>` : "";

    const wake = moving ? `
    <g stroke="#ffffff" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.55">
      <path d="M27.5 57 q-2.5 2.5 -3.5 5"/>
      <path d="M36.5 57 q2.5 2.5 3.5 5"/>
    </g>` : "";

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  ${pulse}
  <g transform="rotate(${deg} 32 32)" opacity="${nofix ? "0.75" : "1"}">
    ${wake}
    <g stroke="${katig}" stroke-width="2.6" stroke-linecap="round" opacity="0.95">
      <line x1="12" y1="27" x2="52" y2="27"/>
      <line x1="12" y1="43" x2="52" y2="43"/>
    </g>
    <path d="M12 17 C14.5 26 14.5 42 12 51 C9.5 42 9.5 26 12 17 Z"
          fill="${katig}" stroke="${outline}" stroke-width="0.8"/>
    <path d="M52 17 C54.5 26 54.5 42 52 51 C49.5 42 49.5 26 52 17 Z"
          fill="${katig}" stroke="${outline}" stroke-width="0.8"/>
    <path d="M32 5 C38 15 40 31 39 48 C39 53 36 56.5 32 57.5
             C28 56.5 25 53 25 48 C24 31 26 15 32 5 Z"
          fill="${hull}" stroke="${outline}" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M32 13 C36 21 37 32 36.5 46 C36.5 50 34.5 52 32 52.5
             C29.5 52 27.5 50 27.5 46 C27 32 28 21 32 13 Z"
          fill="${deck}" opacity="0.9"/>
    <rect x="27" y="29" width="10" height="15" rx="3.5"
          fill="${canopy}" stroke="${outline}" stroke-width="0.9"/>
    <path d="M32 8 L34.5 15 L29.5 15 Z" fill="${deck}" opacity="0.95"/>
    <rect x="30" y="53" width="4" height="4" rx="1.2" fill="${outline}" opacity="0.85"/>
  </g>
  ${fixWarn}
</svg>`;
}

const iconUri = "data:image/svg+xml;charset=UTF-8," +
    encodeURIComponent(pumpboatIcon(heading, sos, underway, noFix));

// ── Popup card ───────────────────────────────────────────────
const chipBg = sos ? "#fee2e2" : "#dcfce7";
const chipFg = sos ? "#991b1b" : "#166534";
const row = (k, v) =>
    `<tr><td style="color:#64748b;padding:2px 12px 2px 0;white-space:nowrap">${k}</td>` +
    `<td style="color:#0f172a;font-variant-numeric:tabular-nums">${v}</td></tr>`;

const fixBanner = noFix ? `
  <div style="margin:8px 0 2px;padding:6px 9px;border-radius:6px;background:#fef3c7;
              border:1px solid #fcd34d;color:#78350f;font-size:11.5px;line-height:1.35">
    <b>NO GPS FIX</b><br>
    ${state.pts.length
        ? "Pin shows the last confirmed position" +
        (fixAgeMin !== null ? ` (${fixAgeMin} min ago).` : ".") +
        " The vessel may have moved since."
        : "No position ever received from this unit. Pin is a placeholder, not a location."}
  </div>` : "";

const posText = noFix
    ? (state.pts.length ? `${lat.toFixed(5)}, ${lon.toFixed(5)} <span style="color:#b45309">(stale)</span>`
        : `<span style="color:#b45309">unknown</span>`)
    : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

const popup = `<div style="font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-width:200px">
  <div style="display:flex;align-items:center;gap:8px;padding-bottom:7px;border-bottom:1px solid #e2e8f0">
    <span style="font-size:17px">${sos ? "🆘" : "⛵"}</span>
    <b style="font-size:14px;letter-spacing:.4px;color:#0f172a">${vesselId}</b>
  </div>
  <div style="margin:8px 0 6px;display:inline-block;padding:3px 10px;border-radius:999px;
              background:${chipBg};color:${chipFg};font-size:11px;font-weight:700;letter-spacing:.6px">
    ${sos ? (noFix ? "SOS - NO FIX" : "SOS ACTIVE") : "NORMAL"}
  </div>
  ${fixBanner}
  <table style="border-collapse:collapse;font-size:12px;margin-top:6px">
    ${row("Position", posText)}
    ${row("Fix", posSource)}
    ${row("Heading", noFix ? "&mdash;" : `${heading}&deg;`)}
    ${row("Speed", noFix ? "&mdash;" : `${knots.toFixed(1)} kn`)}
    ${row("Relay hops", hops === undefined ? "&mdash;" : hops)}
    ${row("Battery", battery === "--" ? "&mdash;" : battery + " V")}
    ${row("Source", isBacklog ? "Backlog" : "Live")}
    ${row("Updated", stamp)}
  </table>
</div>`;

// ── Messages out ─────────────────────────────────────────────
const out = [];
const pts = state.pts;

if (pts.length > 1) {
    // Full history: thin, dashed, faded.
    out.push({
        payload: {
            name: vesselId + " track",
            layer: "Tracks",
            line: pts,
            color: sos ? "#fca5a5" : "#7dd3fc",
            weight: 2,
            opacity: 0.45,
            dashArray: "1 7",
            clickable: false
        }
    });

    // Recent leg: brighter and thicker, so it reads as a comet tail.
    out.push({
        payload: {
            name: vesselId + " wake",
            layer: "Tracks",
            line: pts.slice(-COMET_POINTS),
            color: sos ? "#ef4444" : "#22d3ee",
            weight: 4,
            opacity: 0.95,
            clickable: false
        }
    });
}

if (!isBacklog || MOVE_ON_BACKLOG) {
    const marker = {
        name: vesselId,
        lat: lat,
        lon: lon,
        layer: sos ? "Distress" : "Vessels",
        icon: iconUri,
        iconSize: ICON_PX,
        popup: popup,
        popupOptions: { className: "vesselPopup" },
        ttl: sos ? TTL_SOS_SEC : TTL_SEC
    };
    const labelText = vesselId + (noFix ? " (no fix)" : "");
    if (SHOW_LABEL) { marker.label = labelText; } else { marker.tooltip = labelText; }
    out.push({ payload: marker });
}

// Machine-readable alert for buzzers / SMS / logging nodes downstream.
if (sos) {
    out.push({
        topic: "vessel/alert",
        payload: {
            vessel: vesselId, sos: true, fix: !noFix, mapped: true,
            lat: lat, lon: lon, positionSource: posSource,
            fixAgeMin: fixAgeMin, ts: now
        }
    });
}

// Output 1 → worldmap.  Output 2 → websocket → dashboard.
return [
    out.length ? out : null,
    dashboardMsg({ lat: lat, lon: lon, knots: knots, heading: heading,
                   posSource: posSource, fixAgeMin: fixAgeMin, mapped: true })
];
