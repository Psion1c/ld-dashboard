/* ═══════════════════════════════════════════════════════════
   Lantaw-Dagat — shoreline monitoring station (browser side)
   Isolated 3-State Demo: NORMAL, STALE (>180s), & SOS LKL Pin
   ═══════════════════════════════════════════════════════════ */

(function () {
"use strict";

// ── Tuning ──────────────────────────────────────────────────
const TRAIL_POINTS  = 60;
const COMET_POINTS  = 10;
const MIN_MOVE_M    = 8;
const ICON_PX       = 46;
const TTL_SEC       = 900;
const TTL_SOS_SEC   = 3600;
const STALE_SEC     = 180;    // 180 s timeout threshold
const SHOW_LABEL    = true;

const NO_FIX_FALLBACK  = "home";
const HOME_POS         = [10.3157, 123.8854];
const MAP_NOFIX_NORMAL = false;

const WS_URL      = "ws://localhost:1880/ws/telemetry";
const WS_RETRY_MS = 4000;

const RTP_COMMAND = "RTP";
const RTP_REPEATS = 3;
const RTP_GAP_MS  = 1200;

const staleStyle = document.createElement("style");
staleStyle.textContent = `
  .status-tag.status-stale {
      background: rgba(245, 158, 11, 0.18);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.45);
  }
  .vessel-item.stale {
      opacity: 0.78;
      border-left: 3px solid #f59e0b;
  }
  .diag-sub.warn {
      color: #fbbf24 !important;
      font-weight: 600;
  }
`;
document.head.appendChild(staleStyle);

// ── Map ─────────────────────────────────────────────────────
const map = L.map('map-container').setView([10.305, 123.968], 13);

L.tileLayer('./tiles-wiki/{z}/{x}/{y}.png', {
    minZoom: 11,
    maxNativeZoom: 15,
    maxZoom: 18,
    attribution: 'Offline Map &copy; OpenStreetMap contributors'
}).addTo(map);

const layers = {
    Vessels:  L.layerGroup().addTo(map),
    Distress: L.layerGroup().addTo(map),
    Tracks:   L.layerGroup().addTo(map)
};
L.control.layers(null, layers, { collapsed: true, position: "topright" }).addTo(map);
L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

setTimeout(() => map.invalidateSize(), 200);
window.addEventListener("resize", () => map.invalidateSize());

// ── Geo helpers ─────────────────────────────────────────────
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

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ── Fleet state ─────────────────────────────────────────────
const fleet = Object.create(null);
let selectedId = null;
let demoTimer = null;
let demoTick = 0;

function formatManilaTime(ms) {
    return new Date(ms).toLocaleTimeString("en-PH", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: true, timeZone: "Asia/Manila"
    });
}

function nowStamp() {
    return formatManilaTime(Date.now());
}

// ── Ingest ──────────────────────────────────────────────────
function parseRawPacket(text) {
    let clean = String(text).trim();
    const match = clean.match(/([PB]),.*/);
    if (match) { clean = match[0]; }

    const parts = clean.split(",");
    if (parts.length < 7) { return null; }
    if (parts[0] !== "P" && parts[0] !== "B") { return null; }

    const seqRaw  = parseInt(parts[2], 10);
    const hopsRaw = parseInt(parts[3], 10);
    const latRaw  = parseFloat(parts[4]);
    const lonRaw  = parseFloat(parts[5]);
    if (!isFinite(latRaw) || !isFinite(lonRaw)) { return null; }
    if (Math.abs(latRaw) > 90 || Math.abs(lonRaw) > 180) { return null; }

    return {
        id: parts[1],
        seq: isFinite(seqRaw) ? seqRaw : null,
        hops: isFinite(hopsRaw) ? hopsRaw : 0,
        lat: latRaw,
        lon: lonRaw,
        status: parts[6].trim() === "1" ? "SOS" : "Normal",
        packetType: parts[0] === "B" ? "BACKLOG" : "LIVE",
        source: parts[0] === "B" ? "Backlog" : "Live"
    };
}

function handleMessage(raw) {
    // Ignore background Node-RED WebSocket packets while Demo Feed is running
    if (demoTimer) { return; }

    let data;
    try {
        data = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (err) {
        data = parseRawPacket(raw);
        if (!data) { return; }
    }
    if (data && data.payload) { data = data.payload; }
    if (!data) { return; }
    const shaped = data.id ? data : adaptWorldmap(data);
    if (!shaped) { return; }
    ingest(shaped);
}

function adaptWorldmap(d) {
    if (typeof d.name !== "string") { return null; }
    if (d.line || d.layer === "Tracks") { return null; }
    if (!isFinite(Number(d.lat)) || !isFinite(Number(d.lon))) { return null; }

    const label = String(d.tooltip || d.label || "");
    return {
        id: d.name,
        lat: d.lat,
        lon: d.lon,
        status: d.layer === "Distress" ? "SOS" : "Normal",
        fix: !/no fix/i.test(label),
        timestamp: nowStamp(),
        source: "Live"
    };
}

function ingest(data) {
    const id = String(data.id);
    const latRaw = Number(data.lat);
    const lonRaw = Number(data.lon);
    if (!isFinite(latRaw) || !isFinite(lonRaw)) { return; }
    if (Math.abs(latRaw) > 90 || Math.abs(lonRaw) > 180) { return; }

    const sos = String(data.status).toUpperCase() === "SOS" || data.sos === true;
    const noFix = (data.fix === false) || (data.noFix === true) ||
                  (latRaw === 0 || lonRaw === 0);

    if (noFix && !sos && !MAP_NOFIX_NORMAL) { return; }

    const now = data.customLastSeen || Date.now();
    const state = fleet[id] || (fleet[id] = {
        pts: [], t: 0, brg: 0, kts: 0,
        heard: 0, missed: 0, lastSeq: null, backlogCount: 0
    });

    const pktType = data.packetType || (data.source === "Backlog" ? "BACKLOG" : "LIVE");
    const seqNum = (data.seq !== undefined && data.seq !== null && isFinite(Number(data.seq)))
                   ? Number(data.seq) : null;

    if (data.pdr !== undefined && isFinite(Number(data.pdr))) {
        state.pdr          = Number(data.pdr);
        state.packetLoss   = Number(data.packetLoss ?? (100 - state.pdr));
        state.heard        = Number(data.packetsHeard ?? state.heard + 1);
        state.missed       = Number(data.packetsMissed ?? state.missed);
        state.backlogCount = Number(data.backlogReplayed ?? state.backlogCount);
        if (seqNum !== null) { state.lastSeq = seqNum; }
    } else if (seqNum !== null) {
        if (pktType === "LIVE") {
            if (state.lastSeq !== null) {
                if (seqNum > state.lastSeq) {
                    const gap = seqNum - state.lastSeq - 1;
                    if (gap > 0 && gap < 200) { state.missed += gap; }
                } else if (seqNum < state.lastSeq) {
                    state.heard = 0; state.missed = 0;
                }
            }
            state.lastSeq = seqNum;
            state.heard++;
        } else {
            state.backlogCount++;
        }
        const expected = state.heard + state.missed;
        state.pdr = expected > 0 ? Number(((state.heard / expected) * 100).toFixed(1)) : 100.0;
        state.packetLoss = expected > 0 ? Number(((state.missed / expected) * 100).toFixed(1)) : 0.0;
    } else {
        state.heard++;
        const expected = state.heard + state.missed;
        state.pdr = expected > 0 ? Number(((state.heard / expected) * 100).toFixed(1)) : 100.0;
        state.packetLoss = 0.0;
    }

    state.seq        = seqNum !== null ? seqNum : state.lastSeq;
    state.packetType = pktType;
    state.hops       = (data.hops !== undefined && isFinite(Number(data.hops))) ? Number(data.hops) : (state.hops ?? 0);
    state.route      = data.route || (state.hops === 0 ? "Direct (0 Hops)" : `Mesh Relay (${state.hops} ${state.hops === 1 ? "Hop" : "Hops"})`);
    state.rssi       = (data.rssi !== undefined && data.rssi !== "N/A") ? data.rssi : (state.rssi ?? "--");
    state.snr        = (data.snr  !== undefined && data.snr  !== "N/A") ? data.snr  : (state.snr  ?? "--");

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
        state.sos = sos; state.noFix = true; state.mapped = false;
        state.lastSeen = now;
        toast("SOS from " + escapeHtml(id) + " — no fix, nothing to plot", "bad");
        renderFleet();
        return;
    }

    state.lat        = lat;
    state.lon        = lon;
    state.sos        = sos;
    state.noFix      = noFix;
    state.mapped     = true;
    state.posSource  = data.positionSource || posSource;
    state.fixAgeMin  = (data.fixAgeMin !== undefined && data.fixAgeMin !== null)
                       ? data.fixAgeMin : fixAgeMin;
    state.source     = pktType === "BACKLOG" ? "Backlog" : (data.source || "Live");
    state.stamp      = data.timestamp || formatManilaTime(now);
    state.lastSeen   = now;

    if (data.heading !== undefined && isFinite(Number(data.heading)) && Number(data.heading) !== 0) {
        state.brg = Number(data.heading);
    }
    if (data.speed !== undefined && isFinite(Number(data.speed))) {
        state.kts = Number(data.speed);
    }

    if (!selectedId) {
        selectedId = id;
    }

    draw(id, state);
    renderFleet();
    if (selectedId === id) { renderDiagnostics(id); }
    if (sos) { raiseSos(id); }
}

// ── The boat SVG (2 Hz strobe on SOS) ───────────────────────
function pumpboatIcon(deg, distress, moving, nofix) {
    const hull    = distress ? "#7f1d1d" : "#12435f";
    const deck    = distress ? "#fde7e7" : "#e6f4f7";
    const canopy  = distress ? "#e63946" : "#3f92c4";
    const katig   = distress ? "#e0a458" : "#c9a227";
    const outline = "#08202c";

    const pulse = distress ? `
    <circle cx="32" cy="32" r="13" fill="none" stroke="#ef4444" stroke-width="3">
      <animate attributeName="r" values="12;30;12" dur="0.5s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.95;0.1;0.95" dur="0.5s" repeatCount="indefinite"/>
    </circle>` : "";

    const fixWarn = nofix ? `
    <circle cx="32" cy="32" r="22" fill="none" stroke="#f59e0b" stroke-width="2.2"
            stroke-dasharray="4 4" opacity="0.95"/>
    <g transform="translate(50,13)">
      <circle r="9.5" fill="#7f1d1d" opacity="0.95"/>
      <text x="0" y="4.5" text-anchor="middle" font-family="system-ui,sans-serif"
            font-size="11" font-weight="700" fill="#fef08a">LKL</text>
    </g>` : "";

    const wake = moving ? `
    <g stroke="#ffffff" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.55">
      <path d="M27.5 57 q-2.5 2.5 -3.5 5"/>
      <path d="M36.5 57 q2.5 2.5 3.5 5"/>
    </g>` : "";

    return `<svg xmlns="http://www.w3.org/svg" viewBox="0 0 64 64" width="64" height="64">
  ${pulse}
  <g transform="rotate(${deg} 32 32)" opacity="${nofix ? "0.9" : "1"}">
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

// ── Popup card ──────────────────────────────────────────────
function buildPopup(id, st) {
    const sos = st.sos, noFix = st.noFix;
    const ageS = Math.max(0, Math.round((Date.now() - (st.lastSeen || 0)) / 1000));
    const stale = !sos && ageS >= STALE_SEC;
    const heading = Math.round(st.brg);
    const knots = (noFix || stale) ? 0 : st.kts;

    const chipBg = sos ? "#fee2e2" : stale ? "#fef3c7" : "#dcfce7";
    const chipFg = sos ? "#991b1b" : stale ? "#92400e" : "#166534";
    const chipText = sos
        ? (noFix ? "SOS — LKL PINNED" : "SOS ACTIVE (2 Hz)")
        : stale
        ? `STALE (${ageS}s > ${STALE_SEC}s TIMEOUT)`
        : "NORMAL (ACTIVE)";

    const row = (k, v) =>
        `<tr><td style="color:#64748b;padding:2px 12px 2px 0;white-space:nowrap">${k}</td>` +
        `<td style="color:#0f172a;font-variant-numeric:tabular-nums"><b>${v}</b></td></tr>`;

    const statusBanner = sos ? `
  <div style="margin:8px 0 4px;padding:6px 9px;border-radius:6px;background:#fef2f2;
              border:1px solid #f87171;color:#7f1d1d;font-size:11.5px;line-height:1.35">
    <b>SOS LAST KNOWN LOCATION PINNED</b><br>
    Marker locked at last confirmed coordinate (${st.lat.toFixed(5)}, ${st.lon.toFixed(5)}) with ${st.pts.length}-point historical polyline retained.
  </div>` : stale ? `
  <div style="margin:8px 0 4px;padding:6px 9px;border-radius:6px;background:#fffbeb;
              border:1px solid #fbbf24;color:#78350f;font-size:11.5px;line-height:1.35">
    <b>CONNECTION STALE (&gt;${STALE_SEC} s TIMEOUT)</b><br>
    No telemetry received for <b>${ageS} s</b>. Preserving last known position and ${st.pts.length}-point track history.
  </div>` : "";

    const posText = noFix
        ? `${st.lat.toFixed(5)}, ${st.lon.toFixed(5)} <span style="color:#dc2626">(LKL Pinned)</span>`
        : stale
        ? `${st.lat.toFixed(5)}, ${st.lon.toFixed(5)} <span style="color:#b45309">(Stale)</span>`
        : `${st.lat.toFixed(5)}, ${st.lon.toFixed(5)}`;

    const pdrText = st.pdr !== undefined ? `${st.pdr.toFixed(1)}% (${st.heard} ok / ${st.missed} lost)` : "--";
    const rfText  = st.rssi !== "--" ? `${st.rssi} dBm / ${st.snr} dB` : "--";

    return `<div style="font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-width:240px">
  <div style="display:flex;align-items:center;gap:8px;padding-bottom:7px;border-bottom:1px solid #e2e8f0">
    <span style="font-size:17px">${sos ? "🆘" : stale ? "⚠️" : "⛵"}</span>
    <b style="font-size:14px;letter-spacing:.4px;color:#0f172a">${escapeHtml(id)}</b>
  </div>
  <div style="margin:8px 0 6px;display:inline-block;padding:3px 10px;border-radius:999px;
              background:${chipBg};color:${chipFg};font-size:11px;font-weight:700;letter-spacing:.6px">
    ${chipText}
  </div>
  ${statusBanner}
  <table style="border-collapse:collapse;font-size:12px;margin-top:6px">
    ${row("State", sos ? "SOS (LKL Pinned)" : stale ? "STALE (180s Timeout)" : "NORMAL")}
    ${row("Position", posText)}
    ${row("Track History", `${st.pts.length} waypoints plotted`)}
    ${row("PDR", pdrText)}
    ${row("Signal", rfText)}
    ${row("Route", st.route || `${st.hops ?? 0} hops`)}
    ${row("Heading / Spd", (noFix || stale) ? `${heading}&deg; &middot; 0.0 kn` : `${heading}&deg; &middot; ${knots.toFixed(1)} kn`)}
    ${row("Last Packet", `${st.stamp} (${ageS}s ago)`)}
  </table>
</div>`;
}

// ── Draw: marker + full track + comet wake ──────────────────
function draw(id, st) {
    const heading   = Math.round(st.brg);
    const ageS      = Math.round((Date.now() - (st.lastSeen || 0)) / 1000);
    const stale     = !st.sos && ageS >= STALE_SEC;
    const underway  = !st.noFix && !stale && st.kts > 0.3;
    const targetGrp = st.sos ? layers.Distress : layers.Vessels;

    const icon = L.divIcon({
        html: pumpboatIcon(heading, st.sos, underway, st.noFix),
        className: "bangka-icon",
        iconSize: [ICON_PX, ICON_PX],
        iconAnchor: [ICON_PX / 2, ICON_PX / 2],
        popupAnchor: [0, -ICON_PX / 2]
    });

    if (!st.marker) {
        st.marker = L.marker([st.lat, st.lon], { icon, riseOnHover: true })
            .bindPopup("", { className: "vesselPopup", maxWidth: 340 })
            .on("click", () => select(id));
        targetGrp.addLayer(st.marker);
        st.group = targetGrp;
    } else {
        st.marker.setLatLng([st.lat, st.lon]);
        st.marker.setIcon(icon);
        if (st.group !== targetGrp) {
            st.group.removeLayer(st.marker);
            targetGrp.addLayer(st.marker);
            st.group = targetGrp;
        }
    }

    st.marker.setPopupContent(buildPopup(id, st));

    const stateTag = st.sos ? " [SOS - LKL PINNED]" : stale ? ` [STALE ${ageS}s]` : " [NORMAL]";
    const labelText = id + stateTag;
    if (SHOW_LABEL) {
        if (!st.tooltipBound) {
            st.marker.bindTooltip(labelText, { permanent: true, direction: "top", offset: [0, -18] });
            st.tooltipBound = true;
        } else {
            st.marker.setTooltipContent(labelText);
        }
    }

    if (st.pts.length > 1) {
        const trackColor = st.sos ? "#fca5a5" : stale ? "#fcd34d" : "#7dd3fc";
        const wakeColor  = st.sos ? "#ef4444" : stale ? "#f59e0b" : "#22d3ee";

        const trackStyle = { color: trackColor, weight: 2.5, opacity: 0.7,
                             dashArray: "4 6", interactive: false };
        if (!st.track) {
            st.track = L.polyline(st.pts, trackStyle);
            layers.Tracks.addLayer(st.track);
        } else {
            st.track.setLatLngs(st.pts).setStyle(trackStyle);
        }

        const wakeStyle = { color: wakeColor, weight: 4.5, opacity: 0.95,
                            interactive: false };
        const recent = st.pts.slice(-COMET_POINTS);
        if (!st.wake) {
            st.wake = L.polyline(recent, wakeStyle);
            layers.Tracks.addLayer(st.wake);
        } else {
            st.wake.setLatLngs(recent).setStyle(wakeStyle);
        }
    }
}

function removeVessel(id) {
    const st = fleet[id];
    if (!st) { return; }
    if (st.marker && st.group) { st.group.removeLayer(st.marker); }
    if (st.track) { layers.Tracks.removeLayer(st.track); }
    if (st.wake)  { layers.Tracks.removeLayer(st.wake); }
    delete fleet[id];
    if (selectedId === id) { selectedId = null; clearDiagnostics(); }
}

setInterval(() => {
    const now = Date.now();
    let changed = false;
    Object.keys(fleet).forEach((id) => {
        const st = fleet[id];
        const ttl = (st.sos ? TTL_SOS_SEC : TTL_SEC) * 1000;
        if (now - (st.lastSeen || 0) > ttl) { removeVessel(id); changed = true; return; }
        if (st.marker) {
            st.marker.setPopupContent(buildPopup(id, st));
            const ageS = Math.round((now - (st.lastSeen || 0)) / 1000);
            const stale = !st.sos && ageS >= STALE_SEC;
            const stateTag = st.sos ? " [SOS - LKL PINNED]" : stale ? ` [STALE ${ageS}s]` : " [NORMAL]";
            if (st.tooltipBound) { st.marker.setTooltipContent(id + stateTag); }
        }
    });
    renderFleet();
    if (selectedId) { renderDiagnostics(selectedId); }
    if (changed) { toast("Dropped a vessel that exceeded TTL", "warn"); }
}, 1000);

// ── Fleet list ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function renderFleet() {
    const ids = Object.keys(fleet).sort((a, b) => {
        const A = fleet[a], B = fleet[b];
        if (A.sos !== B.sos) { return A.sos ? -1 : 1; }
        return a.localeCompare(b);
    });

    const now = Date.now();
    let sos = 0, nofix = 0, underway = 0;

    const list = $("vessel-list");
    if (!ids.length) {
        list.innerHTML = '<p class="empty-state">No telemetry yet. Connect the shoreline gateway, ' +
                         'or click "Start demo feed" to simulate NORMAL, STALE (180s), and SOS-pinned states.</p>';
    } else {
        list.innerHTML = ids.map((id) => {
            const st = fleet[id];
            const ageS = Math.max(0, Math.round((now - (st.lastSeen || 0)) / 1000));
            const stale = !st.sos && ageS >= STALE_SEC;

            if (st.sos) { sos++; }
            if (st.noFix || stale) { nofix++; }
            const moving = !st.noFix && !stale && st.kts > 0.3;
            if (moving) { underway++; }

            const cls = ["vessel-item"];
            if (st.sos) { cls.push("sos"); }
            if (st.noFix) { cls.push("nofix"); }
            if (stale) { cls.push("stale"); }
            if (selectedId === id) { cls.push("selected"); }

            const tag = st.sos
                ? '<span class="status-tag status-sos">SOS</span>'
                : stale
                ? '<span class="status-tag status-stale">STALE</span>'
                : st.noFix
                ? '<span class="status-tag status-nofix">No fix</span>'
                : '<span class="status-tag status-normal">NORMAL</span>';

            const stat = st.sos
                ? `LKL Pinned &middot; ${st.pts.length} pts &middot; ${ageS}s ago`
                : stale
                ? `Timeout ${ageS}s (&gt;180s) &middot; ${st.pts.length} pts`
                : `PDR ${st.pdr.toFixed(0)}% &middot; ${st.kts.toFixed(1)} kn &middot; ${ageS}s ago`;

            return `<button type="button" class="${cls.join(" ")}" data-id="${escapeHtml(id)}">
                <span class="vessel-chip">${pumpboatIcon(Math.round(st.brg), st.sos, moving, st.noFix)}</span>
                <span>
                    <span class="vessel-name">${escapeHtml(id)}</span>
                    <span class="vessel-stat">${stat}</span>
                </span>
                ${tag}
            </button>`;
        }).join("");

        list.querySelectorAll(".vessel-item").forEach((el) => {
            el.addEventListener("click", () => select(el.dataset.id));
        });
    }

    $("count-total").textContent = ids.length;
    $("count-underway").textContent = underway;
    $("count-nofix").textContent = nofix;
    $("count-sos").textContent = sos;
    $("fleet-summary").querySelector(".sum-sos").classList.toggle("live", sos > 0);

    if (!sos) { $("sos-banner").hidden = true; sosFocusId = null; }
}

// ── Selection + diagnostics ─────────────────────────────────
function select(id) {
    if (!fleet[id]) { return; }
    selectedId = id;
    renderFleet();
    renderDiagnostics(id);
    const st = fleet[id];
    // Zoom to 14 and offset slightly north so the popup and track polyline are framed dead-center
    map.setView([st.lat + 0.004, st.lon], 14, { animate: true });
    if (st.marker) { st.marker.openPopup(); }
}

function clearDiagnostics() {
    $("diag-vessel").textContent = "No vessel selected";
    $("diag-fix").textContent = "Pick a boat from the fleet list or tap a marker";
    $("diag-fix").className = "diag-sub";
    ["diag-pdr", "diag-rssi", "diag-hops", "diag-seq", "diag-speed", "diag-heading", "diag-pos", "diag-time"]
        .forEach((k) => { if ($(k)) $(k).textContent = "--"; });
    if ($("diag-pkt-counts")) $("diag-pkt-counts").textContent = "0 ok \u00B7 0 lost";
    if ($("diag-snr"))        $("diag-snr").textContent = "SNR: -- dB";
    if ($("diag-route"))      $("diag-route").textContent = "hop count";
    if ($("diag-pkt-type"))   $("diag-pkt-type").textContent = "packet stream";
    $("diag-source").textContent = "no data";
    $("diag-age").textContent = "--";
    document.querySelectorAll(".metric-box").forEach((b) => b.classList.remove("alert", "stale"));
}

function renderDiagnostics(id) {
    const st = fleet[id];
    if (!st) { clearDiagnostics(); return; }

    const ageS = Math.max(0, Math.round((Date.now() - (st.lastSeen || 0)) / 1000));
    const stale = !st.sos && ageS >= STALE_SEC;

    $("diag-vessel").textContent = id;
    const sub = $("diag-fix");
    if (st.sos) {
        sub.textContent = `SOS DISTRESS — Last Known Location pinned (${st.pts.length} track pts preserved)`;
        sub.className = "diag-sub sos";
    } else if (stale) {
        sub.textContent = `STALE STATE — 180 s timeout exceeded (${ageS} s since last packet)`;
        sub.className = "diag-sub warn";
    } else if (st.noFix) {
        sub.textContent = "No GPS fix — showing " + (st.posSource || "fallback position").toLowerCase();
        sub.className = "diag-sub warn";
    } else {
        sub.textContent = `NORMAL STATE — Live LoRa telemetry (${st.pts.length} track pts plotted)`;
        sub.className = "diag-sub";
    }

    if ($("diag-pdr")) {
        $("diag-pdr").textContent = st.pdr !== undefined ? `${st.pdr.toFixed(1)}%` : "100.0%";
    }
    if ($("diag-pkt-counts")) {
        $("diag-pkt-counts").textContent = `${st.heard ?? 1} OK \u00B7 ${st.missed ?? 0} LOST (${st.pts.length} PTS)`;
    }

    if ($("diag-rssi")) {
        $("diag-rssi").textContent = st.rssi !== undefined && st.rssi !== "--" ? `${st.rssi} dBm` : "--";
    }
    if ($("diag-snr")) {
        $("diag-snr").textContent = st.snr !== undefined && st.snr !== "--" ? `SNR: ${st.snr} dB` : "SNR: -- dB";
    }

    if ($("diag-hops")) {
        $("diag-hops").textContent = st.hops !== undefined ? `${st.hops}` : "0";
    }
    if ($("diag-route")) {
        $("diag-route").textContent = st.hops === 0 ? "Direct to Gateway" : `Relayed (${st.hops} ${st.hops === 1 ? "Hop" : "Hops"})`;
    }

    if ($("diag-seq")) {
        $("diag-seq").textContent = st.seq !== null && st.seq !== undefined ? `#${st.seq}` : "--";
    }
    if ($("diag-pkt-type")) {
        $("diag-pkt-type").textContent = st.sos ? "SOS Priority" : stale ? "Stale (>180s)" : "Live ('P' Pkt)";
    }

    $("diag-speed").textContent   = (st.noFix || stale) ? "0.0" : st.kts.toFixed(1);
    $("diag-heading").textContent = Math.round(st.brg) + "\u00B0";
    $("diag-pos").textContent     = st.lat.toFixed(5) + ", " + st.lon.toFixed(5);
    $("diag-source").textContent  = st.sos ? "SOS LKL PINNED" : stale ? "LAST KNOWN (STALE)" : (st.posSource || "GPS FIX");
    $("diag-time").textContent    = st.stamp || "--";
    $("diag-age").textContent     = stale
        ? `${ageS}s AGO (STALE >180s)`
        : st.sos
        ? `${ageS}s AGO (SOS PINNED)`
        : `${ageS}s AGO (NORMAL)`;

    document.querySelectorAll(".metric-box").forEach((b) => {
        b.classList.toggle("alert", !!st.sos);
        b.classList.toggle("stale", !st.sos && (stale || !!st.noFix));
    });
}

