/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Where the roads of an area come from, proposed: kept maps covering it, else its maps downloaded when it is large,
// else the public server.

import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesText, largeAcross, proposeSource } from '../../packages/toolbox/lib/mapSource.mjs';

const lugano = { south: 45.78, west: 8.63, north: 46.23, east: 9.27 };
const switzerland = { id: 'switzerland', name: 'Switzerland', parent: 'Europe', url: 'https://download.geofabrik.de/europe/switzerland-latest.osm.pbf' };
const nordOvest = { id: 'nord-ovest', name: 'Nord-Ovest', parent: 'Italy', url: 'https://download.geofabrik.de/europe/italy/nord-ovest-latest.osm.pbf' };
const covering = { maps: [switzerland, nordOvest], uncovered: 0 };
const sizes = { [switzerland.url]: 548 * 1024 ** 2, [nordOvest.url]: 593 * 1024 ** 2 };
const keptSwiss = { id: 'a'.repeat(32), name: 'switzerland-latest.osm.pbf', origin: { kind: 'download', url: switzerland.url, server: 'Geofabrik' }, details: { indexId: 'switzerland', bounds: { south: 45.8, west: 5.9, north: 47.8, east: 10.5 } } };
const keptItaly = { id: 'b'.repeat(32), name: 'nord-ovest-latest.osm.pbf', origin: { kind: 'download', url: nordOvest.url, server: 'Geofabrik' }, details: { indexId: 'nord-ovest' } };

test('a small area with no maps kept comes from the server, with downloading and a file of yours to change to', () => {
    const proposal = proposeSource({ bbox: lugano, across: 70, serverLimit: 250, covering, sizes });
    assert.deepEqual([proposal.kind, proposal.alternatives, proposal.bytes], ['server', ['download', 'file'], 1141 * 1024 ** 2]);
    assert.match(proposal.why, /^A small area/);
});

test('a large area is downloaded: its covering maps, sized, read in seconds now and next time', () => {
    const large = proposeSource({ bbox: lugano, across: 150, serverLimit: 250, covering, sizes });
    assert.deepEqual([large.kind, large.download.map((map) => map.id), large.bytes, large.alternatives], ['download', ['switzerland', 'nord-ovest'], 1141 * 1024 ** 2, ['server', 'file']]);
    assert.match(large.why, /^A large area: slow to load from the public server\. Its maps are downloaded once and kept/);
    // Beyond the server's limit, it is not offered at all.
    const huge = proposeSource({ bbox: lugano, across: 500, serverLimit: 250, covering, sizes });
    assert.deepEqual([huge.kind, huge.alternatives], ['download', ['file']]);
    assert.match(huge.why, /^Too large an area for the public server/);
    // City streets are large sooner.
    assert.equal(proposeSource({ bbox: lugano, across: largeAcross.city + 1, level: 'city', serverLimit: 40, covering, sizes }).kind, 'download');
    // A size not said by the server leaves the total unknown, not wrong.
    assert.equal(proposeSource({ bbox: lugano, across: 150, serverLimit: 250, covering, sizes: { [switzerland.url]: 1 } }).bytes, null);
});

test('maps kept that cover the area are read, whatever its size; one kept and one not, the other is downloaded', () => {
    const both = proposeSource({ bbox: lugano, across: 70, serverLimit: 250, kept: [keptSwiss, keptItaly], covering, sizes });
    assert.deepEqual([both.kind, both.use.map((file) => file.id), both.sure, both.download], ['kept', [keptSwiss.id, keptItaly.id], true, []]);
    assert.match(both.why, /^Your maps cover this area/);
    const half = proposeSource({ bbox: lugano, across: 150, serverLimit: 250, kept: [keptSwiss], covering, sizes });
    assert.deepEqual([half.kind, half.use.map((file) => file.id), half.download.map((map) => map.id), half.bytes], ['download', [keptSwiss.id], ['nord-ovest'], 593 * 1024 ** 2]);
    // Small, half kept: the server is proposed, and the kept map is an alternative.
    const smallHalf = proposeSource({ bbox: lugano, across: 70, serverLimit: 250, kept: [keptSwiss], covering, sizes });
    assert.deepEqual([smallHalf.kind, smallHalf.alternatives], ['server', ['kept', 'download', 'file']]);
});

