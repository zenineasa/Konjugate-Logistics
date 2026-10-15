/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs a network whose links go by road, by rail and by water, placed as the window places them, through the engine:
// a quarry ships to a river port by barge along a river, a mill to a rail yard by train along a railway, and each
// warehouse restocks its store by road. The baseline holds still. Then the river runs low for ten days, a barge loading
// 40% of what it can carry:
//   - waiting, the barges carry what they can at 40% and the river port runs down on its cover (its store keeps its
//     stock: ten days short is less than the port's cover)
//   - hiring more barges, the lane carries what it did
// All must conserve goods and the order books, and vehicles where no fleet changes.
//
// Usage: node tests/engine/modeNetwork.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLineGraph } from '../../packages/toolbox/lib/modes.mjs';
import { createPin, networkProblems, networkSelection, routeLinks } from '../../packages/toolbox/lib/network.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { buildRoadGraph } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { lowWaterPlan } from '../../packages/toolbox/lib/scenarios.mjs';
import { defaultCatalogue, setVehicleField, withModeType } from '../../packages/toolbox/lib/vehicles.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { gridRoads } from '../fixtures/roadGrid.mjs';
import { checkInvariants, checkSteady, day, hour, runDocument } from './harness.mjs';

const directory = await mkdtemp(join(tmpdir(), 'konjugateLogisticsModes-'));
const templates = await loadTemplates();
const grid = gridRoads({ size: 40, spacing: 400 });
const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(grid.features)));
// A river 300 m north of the third row of roads, west to east across the grid, of a class barges take; a railway 300 m
// east of the twenty-first column, south to north.
const offset = (point, north, east) => ({ lat: point.lat + north / 111320, lon: point.lon + east / (111320 * Math.cos(point.lat * Math.PI / 180)) });
const line = (id, tags, points) => ({ osmType: 'way', osmId: id, tags, nodes: points.map((_, index) => id * 1000 + index), line: points, point: points[0] });
const river = line(900, { waterway: 'river', name: 'Broad River', CEMT: 'IV' }, Array.from({ length: 40 }, (_, column) => offset(grid.at(2, column), 300, 0)));
const railway = line(901, { railway: 'rail', usage: 'main' }, Array.from({ length: 40 }, (_, row) => offset(grid.at(row, 20), 0, 300)));
const lines = {
    water: createNetworkRouter(compactRoadGraph(buildLineGraph([river], 'water'), { tolerance: 25 })),
    rail: createNetworkRouter(compactRoadGraph(buildLineGraph([railway], 'rail'), { tolerance: 25 }))
};
// Barges of 20 pallets, the user's figure: small enough that the river's flow takes several, so a barge loading less
// shows (one barge of the 2,000 pallets assumed would carry this flow at a fraction of its capacity, low water or not).
const catalogue = withModeType(withModeType(defaultCatalogue(), 'rail'), 'water');
setVehicleField(catalogue.find((type) => type.id === 'barge'), 'capacity', '20');

const pins = [];
const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
const quarry = add('supplier', grid.at(2, 2), { name: 'Quarry', fields: { supply: 40 } });
const riverPort = add('warehouse', grid.at(2, 37), { name: 'River port' });
const mill = add('supplier', grid.at(5, 20), { name: 'Mill', fields: { supply: 30 } });
const railYard = add('warehouse', grid.at(35, 20), { name: 'Rail yard' });
const east = add('store', grid.at(8, 36), { name: 'East store', fields: { demand: 40 } });
const north = add('store', grid.at(37, 24), { name: 'North store', fields: { demand: 30 } });
const link = (from, to, more = {}) => ({ id: `${from.id}>${to.id}`, from: from.id, to: to.id, basis: 'user', ...more });
const links = [link(quarry, riverPort, { mode: 'water' }), link(mill, railYard, { mode: 'rail' }), link(riverPort, east), link(railYard, north)];
routeLinks(pins, links, router, lines);
assert.deepEqual(networkProblems(pins, links, catalogue).filter((problem) => problem.level === 'error'), []);
// Along the river and the railway, each end at the line: 14 km of river and 12 km of railway, about.
assert.ok(Math.abs(links[0].leg.kilometres - 14.4) < 1, `${links[0].leg.kilometres} km by water`);
assert.ok(Math.abs(links[1].leg.kilometres - 12.0) < 1, `${links[1].leg.kilometres} km by rail`);

const chosen = networkSelection(pins, links, { catalogue });
const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
const selection = Object.fromEntries(Object.entries(chosen.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));
const build = (change = () => {}) => {
    const builder = new ModelBuilder(templates);
    const built = buildRegionModel({ builder, selection, route: router.route, links: chosen.links, options: { vehicles: chosen.vehicles, unit: chosen.unit } });
    change(builder, built);
    return { built, document: builder.document({ days: 30, stepDays: 15 / 1440, outputDays: 1 / 24 }) };
};
const follow = (byParameter) => (builder, built) => {
    for (const [key, { entities, samples }] of Object.entries(byParameter)) {
        for (const entity of entities) {
            const indexed = built.parameterIndex.find((entry) => entry.key === key && entry.entity === entity);
            assert.ok(indexed?.live, `${key} of ${entity} must be live for a scenario to change it.`);
            builder.sharedParameters.find((item) => item.id === indexed.sharedParameterId).schedule = { interpolation: 'linear', samples: samples[entity] };
        }
    }
};
const window = { start: 5 * day, duration: 10 * day, forkAt: 0, runTime: 30 * day };

