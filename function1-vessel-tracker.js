// ─────────────────────────────────────────────────────────────
//  Function 1 — Vessel tracker (v3.1 Defense Ready — SOS Restore Fix)
//  Output 1 → node-red-contrib-web-worldmap
//  Output 2 → websocket out (/ws/telemetry) → Lantaw-Dagat Dashboard
// ─────────────────────────────────────────────────────────────

// ── Tuning ───────────────────────────────────────────────────
const TRAIL_POINTS = 60;    // total breadcrumb points kept per vessel
const COMET_POINTS = 10;    // how many of those get the bright "recent" line
const MIN_MOVE_M = 8;       // ignore GPS jitter smaller than this (metres)
const ICON_PX = 46;         // on-screen icon size
const TTL_SEC = 900;        // marker disappears after this long with no update
const TTL_SOS_SEC = 3600;   // SOS markers linger much longer
const SHOW_LABEL = false;   // true = name always visible, false = on hover
const MOVE_ON_BACKLOG = true; // let "B" packets move the live marker too

const BATT_INDEX = null;
const NO_FIX_FALLBACK = "home";
const HOME_POS = [10.2928, 123.9095]; // Cebu Pier 1 coastal fallback
const MAP_NOFIX_NORMAL = false;

// ── 1. Capture RSSI / SNR from Gateway '# RX' debug lines ────
let rawLine = String(msg.payload || "").trim();
if (!rawLine) { return [null, null]; }

if (rawLine.startsWith("#")) {
    const rssiMatch = rawLine.match(/rssi=(-?\d+)dBm/i);
    const snrMatch  = rawLine.match(/snr=(-?[\d.]+)dB/i);
    if (rssiMatch || snrMatch) {
        flow.set("last_rf_metrics", {
            rssi: rssiMatch ? Number(rssiMatch[1]) : "--",
            snr:  snrMatch  ? Number(snrMatch[1])  : "--",
            ts:   Date.now()
        });
    }
    return [null, null];
}

// Strip "Received: " prefix if Gateway is connected via USB-C Serial (115200)
if (rawLine.startsWith("Received:")) {
    rawLine = rawLine.replace(/^Received:\s*/i, "").trim();
}
const pbMatch = rawLine.match(/([PB]),.*/);
if (pbMatch) {
    rawLine = pbMatch[0];
}

// ── 2. Parse CSV: P/B , id , seq , hops , lat , lng , sos ────
const parts = rawLine.split(",");
if (parts.length < 7) { return [null, null]; }
if (parts[0] !== "P" && parts[0] !== "B") { return [null, null]; }

const vesselId  = parts[1].trim();
const isBacklog = parts[0] === "B";
const seqRaw    = parseInt(parts[2], 10);
const seqNum    = isFinite(seqRaw) ? seqRaw : null;
const hopsRaw   = parseInt(parts[3], 10);
const hops      = isFinite(hopsRaw) ? hopsRaw : 0;
const latRaw    = parseFloat(parts[4]);
const lonRaw    = parseFloat(parts[5]);
const sosField  = String(parts[6]).trim().toUpperCase();
const sos       = (sosField === "1" || sosField === "SOS" || sosField === "TRUE");

let battery = "--";
if (BATT_INDEX !== null && parts[BATT_INDEX] !== undefined) {
    const b = parseFloat(parts[BATT_INDEX]);
    if (isFinite(b)) { battery = b.toFixed(2); }
}

if (!isFinite(latRaw) || !isFinite(lonRaw)) { return [null, null]; }
if (Math.abs(latRaw) > 90 || Math.abs(lonRaw) > 180) { return [null, null]; }

const noFix = (latRaw === 0 || lonRaw === 0);

// ── History (per vessel, kept in flow context) ───────────────
const KEY = "wake_" + vesselId;
const now = Date.now();
const state = flow.get(KEY) || { pts: [], t: 0, brg: 0, kts: 0, rssi: "--", snr: "--", sos: false, mapped: false, heard: 0, missed: 0, lastSeq: null, backlogCount: 0, pdr: 100.0 };
const wasSos = !!state.sos;
const wasMapped = !!state.mapped;

