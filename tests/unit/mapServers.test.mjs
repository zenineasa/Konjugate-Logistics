/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Where map files come from: the servers offered, a link of the user's own checked, Geofabrik's index read, the
// extracts covering an area found, and how old a kept map is.

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedMapLink, checksumUrlOf, mapAge, mapHosts, mapsCovering, readMapIndex } from '../../packages/toolbox/lib/mapServers.mjs';

// A small index in Geofabrik's form: a continent, a country, its neighbour's region, and a region with no outline.
const square = (west, south, east, north) => [[[west, south], [east, south], [east, north], [west, north], [west, south]]];
const index = readMapIndex(JSON.stringify({
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', properties: { id: 'europe', name: 'Europe', urls: { pbf: 'https://download.geofabrik.de/europe-latest.osm.pbf' } }, geometry: { type: 'Polygon', coordinates: square(-10, 35, 30, 60) } },
        { type: 'Feature', properties: { id: 'switzerland', parent: 'europe', name: 'Switzerland', urls: { pbf: 'https://download.geofabrik.de/europe/switzerland-latest.osm.pbf' } }, geometry: { type: 'MultiPolygon', coordinates: [square(6, 45.95, 10.5, 47.8)] } },
        { type: 'Feature', properties: { id: 'nord-ovest', parent: 'italy', name: 'Nord-Ovest', urls: { pbf: 'https://download.geofabrik.de/europe/italy/nord-ovest-latest.osm.pbf' } }, geometry: { type: 'Polygon', coordinates: square(6.5, 43.7, 10.5, 45.95) } },
        { type: 'Feature', properties: { id: 'italy', parent: 'europe', name: 'Italy', urls: { pbf: 'https://download.geofabrik.de/europe/italy-latest.osm.pbf' } }, geometry: { type: 'Polygon', coordinates: square(6.5, 36, 18.6, 47.1) } },
        { type: 'Feature', properties: { id: 'nowhere', name: 'No outline', urls: { pbf: 'https://download.geofabrik.de/nowhere.osm.pbf' } }, geometry: null }
    ]
}));

test('Geofabrik\'s index is read as extracts with their outlines, parents and published sums', () => {
    assert.deepEqual(index.map((item) => [item.id, item.name, item.parent]), [['europe', 'Europe', null], ['switzerland', 'Switzerland', 'Europe'], ['nord-ovest', 'Nord-Ovest', 'Italy'], ['italy', 'Italy', 'Europe']]);
    assert.equal(index[1].checksumUrl, 'https://download.geofabrik.de/europe/switzerland-latest.osm.pbf.md5');
    assert.ok(index[1].area > 50000 && index[1].area < 100000, `Switzerland's box is some 70,000 km² (${index[1].area})`);
    assert.throws(() => readMapIndex('{"elements": []}'), /not Geofabrik's index/);
});

test('the extracts covering an area are as few and as small as will do: a border city gets both its sides, not the continent', () => {
    // Lugano, with 25 km around it: Switzerland and north-west Italy.
    const lugano = { south: 45.78, west: 8.63, north: 46.23, east: 9.27 };
    assert.deepEqual(mapsCovering(index, lugano).maps.map((item) => item.id), ['switzerland', 'nord-ovest']);
    assert.equal(mapsCovering(index, lugano).uncovered, 0);
    // Zurich, inside Switzerland: Switzerland alone.
    assert.deepEqual(mapsCovering(index, { south: 47.3, west: 8.4, north: 47.45, east: 8.65 }).maps.map((item) => item.id), ['switzerland']);
    // Far out at sea: nothing covers it, and it is said how much.
    const sea = mapsCovering(index, { south: 0, west: 0, north: 1, east: 1 });
    assert.deepEqual([sea.maps, sea.uncovered], [[], 1]);
});

test('a link of the user\'s own is taken from a server listed, to a .osm.pbf file, and says what is wrong otherwise', () => {
    assert.deepEqual(checkedMapLink(' https://download.openstreetmap.fr/extracts/europe/italy/lombardia-latest.osm.pbf '), { url: 'https://download.openstreetmap.fr/extracts/europe/italy/lombardia-latest.osm.pbf', server: 'OpenStreetMap France' });
    assert.deepEqual(checkedMapLink('https://download.bbbike.org/osm/bbbike/Zuerich/Zuerich.osm.pbf').server, 'BBBike');
    assert.throws(() => checkedMapLink('not a link'), /not a web address/);
    assert.throws(() => checkedMapLink('http://download.geofabrik.de/europe/switzerland-latest.osm.pbf'), /Only https/);
    assert.throws(() => checkedMapLink('https://example.com/a.osm.pbf'), /^Error: Maps are downloaded from Geofabrik, OpenStreetMap France or BBBike \(download\.geofabrik\.de, download\.openstreetmap\.fr, download\.bbbike\.org\), not from example\.com\.$/);
    assert.throws(() => checkedMapLink('https://download.geofabrik.de/europe/switzerland-latest-free.shp.zip'), /not to a \.osm\.pbf file/);
    assert.deepEqual(mapHosts, ['download.geofabrik.de', 'download.openstreetmap.fr', 'download.bbbike.org']);
    assert.equal(checksumUrlOf('https://download.bbbike.org/osm/bbbike/Zuerich/Zuerich.osm.pbf'), null, 'BBBike publishes no sum beside the file');
});

test('a kept map is said to be out of date when its data, or else its keeping, is more than a month old', () => {
    const now = Date.parse('2026-11-20T00:00:00Z');
    assert.deepEqual(mapAge({ storedAt: '2026-11-19T00:00:00Z', details: { dataDate: '2026-10-13T20:21:31Z' } }, { now }), { from: '2026-10-13T20:21:31Z', basis: 'data', days: (now - Date.parse('2026-10-13T20:21:31Z')) / 86400000, old: true });
    assert.equal(mapAge({ storedAt: '2026-11-01T00:00:00Z', details: {} }, { now }).old, false, 'kept 19 days ago, its data date unknown');
    assert.equal(mapAge({ storedAt: '2026-11-01T00:00:00Z', details: {} }, { now }).basis, 'kept');
    assert.equal(mapAge({ details: {} }, { now }).old, false);
});
