/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Roads and place names read out of an OpenStreetMap extract (.osm.pbf), for an area, as OpenStreetMap's server would
// have answered for it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { extractAnswers, extractBounds, extractPlaces, readExtract } from '../../packages/toolbox/lib/osmPbf.mjs';
import { readOverpass } from '../../packages/toolbox/lib/overpass.mjs';
import { buildRoadGraph } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { writeOsmPbf } from '../fixtures/osmPbfFixture.mjs';

// A town: a primary road west to east through five nodes, a tertiary street north from its middle, a footpath, a
// primary road far to the east, and a road running out of the file (its last node is not in it). Ids pass 2^32, as
// OpenStreetMap's do.
const big = 12_000_000_000;
const nodes = [
    { id: 1, lat: 10.0, lon: 20.00 }, { id: 2, lat: 10.0, lon: 20.01 }, { id: 3, lat: 10.0, lon: 20.02, tags: { highway: 'traffic_signals' } },
    { id: 4, lat: 10.0, lon: 20.03 }, { id: 5, lat: 10.0, lon: 20.04 },
    { id: 6, lat: 10.01, lon: 20.02 }, { id: 7, lat: 10.02, lon: 20.02 },
    { id: 8, lat: 10.005, lon: 20.021, tags: { place: 'town', name: 'Mitte', 'name:en': 'Middle', population: '12000', wikidata: 'Q1' } },
    { id: 9, lat: 10.5, lon: 21.0, tags: { place: 'village', name: 'Small' } },
    { id: big + 1, lat: 10.0, lon: 25.0 }, { id: big + 2, lat: 10.0, lon: 25.01 },
    { id: big + 3, lat: 10.0, lon: 26.0, tags: { place: 'city', name: 'Far' } }
];
const ways = [
    { id: 100, nodes: [1, 2, 3, 4, 5], tags: { highway: 'primary', name: 'Main road', maxspeed: '60', surface: 'asphalt' } },
    { id: 101, nodes: [3, 6, 7], tags: { highway: 'tertiary', name: 'North street' } },
    { id: 102, nodes: [1, 6], tags: { highway: 'footway' } },
    { id: 103, nodes: [2, 6], tags: { building: 'yes' } },
    { id: big + 100, nodes: [big + 1, big + 2], tags: { highway: 'primary' } },
    { id: 104, nodes: [5, 4, 999], tags: { highway: 'trunk' } }
];
const bounds = { south: 9.9, west: 19.9, north: 10.6, east: 26.1 };
const town = { south: 9.99, west: 19.99, north: 10.03, east: 20.05 };
const file = writeOsmPbf({ nodes, ways, bounds });
const read = (options, bytes = file) => readExtract(bytes, { bbox: town, inflate: inflateSync, ...options });

test('an extract says what it covers, and a file that is not one is refused with the reason', () => {
    const covered = extractBounds(file, inflateSync);
    for (const side of ['south', 'west', 'north', 'east']) assert.ok(Math.abs(covered[side] - bounds[side]) < 1e-9, side);
    assert.equal(extractBounds(writeOsmPbf({ nodes, ways }), inflateSync), null, 'a file with no bounds says none');
    assert.throws(() => read({}, new TextEncoder().encode('{"elements": []}  this is some other file altogether')), /not an OpenStreetMap extract/);
    assert.throws(() => read({}, file.subarray(0, file.length - 20)), /ends in the middle of a block/);
    assert.throws(() => readExtract(file, { bbox: town }), /undoes zlib/);
});

test('the major roads of an area are read whole, with their nodes and the tags the toolbox uses; city streets when asked for', () => {
    const major = read({ roadLevel: 'major' });
    assert.deepEqual(major.roads.map((road) => road.id), [100, 104]);
    assert.deepEqual(major.roads[0], {
        type: 'way', id: 100, tags: { highway: 'primary', name: 'Main road', maxspeed: '60' }, nodes: [1, 2, 3, 4, 5],
        geometry: [{ lat: 10, lon: 20 }, { lat: 10, lon: 20.01 }, { lat: 10, lon: 20.02 }, { lat: 10, lon: 20.03 }, { lat: 10, lon: 20.04 }]
    });
    // A road running out of the file keeps the stretch the file has.
    assert.deepEqual([major.roads[1].nodes, major.roads[1].geometry.length], [[5, 4], 2]);
    const city = read({ roadLevel: 'city' });
    assert.deepEqual(city.roads.map((road) => [road.id, road.tags.highway]), [[100, 'primary'], [101, 'tertiary'], [104, 'trunk']]);
    assert.deepEqual(city.counts, { blocks: 5, ways: 4, nodes: 12 });
    // A road is whole when any of it lies in the area, and left out when none does.
    const corner = read({ roadLevel: 'city', bbox: { south: 10.015, west: 20.015, north: 10.03, east: 20.03 } });
    assert.deepEqual(corner.roads.map((road) => [road.id, road.nodes.length]), [[101, 3]]);
    const east = read({ roadLevel: 'major', bbox: { south: 9.9, west: 24.9, north: 10.1, east: 26.1 } });
    assert.deepEqual([east.roads.map((road) => road.id), east.roads[0].nodes, east.places.map((place) => place.tags.name)], [[big + 100], [big + 1, big + 2], ['Far']]);
});

