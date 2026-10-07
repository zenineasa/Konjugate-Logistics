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
//   - a store closed for ten days: it sells nothing and keeps its stock, four in five of its sales lost and the rest
//     waiting; and the second warehouse down: its stores run out, but one that the first warehouse also restocks keeps
//     more of its stock when it orders there
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
import { closurePlan, demandPlan, fleetPlan, siteDownPlan } from '../../packages/toolbox/lib/scenarios.mjs';
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
// The sixth store is restocked from both warehouses: links of the user's own.
const both = pins.filter((pin) => pin.role === 'store')[5];
const drawn = pins.filter((pin) => pin.role === 'warehouse').map((warehouse) => ({ id: `${warehouse.id}>${both.id}`, from: warehouse.id, to: both.id, basis: 'user' }));
const links = suggestLinks(pins, drawn, router);
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
    // Stores lose four sales in five they cannot make, dark stores one in two: one figure for each, unless a store has its own.
    const lostShares = Object.fromEntries(document.sharedParameters.filter((shared) => /LostShare$/.test(shared.symbol)).map((shared) => [shared.symbol, shared.value]));
    assert.deepEqual(lostShares, { storeLostShare: 0.8, darkStoreLostShare: 0.5 });
    assert.deepEqual(built.stores.map((item) => item.lostShare).sort(), [0.5, ...Array(8).fill(0.8)]);
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
    // Of the sales its shelves cannot make, four in five are lost (a store's default) and one waits: so it loses four
    // times what its queue grows by; the neighbour loses nothing.
    const lostThen = at(closed, `${first.name}.lost`, 14);
    const waiting = at(closed, `${first.name}.backlog`, 14) - at(baseline, `${first.name}.backlog`, 14);
    assert.ok(Math.abs(lostThen / waiting - 4) < 0.25, `closure: ${first.name} loses four sales for each that waits (${lostThen.toFixed(1)} lost, ${waiting.toFixed(1)} waiting).`);
    assert.ok(at(baseline, `${first.name}.lost`, 30) < 1e-9 && at(closed, `${neighbour.site}.lost`, 30) < 1e-6, 'nothing is lost while the shelves are stocked.');
    const lostAll = closed.series(`${first.name}.lost`).at(-1);

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

    // ---- a store closed for ten days: nothing in, nothing sold. Its stock stays; of its ten days of sales four in five
    // are lost and the rest wait, and are sold once it opens again.
    const shut = store(3);
    const shutPlan = siteDownPlan({ lanes: built.lanes, deliveries: built.deliveries, nodes: [`${shut.name} stock`], ...window });
    assert.deepEqual(shutPlan.deliveries, [`${shut.name} sales`]);
    const shutRun = await runDocument(directory, 'vehicles-store-closed', build(follow(shutPlan.supplied)).document, 30);
    checkInvariants(shutRun);
    const sales = built.stores.find((item) => item.name === shut.name).demand;
    // (While it is closed: the shoppers who waited buy at once when it opens, and its shelves dip then.)
    const whileShut = shutRun.series(`${shut.name} stock.stock`).slice(hour(5), hour(15));
    assert.ok(Math.min(...whileShut) > 0.99 * at(baseline, `${shut.name} stock.stock`, 0), `closed: ${shut.name} keeps its stock while it is closed (${Math.min(...whileShut).toFixed(2)} pallets at the lowest).`);
    const lostShut = shutRun.series(`${shut.name}.lost`).at(-1);
    assert.ok(Math.abs(lostShut - 0.8 * sales * 10) < 0.02 * sales * 10, `closed: it loses four fifths of ten days of sales (${lostShut.toFixed(1)} of ${(sales * 10).toFixed(0)} pallets).`);
    assert.ok(at(shutRun, `${shut.name}.backlog`, 15) > at(baseline, `${shut.name}.backlog`, 15) + 0.15 * sales * 10, 'closed: the rest wait');
    assert.ok(at(shutRun, `${shut.name}.backlog`, 30) < at(baseline, `${shut.name}.backlog`, 30) + 0.02 * sales * 10, 'closed: and are served once it opens');
    assert.ok(shutRun.series(`${store(4).name}.lost`).at(-1) < 1e-6, 'closed: no other store loses a sale.');

    // ---- the second warehouse down for ten days. The sites it restocks wait: a store it alone restocks runs out. Or
    // they order from their other warehouse: the store both restock keeps more of its stock, though the first warehouse
    // has little room to send it more from.
    const [, secondWarehouse] = pins.filter((pin) => pin.role === 'warehouse');
    const alone = built.lanes.find((item) => item.kind === 'store' && item.from === secondWarehouse.name && built.lanes.filter((other) => other.to === item.to).length === 1);
    const lowestOf = (result, key) => Math.min(...result.series(key)) / result.series(key)[0];
    const downWait = siteDownPlan({ lanes: built.lanes, deliveries: built.deliveries, nodes: [secondWarehouse.name], mode: 'wait', ...window });
    assert.ok(downWait.waiting.includes(`${both.name} stock`) && !downWait.reroutedTo.length);
    const waitRun = await runDocument(directory, 'vehicles-warehouse-down', build(follow(downWait.supplied)).document, 30);
    checkInvariants(waitRun);
    assert.ok(lowestOf(waitRun, `${alone.to}.stock`) < 0.05, `down: ${alone.site} runs out (${(100 * lowestOf(waitRun, `${alone.to}.stock`)).toFixed(0)}% of its stock at the lowest).`);
    // Nothing went into the warehouse or out of it while it was down.
    const held = waitRun.series(`${secondWarehouse.name}.stock`);
    assert.ok(Math.abs(held[hour(14)] - held[hour(7)]) < 0.02 * held[0], `down: ${secondWarehouse.name}'s stock stands still (${held[hour(7)].toFixed(1)} then ${held[hour(14)].toFixed(1)}).`);
    const downElsewhere = siteDownPlan({ lanes: built.lanes, deliveries: built.deliveries, nodes: [secondWarehouse.name], mode: 'otherWarehouses', ...window });
    assert.deepEqual(downElsewhere.reroutedTo, [`Road ${tight.name} → ${both.name}`]);
    assert.ok(downElsewhere.waiting.includes(alone.to) && !downElsewhere.waiting.includes(`${both.name} stock`));
    const elsewhereRun = await runDocument(directory, 'vehicles-warehouse-down-elsewhere', build(follow(downElsewhere.supplied)).document, 30);
    checkInvariants(elsewhereRun);
    const [waited, ordered] = [waitRun, elsewhereRun].map((result) => lowestOf(result, `${both.name} stock.stock`));
    assert.ok(ordered > waited + 0.1, `down: ${both.name} keeps more of its stock ordering from ${tight.name} (${(100 * ordered).toFixed(0)}% at the lowest against ${(100 * waited).toFixed(0)}%).`);

    console.log(`✓ network with vehicles: ${document.nodes.length} nodes (${pins.length} pins, ${built.lanes.length} lanes, ${built.stores.length} stores with stock) hold still in pallets; closing ${lane.name.replace(/^Road /, '')} empties ${first.name} (${lostAll.toFixed(0)} pallets of sales lost) while ${neighbour.site} keeps its stock; a quarter of the vans runs ${store(2).name} down to ${at(cut, `${vanLane.to}.stock`, 14).toFixed(0)} pallets; ${tight.name}, with room for 45 pallets, holds at most ${most.toFixed(0)} under a surge (${Math.max(...stockOf(free)).toFixed(0)} with no limit); closed for ten days, ${shut.name} keeps its stock and loses ${lostShut.toFixed(0)} pallets of sales; with ${secondWarehouse.name} down ${alone.site} runs out, and ${both.name} keeps ${(100 * ordered).toFixed(0)}% of its stock ordering from ${tight.name} (${(100 * waited).toFixed(0)}% waiting); goods, vehicles and orders conserved.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