// Allow a no-fix packet through if the vessel is clearing an active SOS or is already mapped
if (noFix && !sos && !wasSos && !wasMapped && !MAP_NOFIX_NORMAL) { return [null, null]; }

// Read most recent RSSI/SNR captured within the last 3 seconds
const lastRf = flow.get("last_rf_metrics") || null;
const pktRssi = (lastRf && (Date.now() - lastRf.ts) < 3000) ? lastRf.rssi : "--";
const pktSnr  = (lastRf && (Date.now() - lastRf.ts) < 3000) ? lastRf.snr  : "--";

if (pktRssi !== "--") { state.rssi = pktRssi; }
if (pktSnr  !== "--") { state.snr  = pktSnr; }
state.sos = sos;

if (seqNum !== null) {
    if (!isBacklog) {
        if (state.lastSeq !== null) {
            if (seqNum > state.lastSeq) {
                const gap = seqNum - state.lastSeq - 1;
                if (gap > 0 && gap < 200) { state.missed = (state.missed || 0) + gap; }
            } else if (seqNum < state.lastSeq) {
                state.heard = 0; state.missed = 0;
            }
        }
        state.lastSeq = seqNum;
        state.heard = (state.heard || 0) + 1;
    } else {
        state.backlogCount = (state.backlogCount || 0) + 1;
    }
} else {
    state.heard = (state.heard || 0) + 1;
}
const expectedPkts = (state.heard || 0) + (state.missed || 0);
state.pdr = expectedPkts > 0 ? Number(((state.heard / expectedPkts) * 100).toFixed(1)) : 100.0;

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
            seq: seqNum,
            hops: hops,
            rssi: state.rssi,
            snr: state.snr,
            pdr: state.pdr,
            packetsHeard: state.heard,
            packetsMissed: state.missed,
            backlogReplayed: state.backlogCount,
            packetType: isBacklog ? "BACKLOG" : "LIVE",
            lat: o.lat,
            lon: o.lon,
            status: sos ? "SOS" : "Normal",
            sos: sos,
            speed: o.knots === null ? "--" : Number(o.knots.toFixed(1)),
            heading: o.heading,
            battery: battery,
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
    posSource = sos ? "SOS Pinned (GPS Fix)" : "GPS fix";
} else if (state.pts.length) {
    [lat, lon] = state.pts[state.pts.length - 1];
    posSource = sos ? "SOS LKL PINNED" : "Last known";
    if (state.t) { fixAgeMin = Math.max(1, Math.round((now - state.t) / 60000)); }
} else if (NO_FIX_FALLBACK === "home") {
    [lat, lon] = HOME_POS;
    posSource = "No fix - base station";
} else if (NO_FIX_FALLBACK === "null") {
    lat = 0; lon = 0;
    posSource = "No fix - 0,0";
} else {
    state.mapped = false;
    flow.set(KEY, state);
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

state.mapped = true;
flow.set(KEY, state);

const heading = Math.round(state.brg);
const knots = noFix ? 0 : state.kts;
const underway = knots > 0.3;

// ── The boat SVG ─────────────────────────────────────────────
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

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${ICON_PX}" height="${ICON_PX}" style="display:block">
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
    ${row("Signal", state.rssi === "--" ? "&mdash;" : `${state.rssi} dBm (${state.snr} dB)`)}
    ${row("Sequence", seqNum === null ? "&mdash;" : `#${seqNum}`)}
    ${row("Source", isBacklog ? "Backlog" : "Live")}
    ${row("Updated", stamp)}
  </table>
</div>`;

// ── Messages out ─────────────────────────────────────────────
const out = [];
const pts = state.pts;

// If transitioning between Vessels and Distress layers on worldmap, delete old layer marker
if (wasSos && !sos) {
    out.push({ payload: { name: vesselId, layer: "Distress", deleted: true } });
} else if (!wasSos && sos && wasMapped) {
    out.push({ payload: { name: vesselId, layer: "Vessels", deleted: true } });
}

if (pts.length > 1) {
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