test('the places of the area are read with their names and population: towns and cities, not villages or other tagged nodes', () => {
    assert.deepEqual(read({}).places, [{ type: 'node', id: 8, lat: 10.005, lon: 20.021, tags: { place: 'town', name: 'Mitte', 'name:en': 'Middle', population: '12000' } }]);
});

test('a file in blocks of any size, compressed or not, reads the same', () => {
    const expected = JSON.stringify(read({ roadLevel: 'city' }).roads);
    for (const options of [{ perBlock: 1 }, { perBlock: 100 }, { compress: false }]) {
        assert.equal(JSON.stringify(read({ roadLevel: 'city' }, writeOsmPbf({ nodes, ways, bounds, ...options })).roads), expected, JSON.stringify(options));
    }
});

test('what is read goes on as the answers OpenStreetMap\'s server gives: read as those are, routed over, and split to a size', () => {
    const answers = extractAnswers(read({ roadLevel: 'city' }), { source: 'town.osm.pbf' });
    assert.equal(answers.roads.length, 1);
    assert.match(JSON.parse(answers.roads[0]).generator, /from town\.osm\.pbf$/);
    assert.match(JSON.parse(answers.roads[0]).osm3s.copyright, /openstreetmap\.org.*ODbL/);
    const features = readOverpass(answers.roads);
    assert.deepEqual(features.map((feature) => [feature.osmType, feature.osmId, feature.nodes.length, feature.line.length]), [['way', 100, 5, 5], ['way', 101, 3, 3], ['way', 104, 2, 2]]);
    assert.deepEqual(readOverpass(answers.places).map((feature) => [feature.tags.name, feature.point]), [['Mitte', { lat: 10.005, lon: 20.021 }]]);
    // The main road and the street off it join at node 3: a route from the west end to the street's north end turns there.
    const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(features)));
    const leg = router.route({ lat: 10.0, lon: 20.0 }, { lat: 10.02, lon: 20.02 });
    assert.ok(leg.basis === 'routed' && Math.abs(leg.kilometres - 4.41) < 0.1, JSON.stringify([leg.basis, leg.kilometres]));
    // Parts of a size: every road once, none cut.
    const parts = extractAnswers(read({ roadLevel: 'city' }), { maximumBytes: 1300 }).roads;
    assert.ok(parts.length > 1 && parts.every((text) => text.length <= 1300), `${parts.map((text) => text.length)}`);
    assert.deepEqual(parts.flatMap((text) => JSON.parse(text).elements.map((element) => element.id)), [100, 101, 104]);
    // Nothing read is still an answer, with no elements.
    assert.deepEqual(JSON.parse(extractAnswers({ roads: [], places: [] }).roads[0]).elements, []);
});