// ── Distress banner ─────────────────────────────────────────
let sosFocusId = null;

function raiseSos(id) {
    const st = fleet[id];
    sosFocusId = id;
    $("sos-banner").hidden = false;
    $("sos-banner-text").textContent = `${id} SOS ACTIVE — Last Known Location pinned at ${st.lat.toFixed(5)}, ${st.lon.toFixed(5)} (${st.pts.length}-pt track retained)`;
    if (!st.alerted) {
        st.alerted = true;
        toast("SOS distress from " + id + " — Last Known Location pinned", "bad");
    }
}

$("sos-focus").addEventListener("click", () => { if (sosFocusId) { select(sosFocusId); } });

// ── Link to the gateway ─────────────────────────────────────
let ws = null;
let wsRetry = null;

function setLink(kind, text) {
    const pill = $("link-state");
    pill.className = "link-pill link-" + kind;
    $("link-text").textContent = text;
}

function connect() {
    if (!demoTimer) { setLink("down", "Connecting"); }
    try {
        ws = new WebSocket(WS_URL);
    } catch (err) {
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        if (!demoTimer) {
            setLink("up", "Gateway live");
            $("rtp-btn").disabled = false;
            toast("Shoreline gateway connected", "good");
        }
    };
    ws.onmessage = (event) => handleMessage(event.data);
    ws.onerror = () => {};
    ws.onclose = () => {
        $("rtp-btn").disabled = !demoTimer;
        if (!demoTimer) { setLink("down", "Gateway offline"); }
        scheduleReconnect();
    };
}

