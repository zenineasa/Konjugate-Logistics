/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the toolbox asks OpenStreetMap for, through the Overpass API, and how an Overpass answer is
// read. Each kind of infrastructure is its own query so every answer stays well under the host's
// fetch limit, and each can be cached and refreshed on its own.

export const overpassHost = 'overpass-api.de';

const majorRoads = 'motorway|trunk|primary|motorway_link|trunk_link|primary_link';

// `bbox` is { south, west, north, east } in degrees.
export function overpassQueries(bbox) {
    const box = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
    const head = '[out:json][timeout:90];';
    return {
        ports: `${head}(nwr["landuse"="port"]${box};nwr["industrial"="port"]${box};nwr["harbour"="yes"]${box};nwr["seamark:type"="harbour"]${box};nwr["leisure"="marina"]${box};nwr["seamark:type"="anchorage"]${box};nwr["seamark:type"="anchor_berth"]${box};);out geom qt;`,
        logistics: `${head}(way["building"="warehouse"]${box};nwr["industrial"~"^(warehouse|logistics|distribution)$"]${box};)->.w;.w out bb qt;(way["landuse"="industrial"]${box};relation["landuse"="industrial"]${box};)->.l;.l out geom qt;`,
        roads: `${head}way["highway"~"^(${majorRoads})$"]${box};out geom qt;`,
        rail: `${head}(way["railway"="rail"]["service"!~"^(siding|spur|yard)$"]${box};)->.r;.r out geom qt;(nwr["railway"="yard"]${box};nwr["landuse"="railway"]${box};nwr["railway"="station"]["usage"="freight"]${box};)->.y;.y out center qt;`,
        places: `${head}node["place"~"^(city|town)$"]${box};out qt;`
    };
}

export function overpassUrl(query) {
    return `https://${overpassHost}/api/interpreter?data=${encodeURIComponent(query)}`;
}

const pointOfGeometry = (geometry) => {
    let lat = 0;
    let lon = 0;
    for (const point of geometry) { lat += point.lat; lon += point.lon; }
    return { lat: lat / geometry.length, lon: lon / geometry.length };
};

const isClosed = (geometry) => geometry.length > 3
    && geometry[0].lat === geometry[geometry.length - 1].lat && geometry[0].lon === geometry[geometry.length - 1].lon;

// Reads an Overpass JSON answer (text or parsed) into features:
//   { osmType, osmId, tags, point, ring (closed outline or null), rings (a relation's outlines),
//     line (open geometry or null), nodes (a way's node ids), bounds }
// A feature's point is its centre: a node's position, an outline's average, or its bounds' centre.
export function readOverpass(answer) {
    const parsed = typeof answer === 'string' ? JSON.parse(answer) : answer;
    if (!Array.isArray(parsed?.elements)) throw new Error('This is not an Overpass answer: it has no elements.');
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