test('with no index to look in, a kept map whose bounds hold the area may cover it; otherwise a large area asks for files', () => {
    const zurich = { south: 47.3, west: 8.4, north: 47.45, east: 8.65 };
    const may = proposeSource({ bbox: zurich, across: 20, serverLimit: 250, kept: [keptSwiss], covering: null });
    assert.deepEqual([may.kind, may.sure], ['kept', false]);
    assert.match(may.why, /^Your map may cover this area/);
    const unknown = proposeSource({ bbox: { south: 0, west: 0, north: 2, east: 2 }, across: 220, serverLimit: 250, covering: null });
    assert.equal(unknown.kind, 'none');
    assert.match(unknown.why, /which maps cover it is not known/);
    const sea = proposeSource({ bbox: lugano, across: 600, serverLimit: 250, covering: { maps: [], uncovered: 1 } });
    assert.deepEqual([sea.kind, sea.alternatives], ['none', ['file']]);
});

test('sizes read as a person reads them', () => {
    assert.deepEqual([bytesText(1141 * 1024 ** 2), bytesText(548 * 1024 ** 2), bytesText(3463632), bytesText(500), bytesText(0), bytesText(null)], ['1.1 GB', '548 MB', '3 MB', '1 KB', null, null]);
});

test('a Geofabrik extract downloaded by hand and added as a file of yours is known for what it is, by its name and its bounds', async () => {
    const { keptAs, mapStem } = await import('../../packages/toolbox/lib/mapSource.mjs');
    assert.deepEqual(['switzerland-261013.osm.pbf', 'switzerland-latest.osm.pbf', 'https://download.geofabrik.de/europe/italy/nord-ovest-latest.osm.pbf', 'Nord-Ovest-261013.osm.pbf'].map(mapStem), ['switzerland', 'switzerland', 'nord-ovest', 'nord-ovest']);
    // As kept on 14 October 2026: uploads, with the bounds their headers give.
    const swiss = { id: 'c'.repeat(32), name: 'switzerland-261013.osm.pbf', origin: { kind: 'upload', name: 'switzerland-261013.osm.pbf' }, details: { bounds: { south: 45.8164, west: 5.9544, north: 47.8084, east: 10.4921 } } };
    const italy = { id: 'd'.repeat(32), name: 'nord-ovest-261013.osm.pbf', origin: { kind: 'upload', name: 'nord-ovest-261013.osm.pbf' }, details: { bounds: { south: 43.4393, west: 5.5347, north: 47.0601, east: 10.5026 } } };
    const withBounds = (map, bounds) => ({ ...map, bounds });
    const swissMap = withBounds(switzerland, { south: 45.81, west: 5.95, north: 47.81, east: 10.5 });
    const italyMap = withBounds(nordOvest, { south: 43.43, west: 5.53, north: 47.07, east: 10.51 });
    assert.equal(keptAs([swiss, italy], swissMap), swiss);
    assert.equal(keptAs([swiss, italy], italyMap), italy);
    // Lugano with both kept: read from them, no download proposed (it was: "From Geofabrik: Switzerland and Nord-Ovest, 1.1 GB").
    const proposal = proposeSource({ bbox: lugano, across: 40, level: 'city', serverLimit: 40, kept: [swiss, italy], covering: { maps: [swissMap, italyMap], uncovered: 0 }, sizes });
    assert.deepEqual([proposal.kind, proposal.use.map((file) => file.name), proposal.download, proposal.sure], ['kept', ['switzerland-261013.osm.pbf', 'nord-ovest-261013.osm.pbf'], [], true]);
    // A file of the same name that covers somewhere else is not taken for it.
    const elsewhere = { ...swiss, details: { bounds: { south: 10, west: 10, north: 11, east: 11 } } };
    assert.equal(keptAs([elsewhere], swissMap), null);
    // Nor is a download from another address of the same name (it is known by its own address).
    assert.equal(keptAs([{ ...swiss, origin: { kind: 'download', url: 'https://download.openstreetmap.fr/extracts/europe/switzerland-latest.osm.pbf' } }], swissMap), null);
});