function scheduleReconnect() {
    clearTimeout(wsRetry);
    wsRetry = setTimeout(connect, WS_RETRY_MS);
}

connect();

// ── Return-to-port broadcast ────────────────────────────────
$("rtp-btn").addEventListener("click", () => {
    const count = Object.keys(fleet).length;
    openModal({
        title: "Broadcast return-to-port?",
        body: `<p>Every boat on the gateway hears this — ${count} currently tracked. ` +
              `Crews are expected to turn back immediately.</p>` +
              `<p style="color:#7ea6ba;font-size:.8rem">Sent ${RTP_REPEATS} times over LoRa so a lost packet ` +
              `doesn't cost you the whole broadcast.</p>`,
        confirmText: "Broadcast now",
        onConfirm: sendRtp
    });
});

function sendRtp() {
    if (demoTimer) {
        toast("RTP command simulated across demo fleet (3x broadcast)", "good");
        return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        toast("Gateway offline. Command not sent — use the VHF radio.", "bad");
        return;
    }

    const btn = $("rtp-btn");
    const label = btn.querySelector("span");
    let sent = 0;
    btn.disabled = true;

    const fire = () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            toast("Link dropped after " + sent + " of " + RTP_REPEATS, "bad");
            resetRtpButton(btn, label);
            return;
        }
        try {
            ws.send(RTP_COMMAND);
        } catch (err) {
            toast("Send failed: " + err.message, "bad");
            resetRtpButton(btn, label);
            return;
        }
        sent++;
        label.textContent = "Broadcasting " + sent + " of " + RTP_REPEATS;
        if (sent < RTP_REPEATS) {
            setTimeout(fire, RTP_GAP_MS);
        } else {
            toast("Return-to-port sent " + RTP_REPEATS + "\u00D7 — vessels relay it onward", "good");
            setTimeout(() => resetRtpButton(btn, label), 1600);
        }
    };

    fire();
}

