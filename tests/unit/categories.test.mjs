/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Product categories: the catalogue, a site's mix and a supplier's lead times, which vehicles carry chilled goods, the
// model built as a copy of the network for each category, and that model seen again by site and by link.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    categoriesForModel, categoriesProblem, clearMix, completeCategories, createCategory, defaultCategoryCatalogue, mixForModel, mixOf, mostCategories,
    setCategoryField, setLeadDays, setMix
} from '../../packages/toolbox/lib/categories.mjs';
import { affectedAcross, closureAcross, mergeSeries, mergeSupplied, siteView } from '../../packages/toolbox/lib/builtView.mjs';
import { createPin, networkProblems, networkSelection, routeLinks, suggestLinks } from '../../packages/toolbox/lib/network.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { buildRoadGraph } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { fleetPlan, siteDownPlan, supplierPlan } from '../../packages/toolbox/lib/scenarios.mjs';
import { carriersFor, defaultCatalogue } from '../../packages/toolbox/lib/vehicles.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { gridRoads } from '../fixtures/roadGrid.mjs';

test('the default catalogue is ambient, chilled and frozen goods, every figure assumed, the cold ones needing refrigerated vehicles', () => {
    const catalogue = defaultCategoryCatalogue();
    assert.deepEqual(catalogue.map((category) => [category.name, category.chilled]), [['Ambient', false], ['Chilled', true], ['Frozen', true]]);
    assert.ok(catalogue.every((category) => Object.values(category.fields).every((field) => field.basis === 'assumed' && field.value > 0)));
    assert.equal(categoriesProblem(catalogue), null);
    assert.deepEqual(categoriesForModel(catalogue)[1], { id: 'chilled', name: 'Chilled', chilled: true, share: 25, leadDays: 1, basis: { share: 'assumed', leadDays: 'assumed' } });
});

test('a category\'s figure changed is the user\'s, cleared the default again; a catalogue with a gap is refused with the reason', () => {
    const catalogue = defaultCategoryCatalogue();
    setCategoryField(catalogue[2], 'leadDays', '7');
    assert.deepEqual(catalogue[2].fields.leadDays, { value: 7, basis: 'user' });
    setCategoryField(catalogue[2], 'leadDays', '');
    assert.deepEqual(catalogue[2].fields.leadDays, { value: 5, basis: 'assumed' });
    const added = createCategory({}, catalogue);
    assert.deepEqual([added.id, added.name, added.chilled], ['category1', 'Category 1', false]);
    assert.equal(categoriesProblem([]), 'A network carries at least one category.');
    assert.match(categoriesProblem([...catalogue, { ...added, name: ' ' }]), /needs a name/);
    assert.match(categoriesProblem([...catalogue, { ...added, name: 'chilled' }]), /Two categories are named chilled/);
    assert.match(categoriesProblem(Array.from({ length: mostCategories + 1 }, (_, index) => createCategory({ name: `Kind ${index}` }, []))), /at most 6 categories/);
    // A session from before categories gets the defaults; a saved one keeps its figures and gets any it lacks.
    assert.deepEqual(completeCategories(undefined).map((category) => category.id), ['ambient', 'chilled', 'frozen']);
    const saved = structuredClone(catalogue);
    setCategoryField(saved[0], 'share', '70');
    delete saved[0].fields.leadDays;
    const restored = completeCategories(saved);
    assert.deepEqual(restored[0].fields, { share: { value: 70, basis: 'user' }, leadDays: { value: 3, basis: 'assumed' } });
});

