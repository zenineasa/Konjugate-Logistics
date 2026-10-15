/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Where the roads of an area should come from, proposed rather than asked: maps already kept that cover it (seconds,
// no server); else, for a large area, the maps covering it downloaded once and kept (the public server is slow for
// large areas, and refuses the largest); else OpenStreetMap's server. The user may change it; the proposal says why.

// Above this many kilometres across, an area is large: downloading its maps is proposed over asking the server.
export const largeAcross = { major: 120, city: 30 };

const coversRect = (outer, inner) => outer && inner.south >= outer.south && inner.north <= outer.north && inner.west >= outer.west && inner.east <= outer.east;
const overlapsRect = (a, b) => a && !(b.north < a.south || b.south > a.north || b.east < a.west || b.west > a.east);

// What a map file is named for, without its date or its "latest" and its ending: "switzerland" for Geofabrik's
// switzerland-latest.osm.pbf and for the switzerland-261013.osm.pbf a user downloaded by hand.
export const mapStem = (name) => decodeURIComponent(String(name ?? '').split('/').pop()).toLowerCase().replace(/(-(latest|\d{6}))?(-free)?\.osm\.pbf$/, '');
// Whether two boxes are much the same area: they overlap by more than half of what they cover together. Unknown (either
// missing) counts as agreeing.
function sameArea(a, b) {
    if (!a || !b) return true;
    const overlap = Math.max(0, Math.min(a.north, b.north) - Math.max(a.south, b.south)) * Math.max(0, Math.min(a.east, b.east) - Math.max(a.west, b.west));
    const size = (box) => (box.north - box.south) * (box.east - box.west);
    return overlap / (size(a) + size(b) - overlap) > 0.5;
}
// The kept map a covering extract is: the one downloaded from its address, or kept with its index id; else a file of
// the user's of the same name (a Geofabrik extract downloaded by hand) whose own bounds are much the extract's.
export function keptAs(kept, map) {
    return kept.find((file) => file.origin?.url === map.url || (map.id && file.details?.indexId === map.id))
        ?? kept.find((file) => file.origin?.kind !== 'download' && mapStem(file.name) === mapStem(map.url) && sameArea(file.details?.bounds, map.bounds))
        ?? null;
}

// `bbox` the area, `across` its width in km, `level` 'major' or 'city', `serverLimit` the most the server is asked for
// (km across), `kept` the map files kept ([{ id, name, origin, details: { bounds, indexId, region, dataDate } }]),
// `covering` Geofabrik's extracts covering the area ({ maps: [{ id, name, parent, url, checksumUrl }], uncovered }) or
// null when not known (offline, say), `sizes` bytes by address where known. Returns
//   { kind: 'kept' | 'download' | 'server' | 'none', use: [kept file], download: [map], bytes (to download, or null
//     when unknown), sure (whether the kept maps are known to cover it, or only may), alternatives: [kind], why }
export function proposeSource({ bbox, across, level = 'major', serverLimit, kept = [], covering = null, sizes = {} }) {
    const large = across > (largeAcross[level] ?? largeAcross.major) || across > serverLimit;
    const serverAllowed = across <= serverLimit;
    const overlapping = kept.filter((file) => overlapsRect(file.details?.bounds, bbox));
    let use = [];
    let download = [];
    let sure = false;
    if (covering?.maps?.length) {
        // The extracts that cover it, each kept or not.
        use = covering.maps.map((map) => keptAs(kept, map)).filter(Boolean);
        download = covering.maps.filter((map) => !keptAs(kept, map));
        sure = true;
    } else {
        // Not known which extracts cover it: a kept map whose own bounds hold the area may (its outline is not known).
        const holding = kept.find((file) => coversRect(file.details?.bounds, bbox));
        if (holding) use = [holding];
    }
    const bytes = download.length ? (download.every((map) => sizes[map.url] > 0) ? download.reduce((sum, map) => sum + sizes[map.url], 0) : null) : 0;
    let kind;
    let why;
    if (use.length && !download.length) {
        kind = 'kept';
        why = sure ? 'Your maps cover this area: read in seconds, with no server.' : 'Your map may cover this area (its own bounds hold it): read in seconds, with no server.';
    } else if (large && (download.length || !covering)) {
        kind = download.length ? 'download' : 'none';
        why = download.length
            ? `${serverAllowed ? 'A large area: slow to load from the public server.' : 'Too large an area for the public server.'} Its maps are downloaded once and kept, then read in seconds, now and next time.`
            : 'A large area, and which maps cover it is not known (no connection to Geofabrik?): add files of yours under Manage maps.';
    } else if (serverAllowed) {
        kind = 'server';
        why = 'A small area: loaded from OpenStreetMap\'s server, and kept from it to load again at once.';
    } else {
        kind = 'none';
        why = 'No maps cover this area, and it is too large for the public server.';
    }
    const alternatives = [
        ...(kind !== 'kept' && overlapping.length ? ['kept'] : []),
        ...(kind !== 'download' && download.length ? ['download'] : []),
        ...(kind !== 'server' && serverAllowed ? ['server'] : []),
        'file'
    ];
    return { kind, use, download, bytes, sure, alternatives, why, overlapping };
}

// A size as a person reads it: GB above one, MB above one, else KB.
export function bytesText(bytes) {
    if (!(bytes > 0)) return null;
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2).toLocaleString('en')} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
