/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Reads roads and place names out of an OpenStreetMap extract (a .osm.pbf file, as Geofabrik and others publish for
// countries and regions), for an area, as the answers OpenStreetMap's server would have given for it: so a city's
// streets can be loaded from a file on the user's computer, with no server to wait for.
//
// The format (wiki.openstreetmap.org/wiki/PBF_Format): a sequence of blobs, each a length, a small header and a
// zlib-compressed block of protocol buffers. A block holds a table of strings and groups of nodes (usually "dense":
// ids and coordinates as differences from the one before), ways (their tags and the ids of their nodes) and relations.
// Only what is needed is decoded: the ways tagged as roads of the wanted classes, the nodes those ways run through,
// and the nodes tagged as places.
//
// The file is read twice. Ways come after nodes in a file, and which nodes are wanted is known only from the ways:
// the first reading takes the ways, the second the coordinates of their nodes. Coordinates of every node of a region
// would not fit in memory; those of its roads do.

// ---- protocol buffers, as far as the format needs them --------------------------------------------------------------

// A reader over bytes: fields as [number, wire type], variable-length integers as numbers (ids pass 2^32 and stay well
// under 2^53, so they are added up, not shifted).
class Reader {
    constructor(bytes, start = 0, end = bytes.length) {
        this.bytes = bytes;
        this.at = start;
        this.end = end;
    }
    get more() { return this.at < this.end; }
    varint() {
        const bytes = this.bytes;
        let value = 0;
        let scale = 1;
        for (;;) {
            if (this.at >= this.end) throw new Error('The file ends in the middle of a number.');
            const byte = bytes[this.at++];
            value += (byte & 0x7f) * scale;
            if (byte < 0x80) return value;
            scale *= 128;
            if (scale > 2 ** 63) throw new Error('A number in the file is too long.');
        }
    }
    // A signed integer in "zigzag" form: 0, -1, 1, -2, ...
    signed() {
        const value = this.varint();
        return value % 2 ? -(value + 1) / 2 : value / 2;
    }
    tag() {
        const value = this.varint();
        return [Math.floor(value / 8), value % 8];
    }
    // The bytes of a length-delimited field, as a reader over them.
    sub() {
        const length = this.varint();
        const start = this.at;
        this.at += length;
        if (this.at > this.end) throw new Error('A field in the file runs past its end.');
        return new Reader(this.bytes, start, this.at);
    }
    skip(wire) {
        if (wire === 0) this.varint();
        else if (wire === 2) this.sub();
        else if (wire === 1) this.at += 8;
        else if (wire === 5) this.at += 4;
        else throw new Error('The file is not a protocol buffer this reader knows.');
        if (this.at > this.end) throw new Error('A field in the file runs past its end.');
    }
    text() {
        const part = this.sub();
        return decoder.decode(part.bytes.subarray(part.at, part.end));
    }
}
const decoder = new TextDecoder('utf-8');

// The blobs of a file, one after the other: { type: 'OSMHeader' | 'OSMData', data: () => bytes }. `inflate` undoes
// zlib (node:zlib's inflateSync, or any function of the same kind).
function* blobs(bytes, inflate) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    while (at < bytes.length) {
        if (at + 4 > bytes.length) throw new Error('The file ends in the middle of a block.');
        const headerLength = view.getUint32(at);
        at += 4;
        if (headerLength > 64 * 1024 || at + headerLength > bytes.length) throw new Error('This is not an OpenStreetMap extract (.osm.pbf): its first block is not one.');
        const header = new Reader(bytes, at, at + headerLength);
        at += headerLength;
        let type = '';
        let size = 0;
        while (header.more) {
            const [field, wire] = header.tag();
            if (field === 1 && wire === 2) type = header.text();
            else if (field === 3 && wire === 0) size = header.varint();
            else header.skip(wire);
        }
        if (at + size > bytes.length) throw new Error('The file ends in the middle of a block: it may not have been downloaded whole.');
        const start = at;
        at += size;
        yield {
            type,
            data() {
                const blob = new Reader(bytes, start, start + size);
                while (blob.more) {
                    const [field, wire] = blob.tag();
                    if (field === 1 && wire === 2) { const raw = blob.sub(); return bytes.subarray(raw.at, raw.end); }
                    if (field === 3 && wire === 2) { const packed = blob.sub(); return inflate(bytes.subarray(packed.at, packed.end)); }
                    if ([4, 5, 6, 7].includes(field)) throw new Error('The file is compressed in a way this reader does not undo (only zlib, the usual one).');
                    blob.skip(wire);
                }
                throw new Error('A block of the file holds nothing.');
            }
        };
    }
}

