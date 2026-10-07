/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs a network placed as the window places it, with its vehicle catalogue and its three product categories (ambient,
// chilled and frozen: two suppliers, one of chilled goods alone, two warehouses, six stores and a dark store on an
// invented city grid), through the engine:
//   - baseline: every category's copy of the network holds still, its suppliers making to order over their lead times
//   - the chilled supplier short for ten days: a store runs out of chilled goods while its ambient goods stay in stock,
//     and everything ordered from the supplier is made in the end
//   - the same supplier three days late instead: the store's chilled goods run down and come back
//   - the general supplier short of ambient goods, its warehouses waiting or ordering from the other supplier of them:
//     ordering elsewhere keeps the stores stocked
//   - the refrigerated vans to a big store cut: its chilled goods run short while its ambient goods, which also go by
//     the link's trucks, do not
// All must conserve goods (in each category on its own), vehicles and the order books.
// And a network of one category builds the model a network with none does.
//
// Usage: node tests/engine/categoryNetwork.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCategory, defaultCategoryCatalogue, setLeadDays, setMix } from '../../packages/toolbox/lib/categories.mjs';
import { createPin, networkSelection, routeLinks, suggestLinks } from '../../packages/toolbox/lib/network.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { buildRoadGraph } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { fleetPlan, supplierPlan } from '../../packages/toolbox/lib/scenarios.mjs';
import { createVehicle, defaultCatalogue } from '../../packages/toolbox/lib/vehicles.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { gridRoads } from '../fixtures/roadGrid.mjs';
import { checkInvariants, checkSteady, day, hour, runDocument } from './harness.mjs';

const directory = await mkdtemp(join(tmpdir(), 'konjugateLogisticsCategories-'));
const templates = await loadTemplates();
const grid = gridRoads({ size: 40, spacing: 400 });
const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(grid.features)));
const catalogue = defaultCatalogue();
catalogue.push(createVehicle({ id: 'refrigeratedVan', name: 'Refrigerated van', capacity: 1, costPerKm: 0.6, costPerDay: 50, speed: 50, loadingHours: 0.25, toStores: true, refrigerated: true }, catalogue));
const categories = defaultCategoryCatalogue();
const pins = [];
const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
// A general supplier of ambient and frozen goods, and a dairy of chilled goods alone, with a lead time of its own.
const general = add('supplier', grid.at(1, 1), { name: 'General supplier', fields: { supply: 90 } });
setMix(general, 'chilled', 0, categories);
const dairy = add('supplier', grid.at(38, 2), { name: 'Dairy', fields: { supply: 30 } });
setMix(dairy, 'ambient', 0, categories);
setMix(dairy, 'frozen', 0, categories);
setLeadDays(dairy, 'chilled', 0.5);
// And a second supplier of ambient goods alone, with room to make far more than is ordered from it.
const second = add('supplier', grid.at(20, 1), { name: 'Second supplier', fields: { supply: 20, makes: 120 } });
setMix(second, 'chilled', 0, categories);
setMix(second, 'frozen', 0, categories);
const first = add('warehouse', grid.at(10, 10), { fields: { capacity: 400 } });
add('warehouse', grid.at(28, 26));
// The first store is a big one, selling 60 pallets a day.
for (const [index, [x, y]] of [[5, 14], [12, 4], [16, 12], [26, 30], [33, 22], [22, 34]].entries()) add('store', grid.at(x, y), { fields: { demand: index ? 15 : 60 } });
add('darkStore', grid.at(20, 20), { fields: { demand: 10 } });
const links = suggestLinks(pins, [], router);
routeLinks(pins, links, router);
const stores = pins.filter((pin) => pin.role === 'store');
// Its link runs on medium trucks and refrigerated vans: its chilled and frozen goods go by the vans alone.
links.find((link) => link.to === stores[0].id).vehicles = [{ type: 'mediumTruck', fleet: null }, { type: 'refrigeratedVan', fleet: null }];
const network = networkSelection(pins, links, { catalogue, categories });
const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
const selection = Object.fromEntries(Object.entries(network.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));