function resetRtpButton(btn, label) {
    label.textContent = "Broadcast return-to-port";
    btn.disabled = !(demoTimer || (ws && ws.readyState === WebSocket.OPEN));
}

// ── Advisory board ──────────────────────────────────────────
const advisory = { level: "none", text: "", posted: null };

const ADVISORY_LABELS = {
    none:    "No advisory posted",
    watch:   "Gale watch",
    warning: "Gale warning",
    danger:  "Storm signal — do not sail"
};

function renderAdvisory() {
    const card = $("advisory-card");
    card.className = "advisory advisory-" + advisory.level;
    $("advisory-level").textContent = ADVISORY_LABELS[advisory.level];
    $("advisory-text").textContent = advisory.text ||
        "Radio watch only. Post the latest bulletin here so the whole watch team sees the same information.";
    $("advisory-meta").textContent = advisory.posted ? "Posted " + advisory.posted : "";
}

$("advisory-edit").addEventListener("click", () => {
    openModal({
        title: "Post PAGASA advisory",
        body: `
            <label for="adv-level">Severity</label>
            <select id="adv-level">
                <option value="none">No advisory</option>
                <option value="watch">Gale watch</option>
                <option value="warning">Gale warning</option>
                <option value="danger">Storm signal — do not sail</option>
            </select>
            <label for="adv-text">Bulletin</label>
            <textarea id="adv-text" placeholder="Type or copy the bulletin as read over the radio."></textarea>`,
        confirmText: "Post advisory",
        onOpen: () => {
            $("adv-level").value = advisory.level;
            $("adv-text").value = advisory.text;
        },
        onConfirm: () => {
            advisory.level = $("adv-level").value;
            advisory.text = $("adv-text").value.trim();
            advisory.posted = nowStamp();
            renderAdvisory();
            toast("Advisory posted to the watch board", "good");
        }
    });
});

