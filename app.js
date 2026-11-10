/* ═══════════════════════════════════════════════════════════
   Lantaw-Dagat — shoreline monitoring station (browser side)
   Upgraded with Live PDR, RF Signal (RSSI/SNR), and Mesh Hop Metrics
   ═══════════════════════════════════════════════════════════ */

(function () {
"use strict";

// ── Tuning (keep in step with Function 1) ───────────────────
const TRAIL_POINTS  = 60;     // breadcrumb points kept per vessel
const COMET_POINTS  = 10;     // how many get the bright "recent" line
const MIN_MOVE_M    = 8;      // ignore GPS jitter smaller than this (m)
const ICON_PX       = 46;     // on-screen icon size
const TTL_SEC       = 900;    // marker drops after this long with no update
const TTL_SOS_SEC   = 3600;   // SOS markers linger much longer
const STALE_SEC     = 120;    // dim the row after this long with no update
const SHOW_LABEL    = false;  // true = name always on, false = on hover

const NO_FIX_FALLBACK = "home";            // "home" | "null" | "drop"
const HOME_POS        = [10.3157, 123.8854]; // Cebu City — change to your base
const MAP_NOFIX_NORMAL = false;            // map no-fix packets that aren't SOS

const WS_URL       = "ws://localhost:1880/ws/telemetry";
const WS_RETRY_MS  = 4000;

const RTP_COMMAND = "RTP";
const RTP_REPEATS = 3;
const RTP_GAP_MS  = 1200;

// ── Map ─────────────────────────────────────────────────────
const map = L.map('map-container').setView([10.34, 123.92], 12); 

L.tileLayer('./tiles-wiki/{z}/{x}/{y}.png', {
    minZoom: 11,
    maxZoom: 17,
    attribution: 'Offline Map &copy; Wikimedia & OpenStreetMap contributors'
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

    const now = Date.now();
    const state = fleet[id] || (fleet[id] = {
        pts: [], t: 0, brg: 0, kts: 0,
        heard: 0, missed: 0, lastSeq: null, backlogCount: 0
    });

    // ── PDR & Sequence Gap Tracking (Browser Fallback + Node-RED Sync) ──
    const pktType = data.packetType || (data.source === "Backlog" ? "BACKLOG" : "LIVE");
    const seqNum = (data.seq !== undefined && data.seq !== null && isFinite(Number(data.seq)))
                   ? Number(data.seq) : null;

    if (data.pdr !== undefined && isFinite(Number(data.pdr))) {
        // Use exact numbers from Node-RED parser if available
        state.pdr          = Number(data.pdr);
        state.packetLoss   = Number(data.packetLoss ?? (100 - state.pdr));
        state.heard        = Number(data.packetsHeard ?? state.heard + 1);
        state.missed       = Number(data.packetsMissed ?? state.missed);
        state.backlogCount = Number(data.backlogReplayed ?? state.backlogCount);
        if (seqNum !== null) { state.lastSeq = seqNum; }
    } else if (seqNum !== null) {
        // Compute PDR directly in browser if raw CSV or demo is used
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

    // ── Speed & Bearing from GPS Trail ──────────────────────
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

    // ── Where do we actually draw it? ───────────────────────
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
    state.stamp      = data.timestamp || nowStamp();
    state.lastSeen   = now;
    if (!noFix && data.heading !== undefined && isFinite(Number(data.heading)) && Number(data.heading) !== 0) {
        state.brg = Number(data.heading);
    }
    if (!noFix && data.speed !== undefined && isFinite(Number(data.speed)) && Number(data.speed) !== 0) {
        state.kts = Number(data.speed);
    }

    // Auto-select the first vessel that appears so the bottom diagnostics panel is immediately live
    if (!selectedId) {
        selectedId = id;
    }

    draw(id, state);
    renderFleet();
    if (selectedId === id) { renderDiagnostics(id); }
    if (sos) { raiseSos(id); }
}

// ── The boat SVG ────────────────────────────────────────────
function pumpboatIcon(deg, distress, moving, nofix) {
    const hull    = distress ? "#7f1d1d" : "#12435f";
    const deck    = distress ? "#fde7e7" : "#e6f4f7";
    const canopy  = distress ? "#e63946" : "#3f92c4";
    const katig   = distress ? "#e0a458" : "#c9a227";
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

// ── Popup card ──────────────────────────────────────────────
function nowStamp() {
    return new Date().toLocaleTimeString("en-PH", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: true, timeZone: "Asia/Manila"
    });
}

function buildPopup(id, st) {
    const sos = st.sos, noFix = st.noFix;
    const heading = Math.round(st.brg);
    const knots = noFix ? 0 : st.kts;

    const chipBg = sos ? "#fee2e2" : "#dcfce7";
    const chipFg = sos ? "#991b1b" : "#166534";
    const row = (k, v) =>
        `<tr><td style="color:#64748b;padding:2px 12px 2px 0;white-space:nowrap">${k}</td>` +
        `<td style="color:#0f172a;font-variant-numeric:tabular-nums"><b>${v}</b></td></tr>`;

    const fixBanner = noFix ? `
  <div style="margin:8px 0 2px;padding:6px 9px;border-radius:6px;background:#fef3c7;
              border:1px solid #fcd34d;color:#78350f;font-size:11.5px;line-height:1.35">
    <b>NO GPS FIX</b><br>
    ${st.pts.length
        ? "Pin shows the last confirmed position" +
          (st.fixAgeMin !== null && st.fixAgeMin !== undefined ? ` (${st.fixAgeMin} min ago).` : ".")
        : "No position ever received from this unit."}
  </div>` : "";

    const posText = noFix
        ? (st.pts.length
            ? `${st.lat.toFixed(5)}, ${st.lon.toFixed(5)} <span style="color:#b45309">(stale)</span>`
            : `<span style="color:#b45309">unknown</span>`)
        : `${st.lat.toFixed(5)}, ${st.lon.toFixed(5)}`;

    const pdrText = st.pdr !== undefined ? `${st.pdr.toFixed(1)}% (${st.heard} ok / ${st.missed} lost)` : "--";
    const rfText  = st.rssi !== "--" ? `${st.rssi} dBm / ${st.snr} dB` : "--";

    return `<div style="font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-width:210px">
  <div style="display:flex;align-items:center;gap:8px;padding-bottom:7px;border-bottom:1px solid #e2e8f0">
    <span style="font-size:17px">${sos ? "🆘" : "⛵"}</span>
    <b style="font-size:14px;letter-spacing:.4px;color:#0f172a">${escapeHtml(id)}</b>
  </div>
  <div style="margin:8px 0 6px;display:inline-block;padding:3px 10px;border-radius:999px;
              background:${chipBg};color:${chipFg};font-size:11px;font-weight:700;letter-spacing:.6px">
    ${sos ? (noFix ? "SOS - NO FIX" : "SOS ACTIVE") : "NORMAL"}
  </div>
  ${fixBanner}
  <table style="border-collapse:collapse;font-size:12px;margin-top:6px">
    ${row("PDR", pdrText)}
    ${row("Signal", rfText)}
    ${row("Route", st.route || `${st.hops ?? 0} hops`)}
    ${row("Seq #", st.seq !== null && st.seq !== undefined ? `#${st.seq} (${st.source})` : st.source)}
    ${row("Position", posText)}
    ${row("Heading / Spd", noFix ? "&mdash;" : `${heading}&deg; &middot; ${knots.toFixed(1)} kn`)}
    ${row("Updated", st.stamp)}
  </table>
</div>`;
}

// ── Draw: marker + full track + comet wake ──────────────────
function draw(id, st) {
    const heading   = Math.round(st.brg);
    const underway  = !st.noFix && st.kts > 0.3;
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
            .bindPopup("", { className: "vesselPopup", maxWidth: 320 })
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

    const labelText = id + (st.noFix ? " (no fix)" : "");
    if (SHOW_LABEL) {
        st.marker.bindTooltip(labelText, { permanent: true, direction: "top", offset: [0, -18] });
    } else if (!st.tooltipBound) {
        st.marker.bindTooltip(labelText, { direction: "top", offset: [0, -18] });
        st.tooltipBound = true;
    } else {
        st.marker.setTooltipContent(labelText);
    }

    if (st.pts.length > 1) {
        const trackStyle = { color: st.sos ? "#fca5a5" : "#7dd3fc", weight: 2, opacity: 0.45,
                             dashArray: "1 7", interactive: false };
        if (!st.track) {
            st.track = L.polyline(st.pts, trackStyle);
            layers.Tracks.addLayer(st.track);
        } else {
            st.track.setLatLngs(st.pts).setStyle(trackStyle);
        }

        const wakeStyle = { color: st.sos ? "#ef4444" : "#22d3ee", weight: 4, opacity: 0.95,
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
        if (now - (st.lastSeen || 0) > ttl) { removeVessel(id); changed = true; }
    });
    renderFleet();
    if (selectedId) { renderDiagnostics(selectedId); }
    if (changed) { toast("Dropped a vessel that stopped reporting", "warn"); }
}, 5000);

// ── Fleet list ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function renderFleet() {
    const ids = Object.keys(fleet).sort((a, b) => {
        const A = fleet[a], B = fleet[b];
        if (A.sos !== B.sos) { return A.sos ? -1 : 1; }
        if (A.noFix !== B.noFix) { return A.noFix ? -1 : 1; }
        return a.localeCompare(b);
    });

    const now = Date.now();
    let sos = 0, nofix = 0, underway = 0;

    const list = $("vessel-list");
    if (!ids.length) {
        list.innerHTML = '<p class="empty-state">No telemetry yet. Connect the shoreline gateway, ' +
                         'or start the demo feed to see how the station behaves.</p>';
    } else {
        list.innerHTML = ids.map((id) => {
            const st = fleet[id];
            if (st.sos) { sos++; }
            if (st.noFix) { nofix++; }
            const moving = !st.noFix && st.kts > 0.3;
            if (moving) { underway++; }

            const stale = now - (st.lastSeen || 0) > STALE_SEC * 1000;
            const cls = ["vessel-item"];
            if (st.sos) { cls.push("sos"); }
            if (st.noFix) { cls.push("nofix"); }
            if (stale) { cls.push("stale"); }
            if (selectedId === id) { cls.push("selected"); }

            const tag = st.sos ? '<span class="status-tag status-sos">SOS</span>'
                      : st.noFix ? '<span class="status-tag status-nofix">No fix</span>'
                      : '<span class="status-tag status-normal">Normal</span>';

            const pdrBadge = st.pdr !== undefined ? `PDR ${st.pdr.toFixed(0)}%` : "";
            const hopBadge = `${st.hops ?? 0}H`;
            const stat = st.noFix
                ? (st.posSource || "position unknown")
                : `${pdrBadge} &middot; ${hopBadge} &middot; ${st.kts.toFixed(1)} kn`;

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
    map.panTo([st.lat, st.lon], { animate: true });
    if (st.marker) { st.marker.openPopup(); }
}

function clearDiagnostics() {
    $("diag-vessel").textContent = "No vessel selected";
    $("diag-fix").textContent = "Pick a boat from the fleet list or tap a marker";
    $("diag-fix").className = "diag-sub";
    ["diag-pdr", "diag-rssi", "diag-hops", "diag-seq", "diag-speed", "diag-heading", "diag-pos", "diag-time"]
        .forEach((k) => { if ($(k)) $(k).textContent = "--"; });
    if ($("diag-pkt-counts")) $("diag-pkt-counts").textContent = "0 heard \u00B7 0 missed";
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

    const ageS = Math.round((Date.now() - (st.lastSeen || 0)) / 1000);
    const stale = ageS > STALE_SEC;

    $("diag-vessel").textContent = id;
    const sub = $("diag-fix");
    if (st.sos) {
        sub.textContent = st.noFix ? "Distress — position not confirmed" : "Distress — position confirmed";
        sub.className = "diag-sub sos";
    } else if (st.noFix) {
        sub.textContent = "No GPS fix — showing " + (st.posSource || "fallback position").toLowerCase();
        sub.className = "diag-sub warn";
    } else {
        sub.textContent = st.source === "Backlog" ? "Store-and-forward backlog replayed" : "Live LoRa telemetry";
        sub.className = "diag-sub";
    }

    // 1. PDR & Packet Counts
    if ($("diag-pdr")) {
        $("diag-pdr").textContent = st.pdr !== undefined ? `${st.pdr.toFixed(1)}%` : "100.0%";
    }
    if ($("diag-pkt-counts")) {
        const blTxt = st.backlogCount > 0 ? ` \u00B7 ${st.backlogCount} BL` : "";
        $("diag-pkt-counts").textContent = `${st.heard ?? 1} ok \u00B7 ${st.missed ?? 0} lost${blTxt}`;
    }

    // 2. RF Signal (RSSI & SNR)
    if ($("diag-rssi")) {
        $("diag-rssi").textContent = st.rssi !== undefined && st.rssi !== "--" ? `${st.rssi} dBm` : "--";
    }
    if ($("diag-snr")) {
        $("diag-snr").textContent = st.snr !== undefined && st.snr !== "--" ? `SNR: ${st.snr} dB` : "SNR: -- dB";
    }

    // 3. Mesh Hops & Route
    if ($("diag-hops")) {
        $("diag-hops").textContent = st.hops !== undefined ? `${st.hops}` : "0";
    }
    if ($("diag-route")) {
        $("diag-route").textContent = st.hops === 0 ? "Direct to Gateway" : `Relayed (${st.hops} ${st.hops === 1 ? "hop" : "hops"})`;
    }

    // 4. Sequence Number & Packet Type
    if ($("diag-seq")) {
        $("diag-seq").textContent = st.seq !== null && st.seq !== undefined ? `#${st.seq}` : "--";
    }
    if ($("diag-pkt-type")) {
        $("diag-pkt-type").textContent = st.packetType === "BACKLOG" ? "Backlog ('B' pkt)" : "Live ('P' pkt)";
    }

    // 5. Speed, Heading, Position, Time
    $("diag-speed").textContent   = st.noFix ? "--" : st.kts.toFixed(1);
    $("diag-heading").textContent = st.noFix ? "--" : Math.round(st.brg) + "\u00B0";
    $("diag-pos").textContent     = (st.noFix && !st.pts.length)
        ? "unknown"
        : st.lat.toFixed(5) + ", " + st.lon.toFixed(5);
    $("diag-source").textContent  = st.posSource || "--";
    $("diag-time").textContent    = st.stamp || "--";
    $("diag-age").textContent     = ageS < 60 ? ageS + " s ago" : Math.round(ageS / 60) + " min ago";

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
    $("sos-banner-text").textContent = id + (st.noFix
        ? " is calling for help — no GPS fix, position is an estimate"
        : " is calling for help");
    if (!st.alerted) {
        st.alerted = true;
        toast("Distress signal from " + id, "bad");
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
    setLink("down", "Connecting");
    try {
        ws = new WebSocket(WS_URL);
    } catch (err) {
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        setLink("up", "Gateway live");
        $("rtp-btn").disabled = false;
        if (demoTimer) { stopDemo(); }
        toast("Shoreline gateway connected", "good");
    };
    ws.onmessage = (event) => handleMessage(event.data);
    ws.onerror = () => { /* onclose does the retry */ };
    ws.onclose = () => {
        $("rtp-btn").disabled = !demoTimer;
        setLink("down", "Gateway offline");
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
    if (demoTimer && (!ws || ws.readyState !== WebSocket.OPEN)) {
        toast("Demo feed — nothing was transmitted", "warn");
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
            toast("Link dropped after " + sent + " of " + RTP_REPEATS + " — repeat when it returns", "bad");
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

// ── Demo feed (simulates realistic Seq, Hops, RSSI & SNR) ───
let demoTimer = null;
let demoTick = 0;

const demoBoats = [
    { id: "VESSEL1", lat: 10.345, lon: 123.925, brg:  75, kts: 5.2, seq: 100, hops: 0, rssi: -68, snr:  9.5 },
    { id: "VESSEL2", lat: 10.332, lon: 123.940, brg: 200, kts: 3.8, seq: 200, hops: 1, rssi: -89, snr:  4.2 },
    { id: "VESSEL3", lat: 10.355, lon: 123.955, brg: 310, kts: 6.4, seq: 300, hops: 2, rssi: -104, snr: -2.5 }
];

function stepDemo() {
    demoTick++;
    demoBoats.forEach((b, i) => {
        b.brg = (b.brg + (Math.random() * 8 - 4) + 360) % 360;
        const dM = b.kts * 0.5144 * 2.2 * 5;
        b.lat += (dM * Math.cos(rad(b.brg))) / 111320;
        b.lon += (dM * Math.sin(rad(b.brg))) / (111320 * Math.cos(rad(b.lat)));

        // Simulate occasional packet loss on VESSEL3 (2 hops out) so PDR updates realistically
        const dropped = (i === 2 && demoTick % 5 === 0);
        b.seq += dropped ? 2 : 1;

        const lostFix = (i === 1 && demoTick > 18);
        const sos     = (i === 2 && demoTick > 10) || (i === 1 && demoTick > 22);

        ingest({
            id: b.id,
            seq: b.seq,
            hops: b.hops,
            rssi: b.rssi + Math.floor(Math.random() * 5 - 2),
            snr: Number((b.snr + (Math.random() * 1.2 - 0.6)).toFixed(1)),
            lat: lostFix ? 0 : b.lat,
            lon: lostFix ? 0 : b.lon,
            status: sos ? "SOS" : "Normal",
            speed: b.kts.toFixed(1),
            heading: Math.round(b.brg),
            timestamp: nowStamp(),
            source: "Live"
        });
    });
}

function startDemo() {
    if (demoTimer) { return; }
    demoTick = 0;
    stepDemo();
    demoTimer = setInterval(stepDemo, 2000);
    $("demo-toggle").textContent = "Stop demo feed";
    $("rtp-btn").disabled = false;
    setLink("demo", "Demo data");
    toast("Demo feed running — simulating PDR, RSSI & mesh hops", "warn");
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
    }
}

$("demo-toggle").addEventListener("click", () => { demoTimer ? stopDemo() : startDemo(); });

$("rtp-btn").disabled = true;
renderFleet();
clearDiagnostics();

})();