function build(change = () => {}, options = {}) {
    const builder = new ModelBuilder(templates);
    const built = buildRegionModel({ builder, selection, route: router.route, links: network.links, options: { vehicles: network.vehicles, unit: network.unit, categories: network.categories, ...options } });
    change(builder, built);
    return { built, document: builder.document({ days: 40, stepDays: 15 / 1440, outputDays: 1 / 24 }) };
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
    // ---- one category is the network as it was: the same model, node for node.
    const one = [createCategory({ id: 'goods', name: 'Goods', share: 100, leadDays: 2 })];
    const plainNetwork = networkSelection(pins.map((pin) => ({ ...pin, mix: undefined, leadDays: undefined })), links, { catalogue, categories: one });
    const plainSelection = Object.fromEntries(Object.entries(plainNetwork.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));
    const modelOf = (options) => {
        const builder = new ModelBuilder(templates);
        const built = buildRegionModel({ builder, selection: plainSelection, route: router.route, links: plainNetwork.links, options: { vehicles: plainNetwork.vehicles, unit: plainNetwork.unit, ...options } });
        return { built, document: builder.document({ days: 40, stepDays: 15 / 1440, outputDays: 1 / 24 }) };
    };
    const single = modelOf({ categories: plainNetwork.categories });
    const none = modelOf({});
    assert.deepEqual(single.document, none.document, 'a network of one category is the network with none, node for node');
    assert.deepEqual(single.built.categories, [{ id: 'goods', name: 'Goods', chilled: false }]);
    assert.equal(none.built.categories, null);

    const { built, document } = build();
    assert.deepEqual(built.categories.map((category) => category.name), ['Ambient', 'Chilled', 'Frozen']);
    const nodeNames = new Set(document.nodes.map((node) => node.name));
    // Each category is a copy of the sites that carry it: the dairy has chilled goods alone, the general supplier none.
    assert.ok(nodeNames.has('Dairy: Chilled') && !nodeNames.has('Dairy: Ambient') && !nodeNames.has('General supplier: Chilled') && nodeNames.has('General supplier: Frozen'));
    for (const pin of stores) for (const category of built.categories) assert.ok(nodeNames.has(`${pin.name} stock: ${category.name}`) && nodeNames.has(`${pin.name}: ${category.name}`), `${pin.name} holds and sells ${category.name}.`);
    // A store's sales are shared by the categories' usual shares; the dairy's lead time is its own, the rest their category's.
    const storeOf = (pin, category) => built.stores.find((item) => item.site === pin.name && item.category === category);
    assert.ok(Math.abs(storeOf(stores[0], 'frozen').demand / storeOf(stores[1], 'frozen').demand - 60 / 15) < 1e-9);
    assert.ok(storeOf(stores[1], 'ambient').demand > storeOf(stores[1], 'chilled').demand && storeOf(stores[1], 'chilled').demand > storeOf(stores[1], 'frozen').demand);
    const lead = (name) => built.ports.find((port) => port.name === name).leadDays;
    assert.deepEqual([lead('Dairy: Chilled'), lead('General supplier: Ambient'), lead('General supplier: Frozen')], [0.5, 3, 5]);
    // Chilled and frozen goods go by refrigerated vehicles, ambient goods by the link's usual ones; a type is one set of
    // parameters across the categories.
    for (const lane of built.lanes) {
        const cold = built.categories.find((category) => category.id === lane.category).chilled;
        const refrigerated = (item) => catalogue.find((type) => type.id === item.type).refrigerated;
        assert.equal(lane.vehicles.every(refrigerated), cold, `${lane.name} runs on ${lane.vehicles.map((item) => item.name).join(' and ')}.`);
    }
    assert.equal(document.sharedParameters.filter((shared) => shared.symbol === 'refrigeratedTruckCapacity').length, 1);
    // A link's vehicles of a type are counted once, in whole vehicles, and shared among the categories that go by them:
    // the big store's vans among all three (its ambient goods go by its trucks and its vans alike).
    const toFirst = built.lanes.filter((lane) => lane.kind === 'store' && lane.site === stores[0].name);
    assert.equal(toFirst.length, 3, 'a link is a lane for each category it carries');
    assert.deepEqual(toFirst.map((lane) => lane.vehicles.map((item) => item.type).join()), ['mediumTruck,refrigeratedVan', 'refrigeratedVan', 'refrigeratedVan']);
    const vans = toFirst.flatMap((lane) => lane.vehicles).filter((item) => item.type === 'refrigeratedVan').reduce((sum, item) => sum + item.fleet, 0);
    assert.ok(Math.abs(vans - Math.round(vans)) < 1e-9 && vans >= 3, `the link has a whole number of refrigerated vans (${vans}).`);
    // A warehouse's room is shared among the categories by what it handles of each.
    const roomOf = (category) => document.sharedParameters.find((shared) => shared.id === built.parameterIndex.find((entry) => entry.entity === `${first.name}: ${category}` && entry.key === 'storageCapacity').sharedParameterId).value;
    assert.ok(Math.abs(roomOf('Ambient') + roomOf('Chilled') + roomOf('Frozen') - 400) < 1e-9, 'the categories share the warehouse\'s 400 pallets of room');
    assert.ok(built.provenance.some((item) => item.entity === 'Dairy: Chilled' && item.parameter === 'Lead time' && item.basis === 'user'));
    assert.ok(built.provenance.some((item) => item.entity === 'General supplier: Frozen' && item.parameter === 'Lead time' && item.basis === 'assumed'));

    const baseline = await runDocument(directory, 'categories-baseline', document, 40);
    assert.equal(checkInvariants(baseline).parts, 3, 'each category is a part of the model on its own, its goods conserved');
    checkSteady(baseline);
    const at = (result, key, time) => result.series(key)[hour(time)];
    const window = { start: 5 * day, duration: 10 * day, forkAt: 0, runTime: 40 * day };
    // A supplier makes to order: what it is making is its lead time's worth of what is ordered from it.
    const making = (result, supplier, time) => ['making1', 'making2', 'making3'].reduce((sum, stage) => sum + at(result, `${supplier}.${stage}`, time), 0);
    const frozen = built.ports.find((port) => port.name === 'General supplier: Frozen');
    assert.ok(Math.abs(making(baseline, frozen.name, 20) - frozen.arrivals * 5) < 1e-6, 'five days of frozen goods are in production');

    // ---- the dairy makes a fifth of what it does for ten days: stores run out of chilled goods, not of ambient ones.
    const dairyNode = built.ports.find((port) => port.name === 'Dairy: Chilled');
    const suppliers = built.ports.filter((port) => port.supplier);
    const shortPlan = supplierPlan({ lanes: built.lanes, suppliers, chosen: [dairyNode.name], short: 0.8, ...window });
    assert.ok(Math.abs(shortPlan.shortPerDay - 0.8 * dairyNode.arrivals) < 1e-9);
    const short = build(follow(shortPlan.supplied));
    const shortRun = await runDocument(directory, 'categories-short', short.document, 40);
    checkInvariants(shortRun);
    const store = stores[1];
    const stock = (result, category, time, site = store) => at(result, `${site.name} stock: ${category}`, time);
    const lowest = Math.min(...shortRun.series(`${store.name} stock: Chilled.stock`));
    assert.ok(lowest < 0.05 * stock(baseline, 'Chilled.stock', 0), `short: ${store.name} runs out of chilled goods (${lowest.toFixed(2)} pallets at its lowest).`);
    assert.ok(Math.min(...shortRun.series(`${store.name} stock: Ambient.stock`)) > 0.99 * stock(baseline, 'Ambient.stock', 0), `short: ${store.name} keeps its ambient goods.`);
    const lost = (result, category) => result.series(`${store.name}: ${category}.lost`).at(-1);
    assert.ok(lost(shortRun, 'Chilled') > 1 && lost(shortRun, 'Ambient') < 1e-6 && lost(shortRun, 'Frozen') < 1e-6, 'short: it loses sales of chilled goods alone.');
    // Orders it could not start waited, and were made once it could: nothing ordered is dropped.
    const waiting = shortRun.series(`${dairyNode.name}.toMake`);
    assert.ok(Math.max(...waiting) > 5 * waiting[0], `short: orders wait at the dairy (${Math.max(...waiting).toFixed(1)} pallets at most).`);
    assert.ok(Math.abs(waiting.at(-1) - waiting[0]) < 0.05 * waiting[0], `short: every order is made in the end (${waiting.at(-1).toFixed(2)} waiting against ${waiting[0].toFixed(2)}).`);
    const recovered = stock(shortRun, 'Chilled.stock', 40);
    assert.ok(recovered > 0.9 * stock(baseline, 'Chilled.stock', 40), `short: ${store.name}'s chilled goods are back (${recovered.toFixed(2)} pallets).`);

    // ---- the dairy late instead. Three days late (its orders take three and a half days, not half a day): what was in
    // production is held up, and the warehouse's three days of cover take it, running nearly out while the store holds.
    // A week late, the store runs down too. Either way the goods are back once the lead time is its own again.
    const lateBy = async (lateDays) => {
        const run = await runDocument(directory, `categories-late${lateDays}`, build(follow(supplierPlan({ lanes: built.lanes, suppliers, chosen: [dairyNode.name], lateDays, ...window }).supplied)).document, 40);
        checkInvariants(run);
        return run;
    };
    const itsWarehouse = built.lanes.find((lane) => lane.kind === 'store' && lane.site === store.name && lane.category === 'chilled').from;
    const lowestOf = (run, key) => Math.min(...run.series(key)) / run.series(key)[0];
    const lateRun = await lateBy(3);
    assert.ok(lowestOf(lateRun, `${itsWarehouse}.stock`) < 0.4, `late: ${itsWarehouse} runs down (${(100 * lowestOf(lateRun, `${itsWarehouse}.stock`)).toFixed(0)}% of its stock at the lowest).`);
    assert.ok(lowestOf(lateRun, `${store.name} stock: Chilled.stock`) > 0.9, `late: its cover takes three days, so ${store.name} holds.`);
    const weekLate = await lateBy(7);
    const lateLow = lowestOf(weekLate, `${store.name} stock: Chilled.stock`);
    assert.ok(lateLow < 0.75 && lateLow < lowestOf(lateRun, `${store.name} stock: Chilled.stock`) - 0.2, `a week late: ${store.name}'s chilled goods run down (${(100 * lateLow).toFixed(0)}% of its stock at the lowest).`);
    for (const run of [lateRun, weekLate]) {
        assert.ok(stock(run, 'Chilled.stock', 40) > 0.9 * stock(baseline, 'Chilled.stock', 40), 'late: the chilled goods are back by the end.');
        assert.ok(lowestOf(run, `${store.name} stock: Ambient.stock`) > 0.99, 'late: its ambient goods are untouched.');
    }

    // ---- the general supplier makes a fifth of the ambient goods ordered from it. Its warehouses wait, and the stores
    // run down; or they order what it cannot make from the second supplier, which has room to make it, and the stores hold.
    const general = built.ports.find((port) => port.name === 'General supplier: Ambient');
    const other = built.ports.find((port) => port.name === 'Second supplier: Ambient');
    const lowestAmbient = (result) => Math.min(...stores.map((pin) => Math.min(...result.series(`${pin.name} stock: Ambient.stock`)) / result.series(`${pin.name} stock: Ambient.stock`)[0]));
    const waitRun = await runDocument(directory, 'categories-wait', build(follow(supplierPlan({ lanes: built.lanes, suppliers, chosen: [general.name], short: 0.8, mode: 'wait', ...window }).supplied)).document, 40);
    checkInvariants(waitRun);
    const elsewherePlan = supplierPlan({ lanes: built.lanes, suppliers, chosen: [general.name], short: 0.8, mode: 'otherSuppliers', ...window });
    assert.ok(elsewherePlan.reroutedTo.length && elsewherePlan.reroutedTo.every((lane) => /^Road Second supplier → .*: Ambient$/.test(lane)) && !elsewherePlan.waiting.length);
    const elsewhereRun = await runDocument(directory, 'categories-elsewhere', build(follow(elsewherePlan.supplied)).document, 40);
    checkInvariants(elsewhereRun);
    assert.ok(lowestAmbient(waitRun) < 0.2, `waiting: a store all but runs out of ambient goods (${(100 * lowestAmbient(waitRun)).toFixed(0)}% of its stock at the lowest).`);
    assert.ok(lowestAmbient(elsewhereRun) > 0.6, `ordering elsewhere: every store keeps most of its ambient goods (${(100 * lowestAmbient(elsewhereRun)).toFixed(0)}% at the lowest).`);
    const madeBy = (result) => result.series(`${other.name}.made`).at(-1);
    // What it makes more: the four fifths of the general supplier's ambient orders, for the ten days.
    const moved = 0.8 * general.arrivals * 10;
    assert.ok(Math.abs(madeBy(elsewhereRun) - madeBy(waitRun) - moved) < 0.1 * moved, `ordering elsewhere: the second supplier makes what the first cannot (${madeBy(elsewhereRun).toFixed(0)} pallets against ${madeBy(waitRun).toFixed(0)}).`);

    // ---- the big store's refrigerated vans for its chilled and frozen goods cut by nine in ten: those run short, its ambient goods do not.
    const big = stores[0];
    const cold = toFirst.filter((lane) => lane.category !== 'ambient');
    const cut = build(follow(fleetPlan({ lanes: cold, change: -0.9, ...window }).supplied));
    const cutRun = await runDocument(directory, 'categories-reefers', cut.document, 40);
    checkInvariants(cutRun, { fleetsChange: true });
    const chilledThen = stock(cutRun, 'Chilled.stock', 14, big);
    assert.ok(chilledThen < 0.75 * stock(baseline, 'Chilled.stock', 14, big), `vans: ${big.name}'s chilled goods run short (${chilledThen.toFixed(2)} against ${stock(baseline, 'Chilled.stock', 14, big).toFixed(2)}).`);
    assert.ok(stock(cutRun, 'Ambient.stock', 14, big) > 0.99 * stock(baseline, 'Ambient.stock', 14, big), `vans: ${big.name}'s ambient goods, with vehicles of their own, do not.`);

    // ---- a chilled category with no refrigerated vehicle to go by is refused, naming it.
    const warm = networkSelection(pins, links.map((link) => ({ ...link, vehicles: undefined })), { catalogue: catalogue.filter((type) => !type.refrigerated), categories });
    assert.throws(() => buildRegionModel({ builder: new ModelBuilder(templates), selection, route: router.route, links: warm.links, options: { vehicles: warm.vehicles, unit: warm.unit, categories: warm.categories } }),
        /Chilled: .* carries Chilled, which needs a refrigerated vehicle/);

    console.log(`✓ network with categories: ${document.nodes.length} nodes (${pins.length} pins, ${built.lanes.length} lanes, ${built.categories.length} categories, each conserved on its own) hold still; with the dairy short, ${store.name} runs out of chilled goods (${lost(shortRun, 'Chilled').toFixed(1)} pallets of sales lost) and keeps its ambient ones, and every order is made in the end; three days late its warehouse's cover takes it (down to ${(100 * lowestOf(lateRun, `${itsWarehouse}.stock`)).toFixed(0)}% of its stock) and a week late the store falls to ${(100 * lateLow).toFixed(0)}% of its own, both coming back; with the general supplier short of ambient goods the stores fall to ${(100 * lowestAmbient(waitRun)).toFixed(0)}% of their stock waiting for it and keep ${(100 * lowestAmbient(elsewhereRun)).toFixed(0)}% ordering from the second supplier; with a tenth of its refrigerated vans ${big.name}'s chilled goods fall to ${chilledThen.toFixed(1)} pallets (from ${stock(baseline, 'Chilled.stock', 14, big).toFixed(1)}) while its ambient goods hold; one category alone builds the network as it was; goods, vehicles and orders conserved.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