// A block's table of strings, as bytes ranges decoded on demand: most are never asked for.
function stringTable(reader) {
    const ranges = [];
    while (reader.more) {
        const [field, wire] = reader.tag();
        if (field === 1 && wire === 2) { const item = reader.sub(); ranges.push(item.at, item.end); } else reader.skip(wire);
    }
    const known = new Map();
    const at = (index) => {
        if (!known.has(index)) known.set(index, decoder.decode(reader.bytes.subarray(ranges[index * 2], ranges[index * 2 + 1])));
        return known.get(index);
    };
    // The index of a string, or -1: found by comparing bytes, so the table is not decoded to look.
    const indexOf = (text) => {
        const wanted = encoder.encode(text);
        for (let index = 0; index < ranges.length / 2; index += 1) {
            const start = ranges[index * 2];
            if (ranges[index * 2 + 1] - start !== wanted.length) continue;
            let same = true;
            for (let offset = 0; offset < wanted.length && same; offset += 1) same = reader.bytes[start + offset] === wanted[offset];
            if (same) return index;
        }
        return -1;
    };
    return { at, indexOf, size: ranges.length / 2 };
}
const encoder = new TextEncoder();

// A block: its strings, its groups (as readers), and how its coordinates are scaled.
function block(bytes) {
    const reader = new Reader(bytes);
    let strings = null;
    const groups = [];
    let granularity = 100;
    let latOffset = 0;
    let lonOffset = 0;
    while (reader.more) {
        const [field, wire] = reader.tag();
        if (field === 1 && wire === 2) strings = stringTable(reader.sub());
        else if (field === 2 && wire === 2) groups.push(reader.sub());
        else if (field === 17 && wire === 0) granularity = reader.varint();
        else if (field === 19 && wire === 0) latOffset = reader.signed();
        else if (field === 20 && wire === 0) lonOffset = reader.signed();
        else reader.skip(wire);
    }
    const degrees = (value, offset) => (offset + granularity * value) * 1e-9;
    return { strings: strings ?? stringTable(new Reader(new Uint8Array(0))), groups, lat: (value) => degrees(value, latOffset), lon: (value) => degrees(value, lonOffset) };
}

const packed = (reader, read) => { const values = []; while (reader.more) values.push(read(reader)); return values; };

// Numbers kept outside the heap, growing as they come: a region's roads run through millions of nodes, and their ids
// and coordinates as plain arrays or maps would not fit in what an importer is given.
class Numbers {
    constructor() { this.values = new Float64Array(1 << 16); this.length = 0; }
    push(value) {
        if (this.length === this.values.length) { const grown = new Float64Array(this.values.length * 2); grown.set(this.values); this.values = grown; }
        this.values[this.length++] = value;
    }
}
// Where `value` is in `sorted` (ascending, the first `length` of it), or -1.
function find(sorted, length, value) {
    let low = 0;
    let high = length - 1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        const at = sorted[middle];
        if (at === value) return middle;
        if (at < value) low = middle + 1; else high = middle - 1;
    }
    return -1;
}

// ---- what is read out of it ----------------------------------------------------------------------------------------

const majorRoads = ['motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link', 'primary_link'];
const cityRoads = [...majorRoads, 'secondary', 'tertiary', 'secondary_link', 'tertiary_link'];
const placeKinds = ['city', 'town', 'suburb', 'quarter'];
// The tags kept of a road and of a place: what the toolbox reads of them, and no more, so what is kept stays small.
const roadTags = ['highway', 'maxspeed', 'name', 'name:en', 'ref', 'oneway'];
const placeTags = ['place', 'name', 'name:en', 'population'];

const inside = (lat, lon, bbox) => lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;

// The area a file says it covers ({ south, west, north, east }), or null when it does not say.
export function extractBounds(bytes, inflate) {
    for (const blob of blobs(bytes, inflate)) {
        if (blob.type !== 'OSMHeader') return null;
        const reader = new Reader(blob.data());
        while (reader.more) {
            const [field, wire] = reader.tag();
            if (field !== 1 || wire !== 2) { reader.skip(wire); continue; }
            const box = reader.sub();
            const sides = {};
            while (box.more) {
                const [side, sideWire] = box.tag();
                if (sideWire === 0 && side >= 1 && side <= 4) sides[['west', 'east', 'north', 'south'][side - 1]] = box.signed() * 1e-9;
                else box.skip(sideWire);
            }
            return ['south', 'west', 'north', 'east'].every((side) => Number.isFinite(sides[side])) ? { south: sides.south, west: sides.west, north: sides.north, east: sides.east } : null;
        }
        return null;
    }
    return null;
}

