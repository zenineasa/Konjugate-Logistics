/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the toolbox asks OpenStreetMap for, through the Overpass API, and how an Overpass answer is
// read. Each kind of infrastructure is its own query so every answer stays well under the host's
// fetch limit, and each can be cached and refreshed on its own.

export const overpassHost = 'overpass-api.de';

const majorRoads = 'motorway|trunk|primary|motorway_link|trunk_link|primary_link';
// For a city: the streets stores and dark stores are on as well.
const cityRoads = `${majorRoads}|secondary|tertiary|secondary_link|tertiary_link`;
export const roadLevels = ['major', 'city'];

// `bbox` is { south, west, north, east } in degrees. `roadLevel` is 'major' (motorways, trunk and primary roads, for a
// region) or 'city' (secondary and tertiary roads too).
export function overpassQueries(bbox, { roadLevel = 'major' } = {}) {
    const box = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
    const head = '[out:json][timeout:90];';
    return {
        ports: `${head}(nwr["landuse"="port"]${box};nwr["industrial"="port"]${box};nwr["harbour"="yes"]${box};nwr["seamark:type"="harbour"]${box};nwr["leisure"="marina"]${box};nwr["seamark:type"="anchorage"]${box};nwr["seamark:type"="anchor_berth"]${box};);out geom qt;`,
        logistics: `${head}(way["building"="warehouse"]${box};nwr["industrial"~"^(warehouse|logistics|distribution)$"]${box};)->.w;.w out bb qt;(way["landuse"="industrial"]${box};relation["landuse"="industrial"]${box};)->.l;.l out geom qt;`,
        roads: `${head}way["highway"~"^(${roadLevel === 'city' ? cityRoads : majorRoads})$"]${box};out geom qt;`,
        rail: `${head}(way["railway"="rail"]["service"!~"^(siding|spur|yard)$"]${box};)->.r;.r out geom qt;(nwr["railway"="yard"]${box};nwr["landuse"="railway"]${box};nwr["railway"="station"]["usage"="freight"]${box};)->.y;.y out center qt;`,
        places: `${head}node["place"~"^(city|town|suburb|quarter)$"]${box};out qt;`
    };
}

// Kinds whose answers grow with the area (every road, every warehouse) are fetched in tiles no wider than
// this, so no single query is heavy enough for a busy public server to give up on.
export const tiledKinds = ['logistics', 'roads'];
export const maximumTileKilometres = 40;
// City streets are several times denser: smaller tiles, and a smaller area in all.
export const cityTileKilometres = 10;
export const maximumCityKilometres = 40;

export function splitBbox(bbox, maximumKilometres = maximumTileKilometres) {
    const height = (bbox.north - bbox.south) * 111.32;
    const width = (bbox.east - bbox.west) * 111.32 * Math.cos((bbox.south + bbox.north) / 2 * Math.PI / 180);
    const rows = Math.max(1, Math.ceil(height / maximumKilometres));
    const columns = Math.max(1, Math.ceil(width / maximumKilometres));
    const tiles = [];
    for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
            tiles.push({
                south: bbox.south + (bbox.north - bbox.south) * row / rows, north: bbox.south + (bbox.north - bbox.south) * (row + 1) / rows,
                west: bbox.west + (bbox.east - bbox.west) * column / columns, east: bbox.west + (bbox.east - bbox.west) * (column + 1) / columns
            });
        }
    }
    return tiles;
}

// Every request a region needs: { kind, part, parts, depth, bbox, roadLevel, query }, one per kind, or one per tile for
// the tiled kinds. `kinds` limits them (the roads and place names alone, say); all five by default.
export function overpassRequests(bbox, { kinds = null, roadLevel = 'major' } = {}) {
    const requests = [];
    for (const kind of Object.keys(overpassQueries(bbox))) {
        if (kinds && !kinds.includes(kind)) continue;
        const size = kind === 'roads' && roadLevel === 'city' ? cityTileKilometres : maximumTileKilometres;
        const tiles = tiledKinds.includes(kind) ? splitBbox(bbox, size) : [bbox];
        tiles.forEach((tile, index) => requests.push({ kind, part: `${index + 1}`, parts: tiles.length, depth: 0, bbox: tile, roadLevel, query: overpassQueries(tile, { roadLevel })[kind] }));
    }
    return requests;
}

// A tile whose answer is too large for the host to accept (a dense city centre's roads, say) is fetched again
// as four quarters, at most this many times over.
export const maximumSplitDepth = 2;

export function splitRequest(request) {
    const { south, west, north, east } = request.bbox;
    const middleLat = (south + north) / 2;
    const middleLon = (west + east) / 2;
    return [
        { south, west, north: middleLat, east: middleLon }, { south, west: middleLon, north: middleLat, east },
        { south: middleLat, west, north, east: middleLon }, { south: middleLat, west: middleLon, north, east }
    ].map((tile, index) => ({ ...request, part: `${request.part}.${index + 1}`, depth: request.depth + 1, bbox: tile, query: overpassQueries(tile, { roadLevel: request.roadLevel })[request.kind] }));
}