test('a site carries the categories in their usual shares until it has a mix of its own; the last category cannot be taken off', () => {
    const catalogue = defaultCategoryCatalogue();
    const store = createPin('store', { lat: 0, lon: 0 });
    assert.deepEqual(mixOf(store, catalogue).map((item) => [item.id, item.share, item.basis]), [['ambient', 0.6, 'assumed'], ['chilled', 0.25, 'assumed'], ['frozen', 0.15, 'assumed']]);
    assert.deepEqual(mixForModel(store, catalogue), {}, 'the usual shares are the model\'s to apply');
    // Frozen taken off: the others keep the shares they had, weighed against each other.
    assert.equal(setMix(store, 'frozen', '0', catalogue), true);
    assert.deepEqual(store.mix, { ambient: 60, chilled: 25, frozen: 0 });
    const mix = mixOf(store, catalogue);
    assert.ok(Math.abs(mix[0].share - 60 / 85) < 1e-12 && mix[2].share === 0 && mix[0].basis === 'user');
    assert.deepEqual(mixForModel(store, catalogue), { mix: { ambient: 60, chilled: 25, frozen: 0 } });
    assert.equal(setMix(store, 'ambient', '0', catalogue), true);
    assert.equal(setMix(store, 'chilled', '0', catalogue), false, 'a site carries at least one category');
    assert.deepEqual(store.mix, { ambient: 0, chilled: 25, frozen: 0 });
    clearMix(store);
    assert.equal(mixOf(store, catalogue)[0].basis, 'assumed');
    // A supplier's own lead time for a category goes to the model; cleared, it is the category's again. A store has none.
    const supplier = createPin('supplier', { lat: 0, lon: 0 });
    setLeadDays(supplier, 'chilled', '0.5');
    assert.deepEqual(mixForModel(supplier, catalogue), { leadDaysBy: { chilled: { value: 0.5, basis: 'user' } } });
    setLeadDays(supplier, 'chilled', '');
    assert.equal(supplier.leadDays, undefined);
    setLeadDays(store, 'chilled', '2');
    assert.deepEqual(mixForModel(store, catalogue), {});
    // A category deleted from the catalogue: a mix that named it alone falls back to the usual shares.
    store.mix = { gone: 100 };
    assert.equal(mixOf(store, catalogue)[0].basis, 'assumed');
});

test('chilled goods go by a link\'s refrigerated vehicles, or by the first refrigerated type that may go there; other goods by all of them', () => {
    const catalogue = defaultCatalogue();
    const usual = [{ type: 'mediumTruck', fleet: 2 }];
    assert.deepEqual(carriersFor(usual, 'store', catalogue, false), usual);
    assert.deepEqual(carriersFor(usual, 'store', catalogue, true), [{ type: 'refrigeratedTruck', fleet: null }]);
    const both = [{ type: 'mediumTruck', fleet: null }, { type: 'refrigeratedTruck', fleet: 4 }];
    assert.deepEqual(carriersFor(both, 'store', catalogue, true), [{ type: 'refrigeratedTruck', fleet: 4 }]);
    // A refrigerated type kept off stores carries chilled goods to a warehouse, not to a store.
    catalogue.at(-1).toStores = false;
    assert.deepEqual(carriersFor(usual, 'supply', catalogue, true), [{ type: 'refrigeratedTruck', fleet: null }]);
    assert.deepEqual(carriersFor(usual, 'store', catalogue, true), []);
    const pins = [createPin('supplier', { lat: 0, lon: 0 }), createPin('warehouse', { lat: 0, lon: 0.1 }), createPin('store', { lat: 0, lon: 0.2 })];
    const links = [{ id: 'a', from: pins[0].id, to: pins[1].id, basis: 'user' }, { id: 'b', from: pins[1].id, to: pins[2].id, basis: 'user' }];
    const problems = networkProblems(pins, links, catalogue, defaultCategoryCatalogue()).map((problem) => problem.text);
    assert.deepEqual(problems, ['Chilled and Frozen need a refrigerated vehicle that may deliver to stores, and no vehicle type is one. Tick Refrigerated on a vehicle type, or add one.']);
    assert.deepEqual(networkProblems(pins, links, defaultCatalogue(), defaultCategoryCatalogue()), []);
    // With no chilled category, no refrigerated vehicle is needed.
    assert.deepEqual(networkProblems(pins, links, catalogue, defaultCategoryCatalogue().slice(0, 1)), []);
});