renderAdvisory();

// ── Modal + toast ───────────────────────────────────────────
let modalConfirm = null;

function openModal({ title, body, confirmText, onConfirm, onOpen }) {
    $("modal-title").textContent = title;
    $("modal-body").innerHTML = body;
    $("modal-confirm").textContent = confirmText || "Confirm";
    modalConfirm = onConfirm;
    $("modal-root").hidden = false;
    if (onOpen) { onOpen(); }
    $("modal-confirm").focus();
}

function closeModal() { $("modal-root").hidden = true; modalConfirm = null; }

$("modal-cancel").addEventListener("click", closeModal);
$("modal-confirm").addEventListener("click", () => {
    const fn = modalConfirm;
    closeModal();
    if (fn) { fn(); }
});
$("modal-root").addEventListener("click", (e) => { if (e.target.id === "modal-root") { closeModal(); } });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); } });

function toast(text, kind) {
    const el = document.createElement("div");
    el.className = "toast " + (kind || "");
    el.textContent = text;
    $("toast-stack").appendChild(el);
    setTimeout(() => el.remove(), 5200);
}

// ── Station clock ───────────────────────────────────────────
setInterval(() => { $("station-clock").textContent = nowStamp(); }, 1000);
$("station-clock").textContent = nowStamp();

// ── 3-State Evidence Demo (All Vessels & Curved Tracks in Open Water) ──
const demoBoats = [
    {
        // VESSEL1 (NORMAL): Sailing south-southwest in South Cebu Harbor
        id: "VESSEL1",
        role: "NORMAL",
        lat: 10.2640, lon: 123.9085, brg: 202, kts: 5.4, seq: 112, hops: 0, rssi: -68, snr: 9.8,
        history: [
            [10.2815, 123.9182], [10.2794, 123.9165], [10.2772, 123.9151],
            [10.2750, 123.9140], [10.2728, 123.9128], [10.2706, 123.9115],
            [10.2684, 123.9104], [10.2662, 123.9094], [10.2640, 123.9085]
        ]
    },
    {
        // VESSEL2 (SOS_PINNED): Curved track in Hilutungan Channel, pinned at Last Known Location
        id: "VESSEL2",
        role: "SOS_PINNED",
        lat: 10.2965, lon: 124.0210, brg: 38, kts: 0.0, seq: 214, hops: 1, rssi: -85, snr: 2.4,
        history: [
            [10.2750, 124.0020], [10.2768, 124.0042], [10.2788, 124.0060],
            [10.2810, 124.0076], [10.2832, 124.0095], [10.2852, 124.0116],
            [10.2874, 124.0135], [10.2895, 124.0152], [10.2915, 124.0168],
            [10.2932, 124.0182], [10.2949, 124.0196], [10.2965, 124.0210]
        ]
    },
    {
        // VESSEL3 (STALE_180S): Curved track in Magellan Bay, silent for >180 s
        id: "VESSEL3",
        role: "STALE_180S",
        lat: 10.3480, lon: 124.0210, brg: 132, kts: 0.0, seq: 308, hops: 2, rssi: -92, snr: -3.8,
        history: [
            [10.3620, 124.0030], [10.3602, 124.0058], [10.3582, 124.0082],
            [10.3564, 124.0108], [10.3545, 124.0135], [10.3524, 124.0160],
            [10.3502, 124.0186], [10.3480, 124.0210]
        ]
    }
];

