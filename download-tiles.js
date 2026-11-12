const fs = require('fs');
const path = require('path');
const https = require('https');

// Covers Metro Cebu, Mactan Channel, Olango Island, and Camotes Sea
const MIN_LAT = 10.18;
const MAX_LAT = 10.50;
const MIN_LON = 123.70;
const MAX_LON = 124.12;

const MIN_ZOOM = 11;
const MAX_ZOOM = 15;
const OUT_DIR  = path.join(__dirname, 'tiles-wiki');

// Keep-alive agent prevents socket exhaustion and speeds up sequential downloads
const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });

function lon2tile(lon, zoom) {
    return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
}

function lat2tile(lat, zoom) {
    return Math.floor(
        ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
        Math.pow(2, zoom)
    );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Unthrottled, key-free OSM & Street Map mirrors (note: Esri uses z/y/x order)
function getMirrorUrls(z, x, y) {
    const sub = ['a', 'b', 'c'][(x + y) % 3];
    return [
        `https://${sub}.tile.openstreetmap.fr/hot/${z}/${x}/${y}.png`,
        `https://${sub}.tile.openstreetmap.fr/osmfr/${z}/${x}/${y}.png`,
        `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`
    ];
}

function fetchBuffer(url) {
    return new Promise((resolve) => {
        const req = https.get(
            url,
            {
                agent,
                timeout: 8000,
                headers: {
                    'User-Agent': 'LantawDagatStation/1.0 ( Maritime Research Project )',
                    'Accept': 'image/png,image/*;q=0.9,*/*;q=0.5'
                }
            },
            (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return resolve(null);
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
    });
}

async function downloadTile(z, x, y) {
    const dir = path.join(OUT_DIR, String(z), String(x));
    const file = path.join(dir, `${y}.png`);

    if (fs.existsSync(file)) {
        const size = fs.statSync(file).size;
        // Valid PNG check (rejects 10912-byte OSM 403 image & <4.8KB Carto watermarks)
        if (size > 800 && size !== 10912) {
            return 'skipped';
        }
        fs.unlinkSync(file);
    }

    fs.mkdirSync(dir, { recursive: true });

    const urls = getMirrorUrls(z, x, y);
    for (const url of urls) {
        const buf = await fetchBuffer(url);
        // Verify PNG magic bytes (89 50 4E 47) or JPEG magic bytes (FF D8) and ensure it's not the 10912-byte block image
        if (buf && buf.length > 800 && buf.length !== 10912) {
            fs.writeFileSync(file, buf);
            return 'downloaded';
        }
        await sleep(80);
    }

    return 'failed';
}

async function run() {
    const queue = [];
    for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
        const xMin = lon2tile(MIN_LON, z);
        const xMax = lon2tile(MAX_LON, z);
        const yMin = lat2tile(MAX_LAT, z);
        const yMax = lat2tile(MIN_LAT, z);

        for (let x = xMin; x <= xMax; x++) {
            for (let y = yMin; y <= yMax; y++) {
                queue.push({ z, x, y });
            }
        }
    }

    console.log(`Downloading ${queue.length} tiles into ${OUT_DIR}...`);
    const CONCURRENCY = 4;
    let saved = 0, skipped = 0, failed = 0;

    for (let i = 0; i < queue.length; i += CONCURRENCY) {
        const batch = queue.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map((t) => downloadTile(t.z, t.x, t.y)));

        for (const r of results) {
            if (r === 'downloaded') saved++;
            else if (r === 'skipped') skipped++;
            else failed++;
        }

        process.stdout.write(
            `\rSaved: ${saved} | Skipped: ${skipped} | Failed: ${failed} / ${queue.length}`
        );
    }
    console.log('\nFinished! Hard-refresh your browser (Ctrl + Shift + R).');
}

run();