// A public server that is busy answers 429 (too many requests) or 502 to 504 (gave up waiting): worth another try later.
// When it is overloaded for a while (a 504 saying "Dispatcher_Client"), only patience helps: the pauses
// grow to five minutes, about eleven minutes in all before giving up on one request.
export const retryableStatus = (status) => status === 429 || (status >= 502 && status <= 504);
export const retryDelaysSeconds = [15, 45, 90, 180, 300];
// The longest wait taken on the server's word (its status page), so a garbled time cannot stall a fetch.
export const maximumStatusWaitSeconds = 300;

export function overpassStatusUrl(host = overpassHost) {
    return `https://${host}/api/status`;
}

// Reads the server's status page: how long until this client may run a query. 0 when a slot is free now,
// the soonest "in N seconds" when all are taken, and null when the page says neither (it may be down).
//   "2 slots available now."  |  "Slot available after: 2026-10-01T10:00:12Z, in 12 seconds."
export function statusWaitSeconds(text) {
    const free = /^(\d+) slots? available now\./m.exec(text ?? '');
    if (free && Number(free[1]) > 0) return 0;
    const waits = [...(text ?? '').matchAll(/Slot available after: \S+, in (-?\d+) seconds?\./g)].map((match) => Math.max(0, Number(match[1])));
    if (waits.length) return Math.min(maximumStatusWaitSeconds, Math.min(...waits));
    return null;
}

// The pause before retry number `attempt` (from 0): the planned delay, or longer if the server asks.
export function retryPauseSeconds(attempt, statusWait) {
    return Math.max(retryDelaysSeconds[attempt], Math.min(maximumStatusWaitSeconds, statusWait ?? 0));
}

export function overpassUrl(query, host = overpassHost) {
    return `https://${host}/api/interpreter?data=${encodeURIComponent(query)}`;
}

const pointOfGeometry = (geometry) => {
    let lat = 0;
    let lon = 0;
    for (const point of geometry) { lat += point.lat; lon += point.lon; }
    return { lat: lat / geometry.length, lon: lon / geometry.length };
};

const isClosed = (geometry) => geometry.length > 3
    && geometry[0].lat === geometry[geometry.length - 1].lat && geometry[0].lon === geometry[geometry.length - 1].lon;

// Reads an Overpass JSON answer (text or parsed), or a list of them, into features:
//   { osmType, osmId, tags, point, ring (closed outline or null), rings (a relation's outlines),
//     line (open geometry or null), nodes (a way's node ids), bounds }
// A feature's point is its centre: a node's position, an outline's average, or its bounds' centre.
// Several answers (the tiles of one kind) are read together, each element once: a road crossing a tile edge is in both.
export function readOverpass(answer) {
    if (Array.isArray(answer)) {
        const seen = new Set();
        return answer.flatMap((part) => readOverpass(part)).filter((feature) => {
            const key = `${feature.osmType}/${feature.osmId}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
    const parsed = typeof answer === 'string' ? JSON.parse(answer) : answer;
    if (!Array.isArray(parsed?.elements)) throw new Error('This is not an Overpass answer: it has no elements.');
    // Overpass reports a timeout or memory limit in a remark, with whatever it managed to collect: incomplete, so refused.
    if (typeof parsed.remark === 'string' && /error|timed out|out of memory/i.test(parsed.remark)) {
        throw new Error(`OpenStreetMap's server stopped before it finished (${parsed.remark.replace(/\s+/g, ' ').trim().slice(0, 160)}). Choose a smaller area and fetch again.`);
    }
    const features = [];
    for (const element of parsed.elements) {
        const feature = { osmType: element.type, osmId: element.id, tags: element.tags ?? {}, point: null, ring: null, rings: null, line: null, nodes: element.nodes ?? null, bounds: element.bounds ?? null };
        if (element.type === 'node') {
            feature.point = { lat: element.lat, lon: element.lon };
        } else if (element.type === 'way' && Array.isArray(element.geometry) && element.geometry.length) {
            const geometry = element.geometry.filter((point) => point && Number.isFinite(point.lat));
            if (isClosed(geometry)) feature.ring = geometry;
            else feature.line = geometry;
            feature.point = pointOfGeometry(geometry);
        } else if (element.type === 'relation' && Array.isArray(element.members)) {
            const rings = element.members
                .filter((member) => member.role !== 'inner' && Array.isArray(member.geometry) && isClosed(member.geometry))
                .map((member) => member.geometry);
            if (rings.length) feature.rings = rings;
        }
        if (!feature.point && element.center) feature.point = { lat: element.center.lat, lon: element.center.lon };
        if (!feature.point && element.bounds) feature.point = { lat: (element.bounds.minlat + element.bounds.maxlat) / 2, lon: (element.bounds.minlon + element.bounds.maxlon) / 2 };
        if (!feature.point && feature.rings) feature.point = pointOfGeometry(feature.rings.flat());
        if (feature.point) features.push(feature);
    }
    return features;
}