// Reads `bytes` (a .osm.pbf file) for `bbox` ({ south, west, north, east }) at `roadLevel` ('major', or 'city' for
// secondary and tertiary roads too). Returns
//   { roads: [way], places: [node], counts: { blocks, ways, nodes }, bounds }
// as OpenStreetMap's server writes elements: a way is { type: 'way', id, tags, nodes: [id], geometry: [{ lat, lon }] },
// whole when any of it lies in the area (a road is not cut at the edge); a place is { type: 'node', id, lat, lon, tags }.
// A road whose nodes the file lacks (cut off at the extract's own edge) keeps the stretch the file has.
// `roadLevel: 'none'` reads no roads, and `places` names the kinds of place wanted (cities, towns, suburbs and
// quarters unless said).
export function readExtract(bytes, { bbox, roadLevel = 'major', inflate, places: wantedPlaces = placeKinds }) {
    if (typeof inflate !== 'function') throw new Error('readExtract needs a function that undoes zlib.');
    const wantedRoads = new Set(roadLevel === 'none' ? [] : roadLevel === 'city' ? cityRoads : majorRoads);
    // Each road: its id, its tags, and where its nodes start in `refs` (they end where the next road's start).
    const ways = [];
    const refs = new Numbers();
    const withNodes = [];
    let blocks = 0;
    let bounds = null;
    let sawHeader = false;
    let index = -1;
    // First reading: the roads, and which nodes they run through.
    for (const blob of blobs(bytes, inflate)) {
        index += 1;
        if (blob.type === 'OSMHeader') { sawHeader = true; continue; }
        if (blob.type !== 'OSMData') continue;
        if (!sawHeader) throw new Error('This is not an OpenStreetMap extract (.osm.pbf): it has no header.');
        blocks += 1;
        const { strings, groups } = block(blob.data());
        const highwayKey = strings.indexOf('highway');
        const roadValues = new Map([...wantedRoads].map((value) => [strings.indexOf(value), value]).filter(([at]) => at >= 0));
        let hasNodes = false;
        for (const group of groups) {
            while (group.more) {
                const [field, wire] = group.tag();
                if (field === 1 || field === 2) { hasNodes = true; group.skip(wire); continue; }
                if (field !== 3 || wire !== 2 || highwayKey < 0 || !roadValues.size) { group.skip(wire); continue; }
                const way = group.sub();
                let id = 0;
                let keys = null;
                let values = null;
                let nodeIds = null;
                while (way.more) {
                    const [part, partWire] = way.tag();
                    if (part === 1 && partWire === 0) id = way.varint();
                    else if (part === 2 && partWire === 2) keys = packed(way.sub(), (reader) => reader.varint());
                    else if (part === 3 && partWire === 2) values = packed(way.sub(), (reader) => reader.varint());
                    else if (part === 8 && partWire === 2) nodeIds = way.sub();
                    else way.skip(partWire);
                }
                const at = keys?.indexOf(highwayKey) ?? -1;
                if (at < 0 || !roadValues.has(values?.[at]) || !nodeIds) continue;
                const start = refs.length;
                let node = 0;
                while (nodeIds.more) { node += nodeIds.signed(); refs.push(node); }
                if (refs.length - start < 2) { refs.length = start; continue; }
                const tags = {};
                for (let tag = 0; tag < keys.length; tag += 1) {
                    const key = strings.at(keys[tag]);
                    if (roadTags.includes(key)) tags[key] = strings.at(values[tag]);
                }
                ways.push({ id, tags, start });
            }
        }
        if (hasNodes) withNodes.push(index);
    }
    if (!sawHeader) throw new Error('This is not an OpenStreetMap extract (.osm.pbf): it has no header.');
    // Second reading: where those nodes are, and the places.
    // The nodes wanted, each once, in order of id, with a place for its coordinates (in ten-millionths of a degree,
    // the precision of OpenStreetMap itself).
    const sorted = refs.values.slice(0, refs.length).sort();
    let wantedCount = 0;
    for (let at = 0; at < sorted.length; at += 1) if (at === 0 || sorted[at] !== sorted[at - 1]) sorted[wantedCount++] = sorted[at];
    const wantedIds = sorted;
    const lats = new Int32Array(wantedCount);
    const lons = new Int32Array(wantedCount);
    const placed = new Uint8Array(wantedCount);
    const places = [];
    const nodeBlocks = new Set(withNodes);
    let nodes = 0;
    index = -1;
    for (const blob of blobs(bytes, inflate)) {
        index += 1;
        if (blob.type === 'OSMHeader') { bounds = extractBounds(bytes, inflate); continue; }
        if (!nodeBlocks.has(index)) continue;
        const { strings, groups, lat: latOf, lon: lonOf } = block(blob.data());
        const placeKey = strings.indexOf('place');
        const placeValues = new Set(wantedPlaces.map((kind) => strings.indexOf(kind)).filter((at) => at >= 0));
        const tagsOf = (pairs) => {
            const tags = {};
            for (let at = 0; at + 1 < pairs.length; at += 2) {
                const key = strings.at(pairs[at]);
                if (placeTags.includes(key)) tags[key] = strings.at(pairs[at + 1]);
            }
            return tags;
        };
        const take = (id, lat, lon, pairs) => {
            nodes += 1;
            const slot = find(wantedIds, wantedCount, id);
            if (slot >= 0) { lats[slot] = Math.round(lat * 1e7); lons[slot] = Math.round(lon * 1e7); placed[slot] = 1; }
            takePlace(id, lat, lon, pairs);
        };
        const takePlace = (id, lat, lon, pairs) => {
            if (!pairs || placeKey < 0 || !placeValues.size) return;
            for (let at = 0; at + 1 < pairs.length; at += 2) {
                if (pairs[at] !== placeKey || !placeValues.has(pairs[at + 1])) continue;
                if (inside(lat, lon, bbox)) places.push({ type: 'node', id, lat: Number(lat.toFixed(7)), lon: Number(lon.toFixed(7)), tags: tagsOf(pairs) });
                return;
            }
        };
        for (const group of groups) {
            while (group.more) {
                const [field, wire] = group.tag();
                if (field === 2 && wire === 2) {
                    // Dense nodes: ids, latitudes and longitudes each as differences, and the tags of all of them in one
                    // run, a node's ending at a 0.
                    const dense = group.sub();
                    let ids = null;
                    let latitudes = null;
                    let longitudes = null;
                    let keysValues = null;
                    while (dense.more) {
                        const [part, partWire] = dense.tag();
                        if (part === 1 && partWire === 2) ids = dense.sub();
                        else if (part === 8 && partWire === 2) latitudes = dense.sub();
                        else if (part === 9 && partWire === 2) longitudes = dense.sub();
                        else if (part === 10 && partWire === 2) keysValues = dense.sub();
                        else dense.skip(partWire);
                    }
                    if (!ids || !latitudes || !longitudes) continue;
                    const tagged = Boolean(keysValues?.more) && placeKey >= 0 && placeValues.size > 0;
                    let id = 0;
                    let lat = 0;
                    let lon = 0;
                    // Ids rise through a block: the next wanted one is looked for from where the last was.
                    let next = -1;
                    while (ids.more) {
                        id += ids.signed();
                        lat += latitudes.signed();
                        lon += longitudes.signed();
                        if (next < 0 || (next < wantedCount && wantedIds[next] < id)) {
                            // First node of the block, or ids not in order: find the place afresh.
                            let low = 0;
                            let high = wantedCount;
                            while (low < high) { const middle = (low + high) >> 1; if (wantedIds[middle] < id) low = middle + 1; else high = middle; }
                            next = low;
                        }
                        const isWanted = next < wantedCount && wantedIds[next] === id;
                        let pairs = null;
                        if (tagged) {
                            pairs = [];
                            for (;;) {
                                if (!keysValues.more) break;
                                const key = keysValues.varint();
                                if (key === 0) break;
                                pairs.push(key, keysValues.varint());
                            }
                            if (!pairs.length) pairs = null;
                        }
                        if (isWanted) { lats[next] = Math.round(latOf(lat) * 1e7); lons[next] = Math.round(lonOf(lon) * 1e7); placed[next] = 1; }
                        if (pairs) takePlace(id, latOf(lat), lonOf(lon), pairs);
                        nodes += 1;
                    }
                } else if (field === 1 && wire === 2) {
                    const node = group.sub();
                    let id = 0;
                    let lat = 0;
                    let lon = 0;
                    let keys = [];
                    let values = [];
                    while (node.more) {
                        const [part, partWire] = node.tag();
                        if (part === 1 && partWire === 0) id = node.signed();
                        else if (part === 2 && partWire === 2) keys = packed(node.sub(), (reader) => reader.varint());
                        else if (part === 3 && partWire === 2) values = packed(node.sub(), (reader) => reader.varint());
                        else if (part === 8 && partWire === 0) lat = node.signed();
                        else if (part === 9 && partWire === 0) lon = node.signed();
                        else node.skip(partWire);
                    }
                    take(id, latOf(lat), lonOf(lon), keys.length ? keys.flatMap((key, at) => [key, values[at]]) : null);
                } else group.skip(wire);
            }
        }
    }
    // The roads of the area: whole when any of their nodes lies in it, with the stretch the file has coordinates for.
    const roads = [];
    const south = Math.round(bbox.south * 1e7);
    const north = Math.round(bbox.north * 1e7);
    const west = Math.round(bbox.west * 1e7);
    const east = Math.round(bbox.east * 1e7);
    for (const [number, way] of ways.entries()) {
        const end = number + 1 < ways.length ? ways[number + 1].start : refs.length;
        const slots = [];
        let touches = false;
        for (let at = way.start; at < end; at += 1) {
            const slot = find(wantedIds, wantedCount, refs.values[at]);
            const known = slot >= 0 && placed[slot] === 1;
            slots.push(known ? slot : -1);
            if (known && !touches && lats[slot] >= south && lats[slot] <= north && lons[slot] >= west && lons[slot] <= east) touches = true;
        }
        if (!touches) continue;
        // The longest run of nodes the file places: a way cut at the extract's edge keeps what lies within.
        let best = [0, 0];
        let start = 0;
        for (let at = 0; at <= slots.length; at += 1) {
            if (at < slots.length && slots[at] >= 0) continue;
            if (at - start > best[1] - best[0]) best = [start, at];
            start = at + 1;
        }
        if (best[1] - best[0] < 2) continue;
        const kept = slots.slice(best[0], best[1]);
        roads.push({ type: 'way', id: way.id, tags: way.tags, nodes: kept.map((slot) => wantedIds[slot]), geometry: kept.map((slot) => ({ lat: lats[slot] / 1e7, lon: lons[slot] / 1e7 })) });
    }
    return { roads, places, counts: { blocks, ways: ways.length, nodes }, bounds };
}