function seedDemoHistories() {
    // Clear any existing Node-RED vessels so they never contaminate the demo
    Object.keys(fleet).forEach((id) => removeVessel(id));

    const now = Date.now();

    demoBoats.forEach((b) => {
        fleet[b.id] = {
            pts: b.history.map((pt) => [pt[0], pt[1]]),
            t: b.role === "STALE_180S" ? now - 184000 : now - 4000,
            brg: b.brg,
            kts: b.kts,
            heard: b.history.length,
            missed: b.role === "STALE_180S" ? 2 : 0,
            lastSeq: b.seq - 1,
            backlogCount: 0
        };
    });

    // 1. VESSEL1 (NORMAL)
    const b1 = demoBoats[0];
    ingest({
        id: b1.id, seq: b1.seq, hops: b1.hops, rssi: b1.rssi, snr: b1.snr,
        lat: b1.lat, lon: b1.lon, status: "Normal", speed: b1.kts, heading: b1.brg,
        timestamp: formatManilaTime(now), customLastSeen: now, source: "Live"
    });

    // 2. VESSEL2 (SOS LKL Pinned)
    const b2 = demoBoats[1];
    const sosTimeMs = now - 18 * 1000;
    ingest({
        id: b2.id, seq: b2.seq, hops: b2.hops, rssi: b2.rssi, snr: b2.snr,
        lat: 0, lon: 0, status: "SOS", speed: 0.0, heading: b2.brg,
        positionSource: "SOS LKL PINNED",
        timestamp: formatManilaTime(sosTimeMs), customLastSeen: sosTimeMs, source: "Live"
    });

    // 3. VESSEL3 (STALE >180s Timeout)
    const b3 = demoBoats[2];
    const staleTimeMs = now - 184 * 1000;
    ingest({
        id: b3.id, seq: b3.seq, hops: b3.hops, rssi: b3.rssi, snr: b3.snr,
        lat: b3.lat, lon: b3.lon, status: "Normal", speed: 0.0, heading: b3.brg,
        timestamp: formatManilaTime(staleTimeMs), customLastSeen: staleTimeMs, source: "Live"
    });
}

