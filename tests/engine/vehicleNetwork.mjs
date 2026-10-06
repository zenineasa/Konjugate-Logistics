/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs a network placed as the window places it, with its vehicle catalogue (two suppliers, two warehouses, eight
// stores, a dark store and a customer area on an invented city grid; heavy trucks to the warehouses, medium trucks,
// small trucks and mini-vans to the stores), through the engine:
//   - baseline: every stock, queue and rate holds still, in pallets, a store's stock room and a warehouse whose
//     storage capacity binds included
//   - the only lane to one store closed for ten days: that store runs out and its shoppers wait, while a store served
//     by the same warehouse keeps its stock
//   - a store's vans cut by three quarters: its deliveries fall behind and its stock runs down
//   - demand stepped up at the warehouse with little room: it orders no more than it has room for
// All must conserve goods and vehicles, and keep each stock room's and warehouse's on-order count equal to its lanes.
//
// Usage: node tests/engine/vehicleNetwork.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPin, networkSelection, routeLinks, suggestLinks } from '../../packages/toolbox/lib/network.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { buildRoadGraph } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { closurePlan, demandPlan, fleetPlan } from '../../packages/toolbox/lib/scenarios.mjs';
import { defaultCatalogue } from '../../packages/toolbox/lib/vehicles.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { gridRoads } from '../fixtures/roadGrid.mjs';
import { checkInvariants, checkSteady, day, hour, runDocument } from './harness.mjs';

const directory = await mkdtemp(join(tmpdir(), 'konjugateLogisticsVehicles-'));
const templates = await loadTemplates();
const grid = gridRoads({ size: 40, spacing: 400 });
const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(grid.features)));
const catalogue = defaultCatalogue();
const pins = [];
const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
add('supplier', grid.at(1, 1), { fields: { supply: 100 } });
add('supplier', grid.at(38, 2), { fields: { supply: 40 } });
// The first warehouse has room for little more than two days of what it sends out, less than its three days of cover.
const tight = add('warehouse', grid.at(10, 10), { fields: { capacity: 45 } });
add('warehouse', grid.at(28, 26));
// The third store is a big one, selling 60 pallets a day.
for (const [index, [x, y]] of [[5, 14], [12, 4], [16, 12], [8, 20], [26, 30], [33, 22], [22, 34], [30, 36]].entries()) add('store', grid.at(x, y), index === 2 ? { fields: { demand: 60 } } : {});
add('darkStore', grid.at(20, 20));
add('customerArea', grid.at(35, 35), { fields: { population: 40000 } });
const links = suggestLinks(pins, [], router);
routeLinks(pins, links, router);
// One store's link runs on two types: small trucks and mini-vans.
const store = (index) => pins.filter((pin) => pin.role === 'store')[index];
const mixed = links.find((link) => link.to === store(1).id);
mixed.vehicles = [{ type: 'smallTruck', fleet: null }, { type: 'miniVan', fleet: null }];
// And the big store's on vans alone.
const vanned = links.find((link) => link.to === store(2).id);
vanned.vehicles = [{ type: 'miniVan', fleet: null }];
const network = networkSelection(pins, links, { catalogue });
const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
const selection = Object.fromEntries(Object.entries(network.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));

// `uncapped`: the same network with no storage capacity at the first warehouse.
const uncappedSelection = { ...selection, zones: selection.zones.map((zone) => (zone.name === tight.name ? { ...zone, capacity: undefined, capacityBasis: undefined } : zone)) };
function build(change = () => {}, { uncapped = false } = {}) {
    const builder = new ModelBuilder(templates);
    const built = buildRegionModel({ builder, selection: uncapped ? uncappedSelection : selection, route: router.route, links: network.links, options: { vehicles: network.vehicles, unit: network.unit } });
    change(builder, built);
    return { built, document: builder.document({ days: 30, stepDays: 15 / 1440, outputDays: 1 / 24 }) };
}
const follow = (byParameter) => (builder, built) => {
    for (const [key, { entities, samples }] of Object.entries(byParameter)) {
        for (const entity of entities) {
            const indexed = built.parameterIndex.find((entry) => entry.key === key && entry.entity === entity);
            assert.ok(indexed?.live, `${key} of ${entity} must be live for a scenario to change it.`);
            builder.sharedParameters.find((item) => item.id === indexed.sharedParameterId).schedule = { interpolation: 'linear', samples: samples[entity] };
        }
    }
};