// What was read, as the answers the rest of the toolbox reads (OpenStreetMap's server's own form): the roads in parts
// of at most `maximumBytes` each (a file an importer is given has a size limit), and the places.
//   { roads: [text], places: text }
export function extractAnswers({ roads, places }, { source = 'an OpenStreetMap extract', maximumBytes = 8 * 1024 * 1024 } = {}) {
    const head = { version: 0.6, generator: `Konjugate Logistics Toolbox, from ${source}`, osm3s: { copyright: 'The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.' } };
    const parts = [];
    let current = [];
    let size = 0;
    for (const road of roads) {
        const text = JSON.stringify(road);
        if (current.length && size + text.length + 1 > maximumBytes - 1024) { parts.push(current); current = []; size = 0; }
        current.push(text);
        size += text.length + 1;
    }
    if (current.length || !parts.length) parts.push(current);
    const wrap = (elements) => `${JSON.stringify(head).slice(0, -1)},"elements":[${elements.join(',')}]}`;
    return { roads: parts.map(wrap), places: wrap(places.map((place) => JSON.stringify(place))) };
}

// The cities and towns a file holds, for choosing one of them as the place to load when the file covers far more than
// can be loaded whole: [{ name, place, lat, lon, population }], cities first, then the more populous, then by name. A
// place with a name in English is listed by it (as the map writes it), and found by its own name too (`also`).
export function extractPlaces(bytes, { inflate, most = 4000 }) {
    const world = { south: -90, west: -180, north: 90, east: 180 };
    const found = readExtract(bytes, { bbox: world, roadLevel: 'none', places: ['city', 'town'], inflate }).places
        .filter((place) => place.tags.name || place.tags['name:en'])
        .map((place) => {
            const name = place.tags['name:en'] ?? place.tags.name;
            const population = Number.parseInt(String(place.tags.population ?? '').replace(/[^0-9]/g, ''), 10);
            return { name, ...(place.tags.name && place.tags.name !== name ? { also: place.tags.name } : {}), place: place.tags.place, lat: place.lat, lon: place.lon, ...(population > 0 ? { population } : {}) };
        });
    const rank = { city: 0, town: 1 };
    return found.sort((a, b) => (rank[a.place] - rank[b.place]) || ((b.population ?? 0) - (a.population ?? 0)) || a.name.localeCompare(b.name)).slice(0, most);
}