// A small network on an invented grid, built with the three categories.
const templates = await loadTemplates();
const grid = gridRoads({ size: 20, spacing: 400 });
const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(grid.features)));
function placed({ change = () => {} } = {}) {
    const catalogue = defaultCatalogue();
    const categories = defaultCategoryCatalogue();
    const pins = [];
    const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
    add('supplier', grid.at(1, 1), { fields: { supply: 40 } });
    add('warehouse', grid.at(8, 8), { fields: { capacity: 200 } });
    add('store', grid.at(12, 4), { fields: { demand: 30 } });
    add('store', grid.at(4, 14), { fields: { demand: 10 } });
    const links = suggestLinks(pins, [], router);
    routeLinks(pins, links, router);
    change({ pins, links, catalogue, categories });
    const network = networkSelection(pins, links, { catalogue, categories });
    const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
    const selection = Object.fromEntries(Object.entries(network.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));
    const builder = new ModelBuilder(templates);
    const built = buildRegionModel({ builder, selection, route: router.route, links: network.links, options: { vehicles: network.vehicles, unit: network.unit, categories: network.categories } });
    return { pins, links, built, document: built.document };
}

test('a network with categories is a copy of itself for each: named after both, its supply, sales, vehicles and room shared among them', () => {
    const { built, document } = placed({ change: ({ links, pins }) => { links.find((link) => link.to === pins[2].id).vehicles = [{ type: 'refrigeratedTruck', fleet: 4 }]; } });
    assert.deepEqual(built.categories, [{ id: 'ambient', name: 'Ambient', chilled: false }, { id: 'chilled', name: 'Chilled', chilled: true }, { id: 'frozen', name: 'Frozen', chilled: true }]);
    assert.equal(document.nodes.filter((node) => node.type === 'Supplier').length, 3);
    assert.deepEqual(built.ports.map((port) => [port.name, port.site, port.category, Number(port.arrivals.toFixed(6)), port.leadDays]),
        [['Supplier 1: Ambient', 'Supplier 1', 'ambient', 24, 3], ['Supplier 1: Chilled', 'Supplier 1', 'chilled', 10, 1], ['Supplier 1: Frozen', 'Supplier 1', 'frozen', 6, 5]]);
    // A store's sales by the usual shares; each category's lane named after its link and its category.
    const toStore = built.lanes.filter((lane) => lane.site === 'Store 1');
    assert.deepEqual(toStore.map((lane) => [lane.name, lane.link, lane.from, lane.to, Number(lane.rate.toFixed(6))]), [
        ['Road Warehouse 1 → Store 1: Ambient', 'Road Warehouse 1 → Store 1', 'Warehouse 1: Ambient', 'Store 1 stock: Ambient', 18],
        ['Road Warehouse 1 → Store 1: Chilled', 'Road Warehouse 1 → Store 1', 'Warehouse 1: Chilled', 'Store 1 stock: Chilled', 7.5],
        ['Road Warehouse 1 → Store 1: Frozen', 'Road Warehouse 1 → Store 1', 'Warehouse 1: Frozen', 'Store 1 stock: Frozen', 4.5]
    ]);
    // The link's four refrigerated trucks (the user's) carry all three there, shared by what each needs: by their flows.
    const fleets = toStore.map((lane) => lane.fleet);
    assert.ok(Math.abs(fleets.reduce((sum, fleet) => sum + fleet, 0) - 4) < 1e-9, `the four trucks are shared (${fleets})`);
    assert.ok(Math.abs(fleets[0] / fleets[1] - 18 / 7.5) < 1e-9);
    assert.ok(built.provenance.some((entry) => entry.entity === 'Road Warehouse 1 → Store 1: Chilled' && /Chilled's share of the link's 4, by what each category needs/.test(entry.detail) && entry.basis === 'user'));
    // The other store's link, on its usual medium trucks: its chilled and frozen goods by a refrigerated truck of their own.
    const toOther = built.lanes.filter((lane) => lane.site === 'Store 2');
    assert.deepEqual(toOther.map((lane) => lane.vehicles.map((item) => item.type).join()), ['mediumTruck', 'refrigeratedTruck', 'refrigeratedTruck']);
    assert.ok(Math.abs(toOther[1].fleet + toOther[2].fleet - 1) < 1e-9, 'one whole refrigerated truck between them');
    // The warehouse's 200 pallets of room, shared by what it handles of each.
    const room = (category) => document.sharedParameters.find((shared) => shared.id === built.parameterIndex.find((entry) => entry.entity === `Warehouse 1: ${category}` && entry.key === 'storageCapacity').sharedParameterId).value;
    assert.deepEqual(['Ambient', 'Chilled', 'Frozen'].map((category) => Number(room(category).toFixed(6))), [120, 50, 30]);
    // Every share says whose it is.
    const supplied = built.provenance.find((entry) => entry.entity === 'Supplier 1: Chilled' && entry.parameter === 'Supplied');
    assert.match(supplied.detail, /Chilled is 25% of what it supplies \(the categories' usual shares, assumed\)/);
    // Model-wide constants are said once, and a vehicle type's figures once.
    assert.equal(built.provenance.filter((entry) => entry.entity === 'Refrigerated truck' && entry.parameter === 'Capacity').length, 1);
    assert.equal(built.provenance.filter((entry) => entry.entity === 'Every component' && entry.parameter === 'Order handling time').length, 1);
});

test('a site\'s own mix and a supplier\'s own lead time reach the model; a category no source supplies is refused, naming it', () => {
    const { built } = placed({ change: ({ pins, categories }) => { setMix(pins[3], 'frozen', 0, categories); setLeadDays(pins[0], 'frozen', '9'); } });
    assert.ok(!built.stores.some((item) => item.site === 'Store 2' && item.category === 'frozen') && built.stores.some((item) => item.site === 'Store 1' && item.category === 'frozen'));
    assert.equal(built.ports.find((port) => port.category === 'frozen').leadDays, 9);
    assert.ok(built.provenance.some((entry) => entry.entity === 'Store 2: Ambient' && /Ambient is 70\.6% of what it sells or orders \(your mix\)/.test(entry.detail)));
    assert.throws(() => placed({ change: ({ pins, categories }) => { setMix(pins[0], 'chilled', 0, categories); } }), /^Error: Chilled: Place a supplier or a port/);
    // What it can make, when the user says: less than is ordered from it is refused.
    assert.throws(() => placed({ change: ({ pins }) => { pins[0].fields.makes = { value: 30, basis: 'user' }; } }), /Ambient: Supplier 1 can make 18 pallets a day, less than the 24 ordered from it/);
});

test('the built model by site and link: a link\'s lanes and a store\'s copies added up, a run\'s series with them, a scenario spread over them', () => {
    const { built } = placed();
    const view = siteView(built);
    assert.deepEqual(view.lanes.map((lane) => [lane.name, lane.from, lane.to, lane.site, Number(lane.rate.toFixed(6)), lane.members.length]), [
        ['Road Supplier 1 → Warehouse 1', 'Supplier 1', 'Warehouse 1', 'Warehouse 1', 40, 3],
        ['Road Warehouse 1 → Store 1', 'Warehouse 1', 'Store 1 stock', 'Store 1', 30, 3],
        ['Road Warehouse 1 → Store 2', 'Warehouse 1', 'Store 2 stock', 'Store 2', 10, 3]
    ]);
    // A link's vehicles by type, over its categories, in whole vehicles.
    assert.deepEqual(view.lanes[1].vehicles.map((item) => [item.type, item.fleet]), [['mediumTruck', built.lanes.find((lane) => lane.name === 'Road Warehouse 1 → Store 1: Ambient').fleet], ['refrigeratedTruck', 1]]);
    assert.deepEqual(view.ports.map((port) => [port.name, Number(port.arrivals.toFixed(6)), port.members.length]), [['Supplier 1', 40, 3]]);
    assert.deepEqual(view.stores.map((item) => [item.name, item.stock, Number(item.demand.toFixed(6)), item.members.map((member) => member.categoryName).join()]), [['Store 1', 'Store 1 stock', 30, 'Ambient,Chilled,Frozen'], ['Store 2', 'Store 2 stock', 10, 'Ambient,Chilled,Frozen']]);
    assert.deepEqual(view.served.map((item) => [item.town, item.zone, Number(item.demand.toFixed(6)), Number(item.share.toFixed(6))]), [['Store 1', 'Warehouse 1', 30, 1], ['Store 2', 'Warehouse 1', 10, 1]]);
    assert.equal(view.siteOf('Store 1 stock: Chilled'), 'Store 1 stock');
    assert.equal(view.siteOf('Road Warehouse 1 → Store 2: Frozen'), 'Road Warehouse 1 → Store 2');
    // A run's series: amounts added up over a site's copies, a level at its highest.
    const series = Object.fromEntries(['Ambient', 'Chilled', 'Frozen'].map((category, index) => [`Store 1 stock: ${category}`, { stock: [[0, 10 * (index + 1)], [3600, index]], spaceUsed: [[0, 0.1 * (index + 1)], [3600, 0.5]] }]));
    const merged = mergeSeries(series, view);
    assert.deepEqual(merged['Store 1 stock'].stock, [[0, 60], [3600, 3]]);
    assert.ok(Math.abs(merged['Store 1 stock'].spaceUsed[0][1] - 0.3) < 1e-12);
    assert.equal(merged['Store 2 stock'], undefined, 'nothing for a site the run has no series of');
    // A link's road closed: each of its lanes, and each category's orders over it, held.
    const window = { start: 5 * 86400, duration: 10 * 86400, forkAt: 0, runTime: 30 * 86400 };
    const closure = closureAcross(built, view, { closed: 'Road Warehouse 1 → Store 1', mode: 'wait', ...window });
    assert.deepEqual(closure.supplied.laneOpen.entities, ['Road Warehouse 1 → Store 1: Ambient', 'Road Warehouse 1 → Store 1: Chilled', 'Road Warehouse 1 → Store 1: Frozen']);
    assert.equal(closure.warehouse, 'Store 1 stock');
    assert.ok(Math.abs(closure.teuPerDay - 30) < 1e-9);
    assert.throws(() => closureAcross(built, view, { closed: 'Road Warehouse 1 → Store 9', mode: 'wait', ...window }), /There is no lane/);
    assert.deepEqual(affectedAcross(view, [{ port: 'Supplier 1', share: 0.5 }]), [{ port: 'Supplier 1: Ambient', share: 0.5 }, { port: 'Supplier 1: Chilled', share: 0.5 }, { port: 'Supplier 1: Frozen', share: 0.5 }]);
    assert.deepEqual(mergeSupplied([{ a: { entities: ['x'], samples: { x: 1 } } }, { a: { entities: ['x', 'y'], samples: { y: 2 } }, b: { entities: ['z'], samples: { z: 3 } } }]),
        { a: { entities: ['x', 'y'], samples: { x: 1, y: 2 } }, b: { entities: ['z'], samples: { z: 3 } } });
    // A category's share of a link's vehicles is not a whole number: a fleet change scales it as it is, a whole fleet to whole vehicles.
    const plan = fleetPlan({ lanes: [{ name: 'a', fleet: 0.625, fleet2: 0 }, { name: 'b', fleet: 5, fleet2: 0 }], change: -0.5, ...window });
    assert.equal(plan.supplied.fleetSize.samples.a.find(([time]) => time === window.start)[1], 0.3125);
    assert.equal(plan.supplied.fleetSize.samples.b.find(([time]) => time === window.start)[1], 3);
});

test('a supplier short or late: its capacity held at what it still makes, its lead time longer, its warehouses waiting or ordering elsewhere', () => {
    const window = { start: 5 * 86400, duration: 10 * 86400, forkAt: 0, runTime: 30 * 86400 };
    // A held path's value on the scenario's first day: its last sample by then (a value that never changes has two in all).
    const during = (path) => path.filter(([time]) => time <= window.start).at(-1)[1];
    const before = (path) => path[0][1];
    const after = (path) => path.at(-1)[1];
    // Two dairies supply one warehouse (30 and 10 a day); the first alone supplies another (20 a day). It can make 75.
    const suppliers = [{ name: 'Dairy', arrivals: 50, berths: 75, leadDays: 1 }, { name: 'Farm', arrivals: 10, berths: 15, leadDays: 2 }];
    const lanes = [
        { name: 'Dairy → North', from: 'Dairy', to: 'North', rate: 30 }, { name: 'Farm → North', from: 'Farm', to: 'North', rate: 10 },
        { name: 'Dairy → South', from: 'Dairy', to: 'South', rate: 20 }, { name: 'North → Shop', from: 'North', to: 'Shop stock', rate: 40 }
    ];
    // Short by 60%: it makes 20 of the 50 ordered, not 60% less than the 75 it could; then what it could again.
    const short = supplierPlan({ lanes, suppliers, chosen: ['Dairy'], short: 0.6, ...window });
    assert.deepEqual([before, during, after].map((at) => at(short.supplied.supplierCapacity.samples.Dairy)), [75, 20, 75]);
    assert.deepEqual([before, during].map((at) => at(short.supplied.supplierLeadTime.samples.Dairy)), [1, 1], 'its lead time is held as it is');
    assert.equal(short.shortPerDay, 30);
    // Waiting: its warehouses order as before (the scenario still names their lanes, at their usual shares).
    assert.deepEqual(short.supplied.orderShare.entities, ['Dairy → North', 'Farm → North', 'Dairy → South']);
    assert.deepEqual([before, during].map((at) => at(short.supplied.orderShare.samples['Dairy → North'])), [0.75, 0.75]);
    assert.deepEqual([short.reroutedTo, short.waiting, short.lanes, short.warehouses], [[], [], ['Dairy → North', 'Dairy → South'], ['North', 'South']]);
    // Ordering elsewhere: North moves the 60% of its orders the dairy cannot make to the farm; South has no one else, and waits.
    const elsewhere = supplierPlan({ lanes, suppliers, chosen: ['Dairy'], short: 0.6, mode: 'otherSuppliers', ...window });
    const share = (lane) => [before, during, after].map((at) => Number(at(elsewhere.supplied.orderShare.samples[lane]).toFixed(9)));
    assert.deepEqual(share('Dairy → North'), [0.75, 0.3, 0.75]);
    assert.deepEqual(share('Farm → North'), [0.25, 0.7, 0.25]);
    assert.deepEqual(share('Dairy → South'), [1, 1, 1]);
    assert.deepEqual([elsewhere.reroutedTo, elsewhere.waiting], [['Farm → North'], ['South']]);
    // Late by three days, and both at once; every supplier chosen is changed, no other.
    const late = supplierPlan({ lanes, suppliers, chosen: ['Dairy', 'Farm'], lateDays: 3, mode: 'otherSuppliers', ...window });
    assert.deepEqual(['Dairy', 'Farm'].map((name) => [before, during, after].map((at) => at(late.supplied.supplierLeadTime.samples[name]))), [[1, 4, 1], [2, 5, 2]]);
    assert.deepEqual([during(late.supplied.supplierCapacity.samples.Dairy), late.shortPerDay, late.reroutedTo.length], [75, 0, 0], 'late alone cuts nothing and moves no orders');
    const both = supplierPlan({ lanes, suppliers, chosen: ['Farm'], short: 1, lateDays: 0.5, ...window });
    assert.deepEqual([during(both.supplied.supplierCapacity.samples.Farm), during(both.supplied.supplierLeadTime.samples.Farm), Object.keys(both.supplied.supplierCapacity.samples)], [0, 2.5, ['Farm']]);
    // A supplier the user gave less room than is ordered cannot be: but one with little headroom is cut from its orders.
    assert.equal(during(supplierPlan({ lanes, suppliers: [{ name: 'Dairy', arrivals: 50, berths: 50, leadDays: 1 }], chosen: ['Dairy'], short: 0.1, ...window }).supplied.supplierCapacity.samples.Dairy), 45);
    // Refused with the reason.
    assert.throws(() => supplierPlan({ lanes, suppliers, chosen: ['Mill'], short: 0.5, ...window }), /Choose a supplier/);
    assert.throws(() => supplierPlan({ lanes, suppliers, chosen: ['Dairy'], ...window }), /short, late or both: it is neither/);
    assert.throws(() => supplierPlan({ lanes, suppliers, chosen: ['Dairy'], short: 1.2, ...window }), /from 0% to 100% less/);
    assert.throws(() => supplierPlan({ lanes, suppliers, chosen: ['Dairy'], lateDays: 15, ...window }), /from 0 to 14 days longer/);
    assert.throws(() => supplierPlan({ lanes, suppliers, chosen: ['Dairy'], short: 0.5, mode: 'panic', ...window }), /wait or order from their other suppliers/);
    // In a built network the paths fit the sliders the model gives a supplier, at the window's limits.
    const { built, document } = placed();
    const copies = built.ports.filter((port) => port.supplier);
    const plan = supplierPlan({ lanes: built.lanes, suppliers: copies, chosen: copies.map((copy) => copy.name), short: 1, lateDays: 14, mode: 'otherSuppliers', ...window });
    for (const [key, { entities, samples }] of Object.entries(plan.supplied)) {
        for (const entity of entities) {
            const indexed = built.parameterIndex.find((entry) => entry.key === key && entry.entity === entity);
            assert.ok(indexed?.live, `${key} of ${entity} is live`);
            const { control } = document.sharedParameters.find((shared) => shared.id === indexed.sharedParameterId);
            assert.ok(samples[entity].every(([, value]) => value >= control.minimum - 1e-9 && value <= control.maximum + 1e-9), `${key} of ${entity} stays within its slider`);
        }
    }
    assert.deepEqual(plan.waiting.sort(), ['Warehouse 1: Ambient', 'Warehouse 1: Chilled', 'Warehouse 1: Frozen'], 'with one supplier, every category waits');
});

test('a site down: its lanes closed and nothing ordered over them, its deliveries stopped, the sites it restocks waiting or ordering elsewhere', () => {
    const window = { start: 5 * 86400, duration: 10 * 86400, forkAt: 0, runTime: 30 * 86400 };
    const during = (path) => path.filter(([time]) => time <= window.start).at(-1)[1];
    const values = (path) => [path[0][1], during(path), path.at(-1)[1]];
    // Two warehouses, each from a supplier. North restocks a shop alone and a market with South (6 and 2 a day), and
    // delivers to an estate; South restocks a kiosk.
    const lanes = [
        { name: 'Mill → North', from: 'Mill', to: 'North', rate: 20 }, { name: 'Mill → South', from: 'Mill', to: 'South', rate: 5 },
        { name: 'North → Shop', from: 'North', to: 'Shop stock', rate: 10 }, { name: 'North → Market', from: 'North', to: 'Market stock', rate: 6 },
        { name: 'South → Market', from: 'South', to: 'Market stock', rate: 2 }, { name: 'South → Kiosk', from: 'South', to: 'Kiosk stock', rate: 3 }
    ];
    const deliveries = [
        { name: 'Shop sales', from: 'Shop stock', share: 1 }, { name: 'Market sales', from: 'Market stock', share: 1 }, { name: 'Kiosk sales', from: 'Kiosk stock', share: 1 },
        { name: 'Estate from North', from: 'North', share: 0.2 }
    ];
    // North down, its sites waiting: every lane into and out of it closed and nothing ordered over them, its delivery stopped.
    const waiting = siteDownPlan({ lanes, deliveries, nodes: ['North'], ...window });
    assert.deepEqual(waiting.supplied.laneOpen.entities, ['Mill → North', 'North → Shop', 'North → Market']);
    for (const lane of waiting.supplied.laneOpen.entities) assert.deepEqual(values(waiting.supplied.laneOpen.samples[lane]), [1, 0, 1]);
    assert.deepEqual(values(waiting.supplied.orderShare.samples['Mill → North']), [1, 0, 1]);
    assert.deepEqual(values(waiting.supplied.orderShare.samples['North → Market']), [0.75, 0, 0.75]);
    assert.equal(waiting.supplied.orderShare.samples['South → Market'], undefined, 'the other warehouse\'s lane is left as it is');
    assert.deepEqual([waiting.supplied.share.entities, values(waiting.supplied.share.samples['Estate from North'])], [['Estate from North'], [0.2, 0, 0.2]]);
    assert.deepEqual([waiting.perDay, waiting.reroutedTo, waiting.waiting.sort()], [16, [], ['Market stock', 'Shop stock']]);
    // Ordering elsewhere: the market's orders all go to South; the shop has no other warehouse, and waits.
    const elsewhere = siteDownPlan({ lanes, deliveries, nodes: ['North'], mode: 'otherWarehouses', ...window });
    assert.deepEqual(values(elsewhere.supplied.orderShare.samples['South → Market']), [0.25, 1, 0.25]);
    assert.deepEqual(values(elsewhere.supplied.orderShare.samples['North → Market']), [0.75, 0, 0.75]);
    assert.deepEqual([elsewhere.reroutedTo, elsewhere.waiting], [['South → Market'], ['Shop stock']]);
    // A store closed: nothing in, nothing sold. A warehouse with no delivery of its own still names one, as it is.
    const closed = siteDownPlan({ lanes, deliveries, nodes: ['Market stock'], ...window });
    assert.deepEqual(closed.supplied.laneOpen.entities, ['North → Market', 'South → Market']);
    assert.deepEqual(closed.supplied.orderShare.entities.map((lane) => during(closed.supplied.orderShare.samples[lane])), [0, 0]);
    assert.deepEqual([closed.supplied.share.entities, during(closed.supplied.share.samples['Market sales']), closed.perDay], [['Market sales'], 0, 0]);
    const south = siteDownPlan({ lanes, deliveries, nodes: ['South'], ...window });
    assert.deepEqual([south.supplied.share.entities, values(south.supplied.share.samples['Shop sales']), south.deliveries], [['Shop sales'], [1, 1, 1], []]);
    assert.throws(() => siteDownPlan({ lanes, deliveries, nodes: [], ...window }), /Choose a site/);
    assert.throws(() => siteDownPlan({ lanes, deliveries, nodes: ['Depot'], ...window }), /has no lane in the model/);
    assert.throws(() => siteDownPlan({ lanes, deliveries, nodes: ['North'], mode: 'panic', ...window }), /wait or order from their other warehouses/);
    // In a built network every delivery's share is live, and a site's nodes are one for each category.
    const { built } = placed();
    assert.deepEqual(built.deliveries.map((delivery) => delivery.name).slice(0, 3), ['Store 1 sales: Ambient', 'Store 2 sales: Ambient', 'Store 1 sales: Chilled']);
    for (const delivery of built.deliveries) assert.ok(built.parameterIndex.find((entry) => entry.key === 'share' && entry.entity === delivery.name)?.live, `${delivery.name}'s share is live`);
    const nodes = siteView(built).members.get('Store 1 stock');
    assert.deepEqual(nodes, ['Store 1 stock: Ambient', 'Store 1 stock: Chilled', 'Store 1 stock: Frozen']);
    const plan = siteDownPlan({ lanes: built.lanes, deliveries: built.deliveries, nodes, ...window });
    assert.deepEqual(plan.deliveries, ['Store 1 sales: Ambient', 'Store 1 sales: Chilled', 'Store 1 sales: Frozen']);
    assert.equal(plan.supplied.laneOpen.entities.length, 3);
});

test('a model of goods of one kind, or one saved before categories, is its own view', () => {
    const built = {
        lanes: [{ name: 'Road P → W', from: 'P', to: 'W', rate: 5, fleet: 2, fleet2: 1 }, { name: 'Road W → S', kind: 'store', from: 'W', to: 'S stock', site: 'S', rate: 5, fleet: 1, fleet2: 0 }],
        ports: [{ name: 'P', arrivals: 5, berths: 7, schedule: [[0, 5]], usual: null }], towns: [{ name: 'S', demand: 5 }],
        stores: [{ name: 'S', stock: 'S stock', demand: 5 }], served: [{ town: 'S', zone: 'W', share: 1, demand: 5, hours: 1 }]
    };
    const view = siteView(built);
    assert.equal(view.categories, null);
    assert.deepEqual(view.lanes.map((lane) => [lane.name, lane.from, lane.to, lane.rate, lane.fleet, lane.fleet2]), [['Road P → W', 'P', 'W', 5, 2, 1], ['Road W → S', 'W', 'S stock', 5, 1, 0]]);
    assert.deepEqual(view.stores.map((item) => [item.name, item.stock, item.demand]), [['S', 'S stock', 5]]);
    assert.deepEqual(view.ports[0].schedule, [[0, 5]]);
    const series = { S: { lost: [[0, 1]] } };
    assert.equal(mergeSeries(series, view), series);
    assert.equal(siteView({ lanes: [], ports: [], towns: [], served: [] }).stores, undefined, 'a network of towns has no stores');
});