try {
    const plain = build();
    const { built, document } = plain;
    // Every store and dark store has a stock room, restocked over a lane of its own vehicles.
    const stocked = pins.filter((pin) => pin.role === 'store' || pin.role === 'darkStore');
    assert.deepEqual(built.stores.map((item) => item.name).sort(), stocked.map((pin) => pin.name).sort());
    for (const pin of stocked) assert.ok(document.nodes.some((node) => node.name === `${pin.name} stock` && node.type === 'Warehouse'), `${pin.name} has a stock room.`);
    assert.ok(built.lanes.some((lane) => lane.kind === 'store' && lane.to === `${store(1).name} stock` && lane.vehicles.map((item) => item.type).join() === 'smallTruck,miniVan'));
    // A type is one set of parameters for every lane it runs on, in pallets.
    const capacity = document.sharedParameters.filter((shared) => shared.symbol === 'miniVanCapacity');
    assert.equal(capacity.length, 1, 'one mini-van capacity for the model');
    assert.equal(capacity[0].unit, 'pallets/vehicle');
    assert.ok(document.nodes.find((node) => node.name === tight.name).states.find((item) => item.symbol === 'stock').unit === 'pallets');
    assert.ok(built.warnings.some((text) => text.startsWith(`${tight.name} has room for 45 pallets`)), `the warehouse with little room says so: ${built.warnings.join(' / ')}`);

    const baseline = await runDocument(directory, 'vehicles-baseline', document, 30);
    checkInvariants(baseline);
    checkSteady(baseline);
    assert.ok(Math.abs(baseline.series(`${tight.name}.stock`)[0] - 45) < 1e-9, 'the warehouse holds what it has room for');
    const window = { start: 5 * day, duration: 10 * day, forkAt: 0, runTime: 30 * day };

    // The only lane to the first store closed for ten days: it runs out; a store served by the same warehouse does not.
    const first = store(0);
    const lane = built.lanes.find((item) => item.kind === 'store' && item.site === first.name);
    assert.equal(built.lanes.filter((item) => item.site === first.name).length, 1, 'the first store has one warehouse');
    const neighbour = built.lanes.find((item) => item.kind === 'store' && item.from === lane.from && item.site !== first.name);
    const closed = await runDocument(directory, 'vehicles-closure', build(follow(closurePlan({ lanes: built.lanes, closed: lane.name, mode: 'wait', ...window }).supplied)).document, 30);
    checkInvariants(closed);
    const at = (result, key, time) => result.series(key)[hour(time)];
    assert.ok(at(closed, `${first.name} stock.stock`, 14) < 0.05 * at(baseline, `${first.name} stock.stock`, 14), `closure: ${first.name} runs out (${at(closed, `${first.name} stock.stock`, 14).toFixed(2)} pallets on day 14).`);
    assert.ok(at(closed, `${first.name}.backlog`, 14) > 5 * at(baseline, `${first.name}.backlog`, 14), `closure: ${first.name}'s shoppers wait.`);
    assert.ok(at(closed, `${neighbour.to}.stock`, 14) > 0.9 * at(baseline, `${neighbour.to}.stock`, 14), `closure: ${neighbour.site} keeps its stock.`);

    // The big store's mini-vans cut by three quarters: its deliveries fall behind and its stock runs down.
    const vanLane = built.lanes.find((item) => item.kind === 'store' && item.site === store(2).name && item.vehicles[0].type === 'miniVan');
    const cut = await runDocument(directory, 'vehicles-vans', build(follow(fleetPlan({ lanes: [vanLane], change: -0.75, ...window }).supplied)).document, 30);
    checkInvariants(cut, { fleetsChange: true });
    assert.ok(at(cut, `${vanLane.name}.arriving`, 14) < 0.9 * vanLane.rate, `vans: ${vanLane.name} carries less (${at(cut, `${vanLane.name}.arriving`, 14).toFixed(2)} against ${vanLane.rate.toFixed(2)}).`);
    assert.ok(at(cut, `${vanLane.to}.stock`, 14) < 0.75 * at(baseline, `${vanLane.to}.stock`, 14), `vans: ${store(2).name}'s stock runs down (${at(cut, `${vanLane.to}.stock`, 14).toFixed(1)} against ${at(baseline, `${vanLane.to}.stock`, 14).toFixed(1)}).`);

    // Demand up by half at every store the tight warehouse serves: it never orders more than it has room for.
    const itsTowns = built.towns.filter((town) => built.served.some((item) => item.town === town.name && item.zone === tight.name));
    const surge = demandPlan({ towns: itsTowns, change: 0.5, ...window }).supplied;
    const surged = await runDocument(directory, 'vehicles-surge', build(follow(surge)).document, 30);
    checkInvariants(surged);
    const free = await runDocument(directory, 'vehicles-surge-uncapped', build(follow(surge), { uncapped: true }).document, 30);
    checkInvariants(free);
    const stockOf = (result) => result.series(`${tight.name}.stock`);
    const most = Math.max(...stockOf(surged));
    assert.ok(Math.max(...stockOf(surged).slice(0, hour(12))) <= 45 * 1.001, `surge: ${tight.name} holds no more than its 45 pallets while it catches up.`);
    assert.ok(most < 0.6 * Math.max(...stockOf(free)), `surge: with its capacity it orders less, so holds less (${most.toFixed(1)} against ${Math.max(...stockOf(free)).toFixed(1)} with no limit).`);
    // Goods it ordered before its forecast came down still arrive: it overflows, and its space used says so.
    const used = surged.series(`${tight.name}.spaceUsed`);
    assert.ok(stockOf(surged).every((value, index) => Math.abs(used[index] - value / 45) < 1e-6), 'space used is its stock over its capacity.');

    console.log(`✓ network with vehicles: ${document.nodes.length} nodes (${pins.length} pins, ${built.lanes.length} lanes, ${built.stores.length} stores with stock) hold still in pallets; closing ${lane.name.replace(/^Road /, '')} empties ${first.name} while ${neighbour.site} keeps its stock; a quarter of the vans runs ${store(2).name} down to ${at(cut, `${vanLane.to}.stock`, 14).toFixed(0)} pallets; ${tight.name}, with room for 45 pallets, holds at most ${most.toFixed(0)} under a surge (${Math.max(...stockOf(free)).toFixed(0)} with no limit); goods, vehicles and orders conserved.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