try {
    const { built, document } = build();
    const water = built.lanes.find((lane) => lane.name === 'Water Quarry → River port');
    const rail = built.lanes.find((lane) => lane.name === 'Rail Mill → Rail yard');
    assert.deepEqual([water?.mode, rail?.mode, built.lanes.find((lane) => lane.name === 'Road River port → East store')?.mode], ['water', 'rail', 'road']);
    assert.deepEqual([water.vehicles.map((item) => item.name), rail.vehicles.map((item) => item.name)], [['Barge'], ['Freight train']]);
    assert.ok(water.fleet >= 3, `several barges of 20 pallets for 40 a day (${water.fleet})`);
    // Its travel time at the barge's 12 km/h, its load share live for a scenario.
    const note = built.provenance.find((item) => item.entity === water.name && item.parameter === 'Travel time');
    assert.match(note.detail, /along the navigable waterway/);
    assert.ok(built.parameterIndex.find((entry) => entry.entity === water.name && entry.key === 'loadShare')?.live);
    assert.ok(!built.parameterIndex.find((entry) => entry.entity === 'Road River port → East store' && entry.key === 'loadShare')?.live, 'a road lane\'s is not');

    const baseline = await runDocument(directory, 'modes-baseline', document, 30);
    assert.equal(checkInvariants(baseline).parts, 2, 'two networks: the river\'s and the railway\'s');
    checkSteady(baseline);
    for (const [name, rate] of [[water.name, 40], [rail.name, 30]]) assert.ok(Math.abs(baseline.series(`${name}.arriving`)[hour(20)] - rate) < 1e-6, `${name} carries ${rate} a day`);

    // Low water: barges load 40% of what they can. Waiting, the river port receives less and its store runs down.
    const lowest = (result, key) => Math.min(...result.series(key).slice(hour(5), hour(16)));
    const waitPlan = lowWaterPlan({ lanes: built.lanes, chosen: [water.name], share: 0.4, mode: 'wait', ...window });
    const waitRun = await runDocument(directory, 'modes-low-wait', build(follow(waitPlan.supplied)).document, 30);
    checkInvariants(waitRun);
    const carriedLow = lowest(waitRun, `${water.name}.arriving`);
    // As much as its barges carry at 40%, each round trip taking the way there and back and a load: 3 barges of 8
    // pallets every 0.77 days, about 31 a day.
    const roundTrip = 2 * water.leadTime + water.loadDays;
    const canCarry = water.fleet * 20 * 0.4 / roundTrip;
    assert.ok(canCarry < 40 && Math.abs(carriedLow - canCarry) < 0.05 * canCarry, `in low water the barges carry what they can at 40% (${carriedLow.toFixed(1)} a day at the lowest; ${canCarry.toFixed(1)} expected)`);
    assert.ok(Math.abs(waitRun.series('Rail Mill → Rail yard.arriving')[hour(10)] - 30) < 1e-6, 'the railway is not affected');
    // The river port runs down on its cover, and so keeps its store stocked: ten days short of about 9 a day is less
    // than its three days of cover.
    const storeLow = lowest(waitRun, 'River port.stock') / waitRun.series('River port.stock')[0];
    assert.ok(storeLow < 0.8, `the river port runs down waiting (${(100 * storeLow).toFixed(0)}% of its stock at the lowest)`);
    const shelves = lowest(waitRun, 'East store stock.stock') / waitRun.series('East store stock.stock')[0];
    assert.ok(shelves > 0.95, `and East store keeps its stock (${(100 * shelves).toFixed(0)}% at the lowest)`);
    assert.ok(waitRun.series(`${water.name}.arriving`).at(-1) > 39, 'and the river carries all again once it rises');

    // More barges: as many as carry what the lane did at 40% each.
    const morePlan = lowWaterPlan({ lanes: built.lanes, chosen: [water.name], share: 0.4, mode: 'moreVehicles', ...window });
    const hired = morePlan.supplied.fleetSize.samples[water.name].find(([time]) => time === window.start)[1];
    assert.equal(hired, Math.ceil(water.fleet / 0.4));
    const moreRun = await runDocument(directory, 'modes-low-more', build(follow(morePlan.supplied)).document, 30);
    checkInvariants(moreRun, { fleetsChange: true });
    const storeMore = lowest(moreRun, 'River port.stock') / moreRun.series('River port.stock')[0];
    assert.ok(storeMore > storeLow + 0.05, `with ${hired} barges the river port keeps more of its stock (${(100 * storeMore).toFixed(0)}% at the lowest, against ${(100 * storeLow).toFixed(0)}% waiting)`);

    console.log(`✓ network by road, rail and water: a river port supplied by barge and a rail yard by train hold still in the baseline (two networks); with the river low for ten days and barges loading 40%, the river port receives ${carriedLow.toFixed(1)} pallets a day at the lowest (40 usually, ${canCarry.toFixed(1)} expected) and falls to ${(100 * storeLow).toFixed(0)}% of its stock, its store keeping ${(100 * shelves).toFixed(0)}% of its own, or to ${(100 * storeMore).toFixed(0)}% with ${hired} barges instead of ${water.fleet}; the railway carries its 30 a day throughout; goods, vehicles and orders conserved.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