function stepDemo() {
    demoTick++;
    const now = Date.now();

    // Only VESSEL1 moves; VESSEL2 stays pinned at LKL and VESSEL3 stays STALE (>180s)
    const b1 = demoBoats[0];
    b1.brg = 202 + (Math.random() * 4 - 2);
    const dM = b1.kts * 0.5144 * 2.2 * 3;
    b1.lat += (dM * Math.cos(rad(b1.brg))) / 111320;
    b1.lon += (dM * Math.sin(rad(b1.brg))) / (111320 * Math.cos(rad(b1.lat)));
    b1.seq++;

    ingest({
        id: b1.id, seq: b1.seq, hops: b1.hops,
        rssi: b1.rssi + Math.floor(Math.random() * 3 - 1),
        snr: Number((b1.snr + (Math.random() * 0.6 - 0.3)).toFixed(1)),
        lat: b1.lat, lon: b1.lon, status: "Normal",
        speed: b1.kts.toFixed(1), heading: Math.round(b1.brg),
        timestamp: formatManilaTime(now), source: "Live"
    });
}

function startDemo() {
    if (demoTimer) { return; }
    demoTick = 0;
    // Set demoTimer truthy before seeding so WebSocket traffic is immediately blocked
    demoTimer = setInterval(stepDemo, 2000);
    seedDemoHistories();
    $("demo-toggle").textContent = "Stop demo feed";
    $("rtp-btn").disabled = false;
    setLink("demo", "Demo data");
    select("VESSEL1");
    toast("Demo active: Click VESSEL1 (NORMAL), VESSEL2 (SOS Pin), or VESSEL3 (STALE >180s)", "good");
}

function stopDemo() {
    clearInterval(demoTimer);
    demoTimer = null;
    demoBoats.forEach((b) => removeVessel(b.id));
    renderFleet();
    $("demo-toggle").textContent = "Start demo feed";
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        setLink("down", "Gateway offline");
        $("rtp-btn").disabled = true;
    } else {
        setLink("up", "Gateway live");
    }
}

$("demo-toggle").addEventListener("click", () => { demoTimer ? stopDemo() : startDemo(); });

$("rtp-btn").disabled = true;
renderFleet();
clearDiagnostics();

})();