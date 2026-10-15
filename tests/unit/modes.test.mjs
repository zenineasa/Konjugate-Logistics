/* Copyright © 2026 Zenin Easa Panthakkalakath */

// How a link carries goods (road, rail or water), what is read of railways, waterways and water, and the graphs rail and
// water links are routed over.

import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleRings, buildLineGraph, freightClass, isFreightRail, isRunningLine, laneEnds, laneName, linkMode, modeProblem, modes, waterOf } from '../../packages/toolbox/lib/modes.mjs';
import { createPin, networkProblems, routeLinks } from '../../packages/toolbox/lib/network.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { defaultCatalogue, withModeType } from '../../packages/toolbox/lib/vehicles.mjs';
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
    assert.equal(isFreightRail({ railway: 'rail', service: 'yard' }), true, 'routed over: a branch may join the line only through a yard');
    assert.equal(isRunningLine({ railway: 'rail', service: 'yard' }), false, 'but not drawn');
    assert.equal(isRunningLine({ railway: 'rail', usage: 'industrial' }), true);
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
    assert.equal(rail.mainVertices.length, 5, 'both lines, though they do not meet, and the siding');
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

test('an industrial branch joined to the main line only through sidings is routed over them: a site beside it reaches one beside the main line', () => {
    // As in the Vedeggio valley by Lugano (15 October 2026): an industrial line, a siding and a crossover between it and
    // the main line, and the main line south.
    const at = (lat, lon) => ({ lat, lon });
    const features = readOverpass({ elements: [
        { type: 'way', id: 1, tags: { railway: 'rail', usage: 'industrial' }, nodes: [1, 2], geometry: [at(46.05, 8.92), at(46.04, 8.92)] },
        { type: 'way', id: 2, tags: { railway: 'rail', service: 'siding' }, nodes: [2, 3], geometry: [at(46.04, 8.92), at(46.035, 8.925)] },
        { type: 'way', id: 3, tags: { railway: 'rail', service: 'crossover' }, nodes: [3, 4], geometry: [at(46.035, 8.925), at(46.034, 8.93)] },
        { type: 'way', id: 4, tags: { railway: 'rail', usage: 'main' }, nodes: [5, 4, 6], geometry: [at(46.06, 8.93), at(46.034, 8.93), at(45.95, 8.95)] }
    ] });
    const router = createNetworkRouter(compactRoadGraph(buildLineGraph(features, 'rail'), { tolerance: 25 }));
    const along = router.routeAlong(at(46.048, 8.921), at(45.96, 8.951), modes.rail.reach);
    assert.ok(along.leg && along.leg.kilometres > 10 && along.leg.kilometres < 14, JSON.stringify(along).slice(0, 200));
});

test('a mode loaded with none of it in the area says so, and not to load the area again', async () => {
    const { modeLegProblem } = await import('../../packages/toolbox/lib/modes.mjs');
    const pins = [];
    const add = (role, point, name) => { const pin = createPin(role, point, { pins, name }); pins.push(pin); return pin; };
    const mill = add('supplier', { lat: 46, lon: 9 }, 'Mill');
    const depot = add('warehouse', { lat: 46.1, lon: 9 }, 'Depot');
    const links = [{ id: `${mill.id}>${depot.id}`, from: mill.id, to: depot.id, basis: 'user', mode: 'water' }];
    const road = createNetworkRouter(null);
    routeLinks(pins, links, road, { water: null });
    assert.deepEqual(links[0].leg, { problem: 'empty' });
    assert.equal(modeLegProblem(links[0].leg, 'water', 'Mill', 'Depot'), 'No waterway in the area loaded is marked as navigable for freight (by its CEMT class, or for ships), so Mill → Depot cannot go by water.');
    assert.match(networkProblems(pins, links, withModeType(defaultCatalogue(), 'water')).map((problem) => problem.text).join(' '), /No waterway in the area loaded is marked as navigable/);
    // Not loaded at all: loading again would help.
    delete links[0].ends;
    routeLinks(pins, links, road, {});
    assert.match(modeLegProblem(links[0].leg, 'water', 'Mill', 'Depot'), /load the area again/);
});
