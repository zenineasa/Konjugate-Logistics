/* Copyright © 2026 Zenin Easa Panthakkalakath */

// How a link carries goods (road, rail or water), what is read of railways, waterways and water, and the graphs rail and
// water links are routed over.

import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleRings, buildLineGraph, freightClass, isFreightRail, laneEnds, laneName, linkMode, modeProblem, waterOf } from '../../packages/toolbox/lib/modes.mjs';
import { readOverpass } from '../../packages/toolbox/lib/overpass.mjs';

const point = (lat, lon) => ({ lat, lon });

test('a link is by road unless it says otherwise; rail and water carry to warehouses, deliveries to stores go by road', () => {
    assert.deepEqual([linkMode({}), linkMode({ mode: 'rail' }), linkMode({ mode: 'water' }), linkMode({ mode: 'air' })], ['road', 'rail', 'water', 'road']);
    assert.equal(laneName('water', 'Basel', 'Duisburg'), 'Water Basel → Duisburg');
    assert.equal(laneEnds('Rail Basel → Duisburg: Chilled'), 'Basel → Duisburg: Chilled');
    assert.equal(modeProblem('rail', 'supply'), null);
    assert.equal(modeProblem('water', 'transfer'), null);
    assert.equal(modeProblem('road', 'store'), null);
    assert.match(modeProblem('rail', 'store'), /^A link to a store goes by road: rail carries from suppliers and ports to warehouses, and between warehouses\.$/);
    assert.match(modeProblem('water', 'darkStore'), /^A link to a dark store goes by road/);
});

test('a waterway is navigable for freight by its CEMT class or as marked for ships; a railway by its use', () => {
    assert.equal(freightClass({ waterway: 'river', CEMT: 'Vb' }), 'Vb');
    assert.equal(freightClass({ waterway: 'canal', CEMT: '0' }), null, 'class 0 is for leisure craft');
    assert.equal(freightClass({ waterway: 'river', ship: 'yes' }), 'ship');
    assert.equal(freightClass({ waterway: 'river', CEMT: 'IV', ship: 'no' }), null);
    assert.equal(freightClass({ waterway: 'river', boat: 'yes' }), null, 'boats, not barges');
    assert.equal(isFreightRail({ railway: 'rail', usage: 'main' }), true);
    assert.equal(isFreightRail({ railway: 'rail', service: 'yard' }), false);
    assert.equal(isFreightRail({ railway: 'rail', usage: 'tourism' }), false);
    assert.equal(isFreightRail({ railway: 'tram' }), false);
});

test('pieces of an outline are joined end to end, either way round, into rings; one that cannot close is counted', () => {
    const a = [point(0, 0), point(0, 1), point(1, 1)];
    const b = [point(0, 0), point(1, 0), point(1, 1)]; // runs the other way round: reversed to join
    const square = [point(5, 5), point(5, 6), point(6, 6), point(5, 5)];
    const { rings, open } = assembleRings([a, b, square, [point(9, 9), point(9, 10)]]);
    assert.equal(open, 1);
    assert.deepEqual(rings.map((ring) => ring.length), [4, 5]);
    assert.deepEqual(rings[1].map((item) => [item.lat, item.lon]), [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]);
});

test('a lake mapped as a relation, as the server answers with its members\' geometry, is drawn as one area with its islands', () => {
    const answer = {
        elements: [
            { type: 'relation', id: 1, tags: { natural: 'water', water: 'lake', name: 'Lago di Lugano' }, members: [
                { type: 'way', ref: 10, role: 'outer', geometry: [point(46, 9), point(46, 9.1), point(46.1, 9.1)] },
                { type: 'way', ref: 11, role: 'outer', geometry: [point(46.1, 9.1), point(46.1, 9), point(46, 9)] },
                { type: 'way', ref: 12, role: 'inner', geometry: [point(46.04, 9.04), point(46.04, 9.05), point(46.05, 9.05), point(46.04, 9.04)] }
            ] },
            { type: 'way', id: 20, tags: { waterway: 'river', name: 'Tresa' }, nodes: [1, 2], geometry: [point(46, 8.9), point(46, 8.8)] }
        ]
    };
    const water = waterOf(readOverpass(answer));
    assert.deepEqual(water.areas.map((area) => [area.name, area.rings.length]), [['Lago di Lugano', 2]]);
    assert.deepEqual(water.lines.map((line) => [line.name, line.freight]), [['Tresa', null]]);
});

test('a mode\'s graph keeps every part of its lines, timed at the line\'s own speed for rail and faster than a barge for water', () => {
    const features = readOverpass({ elements: [
        { type: 'way', id: 1, tags: { railway: 'rail', maxspeed: '80' }, nodes: [1, 2], geometry: [point(47, 8), point(47, 8.1)] },
        { type: 'way', id: 2, tags: { railway: 'rail' }, nodes: [3, 4], geometry: [point(48, 8), point(48, 8.1)] },
        { type: 'way', id: 3, tags: { railway: 'rail', service: 'siding' }, nodes: [2, 5], geometry: [point(47, 8.1), point(47.01, 8.1)] },
        { type: 'way', id: 4, tags: { waterway: 'canal', CEMT: 'IV' }, nodes: [6, 7], geometry: [point(50, 8), point(50, 8.1)] }
    ] });
    const rail = buildLineGraph(features, 'rail');
    assert.equal(rail.mainVertices.length, 4, 'both lines, though they do not meet; not the siding');
    const first = rail.vertices.get(1).edges[0];
    assert.ok(Math.abs(first.metres / 1000 / first.hours - 80) < 1e-6, 'at its posted speed');
    const second = rail.vertices.get(3).edges[0];
    assert.ok(Math.abs(second.metres / 1000 / second.hours - 100) < 1e-6, '100 where none is posted');
    const water = buildLineGraph(features, 'water');
    assert.equal(water.mainVertices.length, 2);
    const canal = water.vertices.get(6).edges[0];
    assert.ok(Math.abs(canal.metres / 1000 / canal.hours - 30) < 1e-6);
});

test('a link by rail or by water that cannot be routed says why, naming its sites', async () => {
    const { modeLegProblem } = await import('../../packages/toolbox/lib/modes.mjs');
    assert.equal(modeLegProblem({ problem: 'far', end: 'to', kilometres: 6.34 }, 'water', 'Quarry', 'Basel'), 'Basel is 6.3 km from the navigable waterway: a link by water reaches sites within 2 km of it. Place a site at the navigable waterway (an inland port) and link it to Basel by road.');
    assert.equal(modeLegProblem({ problem: 'far', end: 'from', kilometres: null }, 'rail', 'Mill', 'Yard'), 'Mill is more than 15 km from any railway loaded, so Mill → Yard cannot go by rail.');
    assert.equal(modeLegProblem({ problem: 'apart' }, 'rail', 'Mill', 'Yard'), 'No railway loaded joins Mill and Yard: the lines at the two ends do not meet in the area loaded.');
    assert.equal(modeLegProblem({ problem: 'none' }, 'water', 'Quarry', 'Basel'), 'No navigable waterway is loaded for this area, so Quarry → Basel cannot go by water: load the area again to fetch the waterways.');
});
