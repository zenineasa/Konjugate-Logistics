/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The land, coastlines and country borders the toolbox window draws under a region's own map data, cut from Natural
// Earth's 1:10m layers (public domain, https://www.naturalearthdata.com) into 10-degree tiles, so the window loads only
// the tiles a region touches, offline. Run it when the Natural Earth release changes; the tiles are committed.
//
//   node scripts/buildGeography.mjs
//
// The sources are downloaded once, at a pinned release, into out/naturalEarth/ (not committed). Each tile holds:
//   land:    rings of land and of lakes in it, cut exactly to the tile (for an even-odd fill; the cut edges are not
//            coastline, so the fill has no stroke)
//   coast:   coastlines, as lines
//   borders: [{ settled, points }] country borders on land; settled is false for Natural Earth's disputed, indefinite and
//            de facto lines (lines of control, claim lines, breakaway regions and the like), drawn dashed
// Points are rounded to a thousandth of a degree (about 100 m; the 1:10m layers are good to about a kilometre) and
// written as [lat0, lon0, dlat, dlon, ...] in thousandths of a degree.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logisticsRoot } from './konjugatePaths.mjs';
import { clipLine, clipRing, tileName, tileSize } from '../packages/toolbox/lib/geography.mjs';

const release = 'v5.1.2';
const source = (name) => `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${release}/geojson/${name}.geojson`;
const cache = join(logisticsRoot, 'out', 'naturalEarth', release);
const target = join(logisticsRoot, 'packages', 'toolbox', 'geography');

async function layer(name) {
    const file = join(cache, `${name}.geojson`);
    if (!existsSync(file)) {
        await mkdir(cache, { recursive: true });
        const response = await fetch(source(name));
        if (!response.ok) throw new Error(`Natural Earth answered ${response.status} for ${name}.`);
        await writeFile(file, Buffer.from(await response.arrayBuffer()));
        console.log(`fetched ${name}`);
    }
    return JSON.parse(await readFile(file, 'utf8')).features;
}

const lines = (geometry) => (geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : []);
const rings = (geometry) => (geometry.type === 'Polygon' ? geometry.coordinates : geometry.type === 'MultiPolygon' ? geometry.coordinates.flat() : []);
// GeoJSON [lon, lat] to { lat, lon }.
const points = (coordinates) => coordinates.map(([lon, lat]) => ({ lat, lon }));
// The tiles a set of points reaches.
function tilesOf(list) {
    const names = new Set();
    for (const { lat, lon } of list) names.add(tileName(lat, lon));
    return names;
}
const bounds = (name) => {
    const lat = (name[0] === 'S' ? -1 : 1) * Number(name.slice(1, 3));
    const lon = (name[3] === 'W' ? -1 : 1) * Number(name.slice(4, 7));
    return { south: lat, north: lat + tileSize, west: lon, east: lon + tileSize };
};
// [lat0, lon0, dlat, dlon, ...] in thousandths of a degree; a repeated point is dropped.
function encode(list) {
    const out = [];
    let lat = 0;
    let lon = 0;
    for (const point of list) {
        const a = Math.round(point.lat * 1000);
        const b = Math.round(point.lon * 1000);
        if (out.length && a === lat && b === lon) continue;
        out.push(out.length ? a - lat : a, out.length ? b - lon : b);
        lat = a;
        lon = b;
    }
    return out.length >= 4 ? out : null;
}

const tiles = new Map();
const tile = (name) => {
    if (!tiles.has(name)) tiles.set(name, { land: [], coast: [], borders: [] });
    return tiles.get(name);
};
// A feature's lines, cut to every tile they reach (with a small margin, so they meet across tile edges).
function addLines(list, put) {
    for (const name of tilesOf(list)) {
        for (const piece of clipLine(list, bounds(name), 0.05)) {
            const encoded = encode(piece);
            if (encoded) put(tile(name), encoded);
        }
    }
}

const settledClasses = new Set(['International boundary (verify)']);
for (const feature of await layer('ne_10m_land')) {
    for (const ring of rings(feature.geometry)) {
        const list = points(ring);
        // A ring's tiles: every tile its bounding box covers (a large ring may enclose tiles none of its points fall in).
        const south = Math.floor(Math.min(...list.map((p) => p.lat)) / tileSize) * tileSize;
        const north = Math.max(...list.map((p) => p.lat));
        const west = Math.floor(Math.min(...list.map((p) => p.lon)) / tileSize) * tileSize;
        const east = Math.max(...list.map((p) => p.lon));
        for (let lat = south; lat < north; lat += tileSize) {
            for (let lon = west; lon < east; lon += tileSize) {
                const name = tileName(lat, lon);
                // Cut exactly at the tile's edges: neighbouring tiles' land then meets without overlapping, which an
                // even-odd fill (keeping lakes as holes) would otherwise show as unfilled stripes.
                const cut = clipRing(list, bounds(name), 0);
                const encoded = cut.length >= 3 ? encode(cut) : null;
                if (encoded) tile(name).land.push(encoded);
            }
        }
    }
}
for (const feature of await layer('ne_10m_coastline')) {
    for (const line of lines(feature.geometry)) addLines(points(line), (item, encoded) => item.coast.push(encoded));
}
for (const feature of await layer('ne_10m_admin_0_boundary_lines_land')) {
    const settled = settledClasses.has(feature.properties.FEATURECLA);
    for (const line of lines(feature.geometry)) addLines(points(line), (item, encoded) => item.borders.push({ settled, points: encoded }));
}
for (const feature of await layer('ne_10m_admin_0_boundary_lines_disputed_areas')) {
    for (const line of lines(feature.geometry)) addLines(points(line), (item, encoded) => item.borders.push({ settled: false, points: encoded }));
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
let bytes = 0;
for (const [name, content] of tiles) {
    const text = JSON.stringify(content);
    bytes += text.length;
    await writeFile(join(target, `${name}.json`), text);
}
const index = { source: `Natural Earth ${release} (1:10m land, coastline, admin 0 boundary lines on land and disputed areas), public domain`, tileSize, tiles: [...tiles.keys()].sort() };
await writeFile(join(target, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
console.log(`wrote ${tiles.size} tiles, ${(bytes / 1024 / 1024).toFixed(1)} MB, to ${target}`);