test('the importer reads an extract for the area asked, or for the file\'s own, and hands the roads and places back as inputs', async () => {
    const { default: importRegion } = await import('../../packages/toolbox/importers/region.mjs');
    const step = (data, options = {}, name = 'town.osm.pbf') => importRegion({ files: data ? [{ role: 'extract', name, data }] : [], helpers: {}, options: { step: 'extract', ...options } });
    // No place searched: the file's own area, and for a town its streets too.
    const whole = await step(file.slice(), { roadLevel: 'auto' });
    assert.equal(whole.ok, false, 'the fixture covers six degrees: too wide to load whole');
    assert.match(whole.report.errors[0], /^town\.osm\.pbf covers an area that is [\d,]+ km across: roads are loaded for areas up to 250 km across\. Search a place first/);
    const small = await step(writeOsmPbf({ nodes: nodes.slice(0, 8), ways: ways.slice(0, 2), bounds: town }), { roadLevel: 'auto' });
    assert.deepEqual(small.data, { step: 'extract', bbox: small.data.bbox, roadLevel: 'city', file: 'town.osm.pbf', coverage: { roads: 2, places: 1 }, counts: { blocks: 3, ways: 2, nodes: 8 } });
    assert.ok(Math.abs(small.data.bbox.south - town.south) < 1e-9);
    assert.deepEqual(small.derived.map((item) => [item.role, item.name, item.source]), [['roads', 'roads-extract-1.json', 'town.osm.pbf'], ['places', 'places-extract.json', 'town.osm.pbf']]);
    assert.deepEqual(JSON.parse(small.derived[0].text).elements.map((element) => element.id), [100, 101]);
    // A place searched: its area and the road level chosen for it.
    const major = await step(file.slice(), { bbox: town, roadLevel: 'major' });
    assert.deepEqual([major.data.roadLevel, major.data.coverage], ['major', { roads: 2, places: 1 }]);
    // Refused with what to do: no file, an area the file does not cover, one with no roads, too wide an area, a file that says no area.
    assert.match((await step(null)).report.errors[0], /^Choose an OpenStreetMap extract/);
    assert.match((await step(file.slice(), { bbox: { south: 50, west: 50, north: 50.1, east: 50.1 } })).report.errors[0], /^town\.osm\.pbf does not cover this area: it runs from 9\.90, 19\.90 to 10\.60, 26\.10\.$/);
    assert.match((await step(file.slice(), { bbox: { south: 10.3, west: 22, north: 10.4, east: 22.1 } })).report.errors[0], /^town\.osm\.pbf has no major roads in this area\.$/);
    assert.match((await step(file.slice(), { bbox: { south: 9.9, west: 19.9, north: 10.6, east: 20.9 }, roadLevel: 'city' })).report.errors[0], /^This area is [\d,]+ km across: city streets are loaded for areas up to 40 km across\. Choose a smaller area\.$/);
    assert.match((await step(writeOsmPbf({ nodes, ways }), { roadLevel: 'auto' })).report.errors[0], /does not say what area it covers: search a place first/);
    assert.match((await step(new TextEncoder().encode('not an extract at all, just some text that is long enough'), { bbox: town })).report.errors[0], /^town\.osm\.pbf could not be read: This is not an OpenStreetMap extract/);
});

test('a file\'s own cities and towns are listed to choose a place from: cities first, the more populous first, by the name the map writes', async () => {
    const more = [
        { id: 20, lat: 11, lon: 21, tags: { place: 'city', name: 'Kleinstadt', population: '90 000' } },
        { id: 21, lat: 12, lon: 22, tags: { place: 'city', name: 'ಬೆಂಗಳೂರು', 'name:en': 'Bengaluru', population: '10839725' } },
        { id: 22, lat: 13, lon: 23, tags: { place: 'town', name: 'Alpha' } },
        { id: 23, lat: 14, lon: 24, tags: { place: 'suburb', name: 'A suburb' } },
        { id: 24, lat: 15, lon: 25, tags: { place: 'town' } }
    ];
    const places = extractPlaces(writeOsmPbf({ nodes: [...nodes, ...more], ways, bounds }), { inflate: inflateSync });
    assert.deepEqual(places.map((place) => [place.name, place.place, place.population ?? null]), [
        ['Bengaluru', 'city', 10839725], ['Kleinstadt', 'city', 90000], ['Far', 'city', null], ['Alpha', 'town', null], ['Middle', 'town', 12000]
    ].sort((a, b) => (a[1] === b[1] ? 0 : a[1] === 'city' ? -1 : 1) || ((b[2] ?? 0) - (a[2] ?? 0)) || a[0].localeCompare(b[0])));
    assert.deepEqual([places[0].also, places[0].lat, places[0].lon], ['ಬೆಂಗಳೂರು', 12, 22]);
    assert.equal(extractPlaces(writeOsmPbf({ nodes: [...nodes, ...more], ways, bounds }), { inflate: inflateSync, most: 2 }).length, 2);
    // The importer's step for it, and what it says of a file with no place to offer.
    const { default: importRegion } = await import('../../packages/toolbox/importers/region.mjs');
    const step = (data) => importRegion({ files: data ? [{ role: 'extract', name: 'zone.osm.pbf', data }] : [], helpers: {}, options: { step: 'extractPlaces' } });
    const listed = await step(writeOsmPbf({ nodes: [...nodes, ...more], ways, bounds }));
    assert.deepEqual([listed.ok, listed.data.file, listed.data.places.length, listed.derived], [true, 'zone.osm.pbf', 5, undefined]);
    assert.match((await step(writeOsmPbf({ nodes: nodes.slice(0, 7), ways: ways.slice(0, 2), bounds }))).report.errors[0], /^zone\.osm\.pbf names no city or town/);
    assert.match((await step(null)).report.errors[0], /^Choose an OpenStreetMap extract/);
});
