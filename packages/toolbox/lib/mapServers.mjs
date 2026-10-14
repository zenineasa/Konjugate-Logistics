/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Where map files (OpenStreetMap extracts, .osm.pbf) can be downloaded from, and which of a server's extracts cover an
// area. Geofabrik publishes an index of its extracts with each one's outline (download.geofabrik.de/index-v1.json), so
// the extracts covering a place can be found and offered: Lugano, on a border, is covered by Switzerland and by
// north-west Italy. Other servers are offered as a link the user pastes, from a host the add-on may reach. Whatever is
// downloaded is kept with the server and the address it came from.

export const mapServers = [
    {
        id: 'geofabrik', name: 'Geofabrik', host: 'download.geofabrik.de', site: 'https://download.geofabrik.de/',
        indexUrl: 'https://download.geofabrik.de/index-v1.json',
        detail: 'Extracts by continent, country and region, refreshed daily: the ones covering the place are found for you.'
    },
    {
        id: 'openstreetmap.fr', name: 'OpenStreetMap France', host: 'download.openstreetmap.fr', site: 'https://download.openstreetmap.fr/extracts/',
        detail: 'Extracts by country and region, for some countries finer than Geofabrik\'s: paste the link to a .osm.pbf file.'
    },
    {
        id: 'bbbike', name: 'BBBike', host: 'download.bbbike.org', site: 'https://download.bbbike.org/osm/bbbike/',
        detail: 'Extracts of some two hundred cities and their surroundings: paste the link to a .osm.pbf file.'
    }
];
export const mapHosts = mapServers.map((server) => server.host);
// The MD5 sum a server publishes beside a file, where it does: Geofabrik and OpenStreetMap France do.
export const checksumUrlOf = (url) => (/^https:\/\/(download\.geofabrik\.de|download\.openstreetmap\.fr)\//.test(url) ? `${url}.md5` : null);

// A link the user pasted, checked: https, on a server listed, to a .osm.pbf file. Returns { url, server } or throws a
// message saying what is wrong.
export function checkedMapLink(text) {
    let address;
    try { address = new URL(String(text ?? '').trim()); } catch { throw new Error('That is not a web address: paste the link to a .osm.pbf file.'); }
    if (address.protocol !== 'https:') throw new Error('Only https links can be downloaded.');
    const server = mapServers.find((item) => item.host === address.hostname.toLowerCase());
    if (!server) throw new Error(`Maps are downloaded from ${mapServers.map((item) => item.name).join(', ').replace(/, ([^,]*)$/, ' or $1')} (${mapHosts.join(', ')}), not from ${address.hostname}.`);
    if (!/\.osm\.pbf$/i.test(address.pathname)) throw new Error('That link is not to a .osm.pbf file: on the server\'s page, copy the link that ends in .osm.pbf.');
    return { url: address.href, server: server.name };
}

// Geofabrik's index (its GeoJSON, as text or parsed) as extracts: [{ id, name, parent, url, checksumUrl, rings, area }],
// `rings` the outlines as [[lon, lat]] lists, `area` roughly in square kilometres. Extracts with no file or no outline
// are left out.
export function readMapIndex(answer) {
    const parsed = typeof answer === 'string' ? JSON.parse(answer) : answer;
    if (!Array.isArray(parsed?.features)) throw new Error('This is not Geofabrik\'s index of extracts.');
    const names = new Map(parsed.features.map((feature) => [feature.properties?.id, feature.properties?.name]));
    return parsed.features.flatMap((feature) => {
        const properties = feature.properties ?? {};
        const url = properties.urls?.pbf;
        const geometry = feature.geometry;
        if (!url || !geometry) return [];
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
        // The outer ring of each polygon: the holes of a country's outline (an enclave) are not worth the cost here.
        const rings = polygons.map((polygon) => polygon[0]).filter((ring) => Array.isArray(ring) && ring.length >= 3);
        if (!rings.length) return [];
        return [{ id: properties.id, name: properties.name, parent: properties.parent ? names.get(properties.parent) ?? properties.parent : null, url, checksumUrl: checksumUrlOf(url), rings, area: rings.reduce((sum, ring) => sum + ringArea(ring), 0) }];
    });
}

// A ring's area in square kilometres, near enough to tell a city's extract from a country's.
function ringArea(ring) {
    const latitude = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
    const scale = 111.32 * 111.32 * Math.cos(latitude * Math.PI / 180);
    let twice = 0;
    for (let index = 0; index < ring.length; index += 1) {
        const [x1, y1] = ring[index];
        const [x2, y2] = ring[(index + 1) % ring.length];
        twice += x1 * y2 - x2 * y1;
    }
    return Math.abs(twice) / 2 * scale;
}
function inside(lon, lat, ring) {
    let within = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
        const [x1, y1] = ring[index];
        const [x2, y2] = ring[previous];
        if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) within = !within;
    }
    return within;
}

// The extracts that cover an area ({ south, west, north, east }), as few and as small as will do: the area is sampled
// on a grid, each point taking the smallest extract it lies in, and those taken are the answer, the one taking most
// points first. A border city gets its country's extract and its neighbour's, not the continent's. Returns
// { maps: [extract], uncovered (the share of points in none) }.
export function mapsCovering(index, bbox, { grid = 7 } = {}) {
    const taken = new Map();
    let missed = 0;
    let points = 0;
    for (let row = 0; row < grid; row += 1) {
        for (let column = 0; column < grid; column += 1) {
            const lat = bbox.south + (bbox.north - bbox.south) * (row + 0.5) / grid;
            const lon = bbox.west + (bbox.east - bbox.west) * (column + 0.5) / grid;
            points += 1;
            let best = null;
            for (const extract of index) {
                if (best && extract.area >= best.area) continue;
                if (extract.rings.some((ring) => inside(lon, lat, ring))) best = extract;
            }
            if (best) taken.set(best.id, { extract: best, count: (taken.get(best.id)?.count ?? 0) + 1 });
            else missed += 1;
        }
    }
    const maps = [...taken.values()].sort((a, b) => b.count - a.count).map((item) => item.extract);
    return { maps, uncovered: points ? missed / points : 0 };
}

// How old a map is, for saying so: by the date of its data where the file says, else by when it was kept. Older than
// `days` (a month), it may be out of date.
export function mapAge(file, { now = Date.now(), days = 30 } = {}) {
    const dated = file.details?.dataDate ?? null;
    const from = dated ?? file.storedAt ?? null;
    const age = from ? (now - Date.parse(from)) / 86400000 : null;
    return { from, basis: dated ? 'data' : 'kept', days: age, old: age !== null && age > days };
}
