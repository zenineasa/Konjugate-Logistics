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
import { buildRegionModel, categoryShifts } from '../../packages/toolbox/lib/regionModel.mjs';
import { buildRoadGraph } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { fleetPlan, siteDownPlan, supplierPlan } from '../../packages/toolbox/lib/scenarios.mjs';
import { carriersFor, defaultCatalogue } from '../../packages/toolbox/lib/vehicles.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { gridRoads } from '../fixtures/roadGrid.mjs';

test('the default catalogue is ambient, chilled and frozen goods, every figure assumed, the cold ones needing refrigerated vehicles', () => {
    const catalogue = defaultCategoryCatalogue();
    assert.deepEqual(catalogue.map((category) => [category.name, category.chilled]), [['Ambient', false], ['Chilled', true], ['Frozen', true]]);
    assert.ok(catalogue.every((category) => ['share', 'leadDays'].every((key) => category.fields[key].basis === 'assumed' && category.fields[key].value > 0)));
    // Chilled goods keep ten days, assumed; the others keep.
    assert.deepEqual(catalogue.map((category) => category.fields.shelfDays), [{ value: null, basis: null }, { value: 10, basis: 'assumed' }, { value: null, basis: null }]);
    assert.equal(categoriesProblem(catalogue), null);
    assert.deepEqual(categoriesForModel(catalogue)[1], { id: 'chilled', name: 'Chilled', chilled: true, share: 25, leadDays: 1, shelfDays: 10, saleValue: null, basis: { share: 'assumed', leadDays: 'assumed', shelfDays: 'assumed', saleValue: null } });
    assert.deepEqual([categoriesForModel(catalogue)[0].shelfDays, categoriesForModel(catalogue)[0].basis.shelfDays], [null, null]);
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
    assert.deepEqual(restored[0].fields, { share: { value: 70, basis: 'user' }, leadDays: { value: 3, basis: 'assumed' }, shelfDays: { value: null, basis: null }, saleValue: { value: null, basis: null } });
    // A shelf life is the user's once given; cleared, it is the category's default again: none for ambient goods, ten days for chilled.
    setCategoryField(catalogue[0], 'shelfDays', '30');
    assert.deepEqual(catalogue[0].fields.shelfDays, { value: 30, basis: 'user' });
    setCategoryField(catalogue[0], 'shelfDays', '');
    assert.deepEqual(catalogue[0].fields.shelfDays, { value: null, basis: null });
    setCategoryField(catalogue[1], 'shelfDays', '');
    assert.deepEqual(catalogue[1].fields.shelfDays, { value: 10, basis: 'assumed' });
    assert.equal(categoriesProblem(catalogue), null, 'goods that keep are no gap in the catalogue');
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
    assert.deepEqual(built.categories, [{ id: 'ambient', name: 'Ambient', chilled: false }, { id: 'chilled', name: 'Chilled', chilled: true, shelfDays: 10 }, { id: 'frozen', name: 'Frozen', chilled: true }]);
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

test('each category\'s copy of the network has its own place on the canvas, clear of the others, laid out alike', () => {
    const { built, document } = placed();
    const boxOf = (category) => {
        const nodes = document.nodes.filter((node) => node.name.endsWith(`: ${category}`));
        const [xs, ys] = [0, 1].map((axis) => nodes.map((node) => node.position[axis]));
        return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys), count: nodes.length };
    };
    const boxes = built.categories.map((category) => boxOf(category.name));
    assert.deepEqual(boxes.map((box) => box.count), [9, 9, 9]);
    // No two copies overlap: there is room between them, across or up and down, for their names.
    const apart = (a, b) => Math.max(b.left - a.right, a.left - b.right, b.bottom - a.top, a.bottom - b.top);
    for (const [index, box] of boxes.entries()) for (const other of boxes.slice(index + 1)) assert.ok(apart(box, other) >= 12, `two copies lie ${apart(box, other)} apart`);
    // A site is in the same place in each copy.
    const at = (name) => document.nodes.find((node) => node.name === name).position;
    const offset = (category) => [0, 1].map((axis) => Number((at(`Store 1: ${category}`)[axis] - at(`Warehouse 1: ${category}`)[axis]).toFixed(3)));
    assert.deepEqual(offset('Chilled'), offset('Ambient'));
    assert.deepEqual(offset('Frozen'), offset('Ambient'));
    assert.ok(document.nodes.every((node) => node.position.every(Number.isFinite)));
    // The most compact grid: a network wider than tall has its copies one above the other, a taller one side by side;
    // four are two rows of two, six two columns of three; one is where it would be alone.
    const wide = { width: 60, height: 40 };
    assert.deepEqual(categoryShifts(1, wide), [[0, 0]]);
    assert.deepEqual(categoryShifts(3, wide), [[0, 54], [0, 0], [0, -54]]);
    assert.deepEqual(categoryShifts(3, { width: 40, height: 60 }), [[-54, 0], [0, 0], [54, 0]]);
    assert.deepEqual(categoryShifts(4, wide), [[-37, 27], [37, 27], [-37, -27], [37, -27]]);
    assert.deepEqual(categoryShifts(6, wide), [[-37, 54], [37, 54], [-37, 0], [37, 0], [-37, -54], [37, -54]]);
});

test('goods that keep only so long: every site that holds them has their shelf life, and aims to hold no more than it sells within it', () => {
    const shelfOf = (built, document, entity) => document.sharedParameters.find((shared) => shared.id === built.parameterIndex.find((entry) => entry.entity === entity && entry.key === 'shelfDays').sharedParameterId).value;
    const stockOf = (document, name) => document.nodes.find((node) => node.name === name).states.find((state) => state.symbol === 'stock').initialValue;
    // Chilled goods keep ten days by default: longer than any site's cover, so nothing is capped; ambient goods keep.
    const usual = placed();
    assert.equal(shelfOf(usual.built, usual.document, 'Store 1 stock: Chilled'), 10);
    assert.equal(shelfOf(usual.built, usual.document, 'Warehouse 1: Chilled'), 10);
    assert.equal(shelfOf(usual.built, usual.document, 'Store 1 stock: Ambient'), 1000000, 'the template\'s own: so long that nothing is wasted');
    assert.ok(!usual.built.warnings.some((text) => /keeps/.test(text)));
    assert.ok(usual.built.provenance.some((entry) => entry.entity === 'Store 1: Chilled' && entry.parameter === 'Shelf life' && entry.basis === 'assumed' && /^Assumed for Chilled\./.test(entry.detail)));
    assert.ok(!usual.built.provenance.some((entry) => entry.entity === 'Store 1: Ambient' && entry.parameter === 'Shelf life'));
    // A day and a half, the user's: a store's two days of cover and a warehouse's three are held to it, and said.
    const short = placed({ change: ({ categories }) => setCategoryField(categories[1], 'shelfDays', '1.5') });
    assert.equal(shelfOf(short.built, short.document, 'Warehouse 1: Chilled'), 1.5);
    const sales = short.built.stores.find((item) => item.name === 'Store 1: Chilled').demand;
    assert.ok(Math.abs(stockOf(short.document, 'Store 1 stock: Chilled') - 1.5 * sales) < 1e-9, 'a day and a half of its sales, not two days');
    assert.ok(Math.abs(stockOf(usual.document, 'Store 1 stock: Chilled') - 2 * sales) < 1e-9);
    assert.ok(short.built.warnings.includes('Store 1 aims to hold 1.5 days of Chilled, not its 2 days of cover: Chilled keeps 1.5 days, and what it held beyond that would be wasted.'), short.built.warnings.join(' / '));
    assert.ok(short.built.provenance.some((entry) => entry.entity === 'Warehouse 1: Chilled' && entry.parameter === 'Shelf life' && entry.basis === 'user' && /^Your figure for Chilled\./.test(entry.detail)));
    assert.deepEqual(short.built.categories[1], { id: 'chilled', name: 'Chilled', chilled: true, shelfDays: 1.5 });
});

test('a category with a value of a pallet of its own prices its sales at every store; the others take each store\'s', () => {
    const { built } = placed({ change: ({ categories, pins }) => { setCategoryField(categories[1], 'saleValue', '2500'); pins[3].fields.saleValue = { value: 700, basis: 'user' }; } });
    const valueOf = (site, category) => { const item = built.stores.find((each) => each.site === site && each.category === category); return [item.saleValue, item.saleValueBasis]; };
    // Chilled: its own 2,500 at both stores. Ambient: the default at one store, the store's own 700 at the other.
    assert.deepEqual([valueOf('Store 1', 'chilled'), valueOf('Store 2', 'chilled')], [[2500, 'user'], [2500, 'user']]);
    assert.deepEqual([valueOf('Store 1', 'ambient'), valueOf('Store 2', 'ambient'), valueOf('Store 2', 'frozen')], [[1000, 'assumed'], [700, 'user'], [700, 'user']]);
    assert.ok(built.provenance.some((entry) => entry.entity === 'Store 1: Chilled' && entry.parameter === 'Value of a pallet sold' && entry.value === 2500 && entry.basis === 'user'));
    assert.ok(!built.provenance.some((entry) => entry.entity === 'Store 1: Ambient' && entry.parameter === 'Value of a pallet sold'));
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

// A hub and a spoke on the same grid: a supplier, two warehouses, a store at each.
function hubAndSpoke(transfer, { supplyBoth = false } = {}) {
    const catalogue = defaultCatalogue();
    const pins = [];
    const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
    const supplier = add('supplier', grid.at(1, 1), { fields: { supply: 40 } });
    const hub = add('warehouse', grid.at(6, 6), { name: 'Hub' });
    const spoke = add('warehouse', grid.at(15, 15), { name: 'Spoke' });
    const near = add('store', grid.at(8, 4), { fields: { demand: 30 } });
    const far = add('store', grid.at(17, 17), { fields: { demand: 10 } });
    const link = (from, to, more = {}) => ({ id: `${from.id}>${to.id}`, from: from.id, to: to.id, basis: 'user', ...more });
    const links = [link(supplier, hub), ...(supplyBoth ? [link(supplier, spoke)] : []), link(hub, near), link(spoke, far), ...(transfer ? [link(hub, spoke, transfer)] : [])];
    routeLinks(pins, links, router);
    const problems = networkProblems(pins, links, catalogue).filter((problem) => problem.level === 'error').map((problem) => problem.text);
    const network = networkSelection(pins, links, { catalogue });
    const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
    const selection = Object.fromEntries(Object.entries(network.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));
    const build = () => buildRegionModel({ builder: new ModelBuilder(templates), selection, route: router.route, links: network.links, options: { vehicles: network.vehicles, unit: network.unit } });
    return { pins, links, problems, network, build };
}

test('one warehouse restocks another: the spoke takes what it needs from the hub, the hub sends out both its own stores\' goods and the spoke\'s', () => {
    // The spoke has no supplier of its own: all it needs comes from the hub, over a lane of heavy trucks.
    const { problems, network, build } = hubAndSpoke({});
    assert.deepEqual(problems, []);
    assert.deepEqual(network.links.transfer.map((link) => [link.from === network.selection.zones[0].id, link.backup ?? false, link.share ?? null, link.vehicles]), [[true, false, null, [{ type: 'heavyTruck', fleet: null }]]]);
    assert.equal(network.links.serve.length, 2, 'a link between warehouses is not one to a store');
    const built = build();
    const lane = (name) => built.lanes.find((item) => item.name === name);
    const round = (value) => Number(value.toFixed(6));
    assert.deepEqual([lane('Road Hub → Spoke').kind, round(lane('Road Hub → Spoke').rate), lane('Road Hub → Spoke').standby], ['transfer', 10, false]);
    assert.equal(round(lane('Road Supplier 1 → Hub').rate), 40, 'the supplier ships to the hub what both warehouses send out');
    assert.equal(lane('Road Supplier 1 → Spoke'), undefined);
    const stockOf = (name) => built.document.nodes.find((node) => node.name === name).states.find((state) => state.symbol === 'stock').initialValue;
    assert.deepEqual([round(stockOf('Hub')), round(stockOf('Spoke'))], [120, 30], 'three days of what each sends out: the hub\'s forty a day, the spoke\'s ten');
    // The orders over the lane reach the hub's forecast, as a store's do: it is a store shipment.
    assert.ok(built.document.edges.some((edge) => edge.name === 'Order signal: Spoke → Hub'));
    assert.ok(built.provenance.some((entry) => entry.entity === 'Spoke' && entry.parameter === 'Share restocked from Hub' && entry.value === 100 && entry.basis === 'assumed'));
    assert.ok(built.corridors.some((corridor) => corridor.lanes.includes('Road Hub → Spoke')), 'the lane is drawn on the map');
    // With a supplier of its own too, the spoke takes half from each until the link says otherwise: 30%.
    const both = hubAndSpoke({}, { supplyBoth: true }).build();
    assert.deepEqual(['Road Hub → Spoke', 'Road Supplier 1 → Spoke', 'Road Supplier 1 → Hub'].map((name) => round(both.lanes.find((item) => item.name === name).rate)), [5, 5, 35]);
    const third = hubAndSpoke({ share: 30 }, { supplyBoth: true }).build();
    assert.deepEqual(['Road Hub → Spoke', 'Road Supplier 1 → Spoke', 'Road Supplier 1 → Hub'].map((name) => round(third.lanes.find((item) => item.name === name).rate)), [3, 7, 33]);
    assert.ok(third.provenance.some((entry) => entry.entity === 'Spoke' && entry.parameter === 'Share restocked from Hub' && entry.value === 30 && entry.basis === 'user'));
    // A share with nowhere for the rest to come from is refused, with the reason.
    assert.throws(() => hubAndSpoke({ share: 30 }).build(), /Spoke takes 30% of what it needs from other warehouses and has no supplier or port for the rest/);
});

test('a backup link between warehouses carries nothing until a scenario orders over it, and is no supply on its own', () => {
    // A backup alone does not restock the spoke: it needs a supplier, a port or a standing link.
    assert.deepEqual(hubAndSpoke({ backup: true }).problems, ['Spoke has no supplier, port or warehouse that restocks it. Drag a link from one to it.']);
    const { problems, network, build } = hubAndSpoke({ backup: true }, { supplyBoth: true });
    assert.deepEqual(problems, []);
    assert.deepEqual(network.links.transfer.map((link) => link.backup), [true]);
    const built = build();
    const backup = built.lanes.find((item) => item.name === 'Road Hub → Spoke');
    assert.deepEqual([backup.kind, backup.rate, backup.standby, backup.fleet, backup.fleet2], ['transfer', 0, true, 0, 0]);
    assert.deepEqual(['Road Supplier 1 → Spoke', 'Road Supplier 1 → Hub'].map((name) => Number(built.lanes.find((item) => item.name === name).rate.toFixed(6))), [10, 30], 'the baseline is as it would be without it');
    assert.ok(built.provenance.some((entry) => entry.entity === 'Road Hub → Spoke' && entry.parameter === 'Fleet' && /^A backup: it carries nothing/.test(entry.detail)));
    // Its vehicles can be hired up to what the spoke would need if all it takes came over it.
    const fleetSize = built.parameterIndex.find((entry) => entry.entity === 'Road Hub → Spoke' && entry.key === 'fleetSize');
    assert.ok(fleetSize.live && fleetSize.maximum >= 3);
    // Two warehouses restocking each other in a circle have nowhere to start: one link must be a backup.
    const circle = hubAndSpoke({}, { supplyBoth: true });
    const [hub, spoke] = circle.pins.filter((pin) => pin.role === 'warehouse');
    const back = { id: `${spoke.id}>${hub.id}`, from: spoke.id, to: hub.id, basis: 'user' };
    assert.deepEqual(networkProblems(circle.pins, [...circle.links, back], defaultCatalogue()).filter((problem) => problem.level === 'error').map((problem) => problem.text),
        ['Hub and Spoke restock each other in a circle: make one of those links a backup, or delete it.']);
    assert.deepEqual(networkProblems(circle.pins, [...circle.links, { ...back, backup: true }], defaultCatalogue()).filter((problem) => problem.level === 'error'), []);
});

test('a site\'s hours: none is round the clock; a figure or a day changed is kept, back to round the clock is none again', async () => {
    const { calendarOf, calendarProblem, calendarSamples, describeCalendar, hoursForModel, kindsFor, laneGates, setHours, weeklyHours } = await import('../../packages/toolbox/lib/calendars.mjs');
    assert.deepEqual([kindsFor('store'), kindsFor('warehouse'), kindsFor('supplier'), kindsFor('customerArea'), kindsFor('port')], [['open', 'receive'], ['receive', 'dispatch'], ['dispatch'], [], []]);
    const store = createPin('store', { lat: 0, lon: 0 }, { name: 'Shop' });
    assert.deepEqual([calendarOf(store, 'open'), hoursForModel(store), weeklyHours(null), describeCalendar(null)], [null, {}, 168, 'round the clock, every day']);
    setHours(store, 'open', { from: '8' });
    assert.deepEqual(calendarOf(store, 'open'), { from: 8, to: 24, days: Array(7).fill(true) });
    setHours(store, 'open', { to: '22' });
    setHours(store, 'open', { day: 6, on: false });
    const open = calendarOf(store, 'open');
    assert.deepEqual([open.from, open.to, open.days, weeklyHours(open), describeCalendar(open)], [8, 22, [true, true, true, true, true, true, false], 84, '8:00 to 22:00, Monday to Saturday']);
    setHours(store, 'receive', { from: 6, to: 9.5 });
    assert.equal(describeCalendar(calendarOf(store, 'receive')), '6:00 to 9:30, every day');
    assert.deepEqual(Object.keys(hoursForModel(store).hours), ['open', 'receive']);
    setHours(store, 'dispatch', { from: 6 });
    assert.equal(store.hours.dispatch, undefined, 'a store dispatches nothing: no such hours');
    // Back to round the clock: no calendar, and no hours at all once the last is gone.
    setHours(store, 'receive', { from: '', to: '' });
    assert.equal(calendarOf(store, 'receive'), null);
    setHours(store, 'open', { from: '', to: '' });
    setHours(store, 'open', { day: 6, on: true });
    assert.equal(store.hours, undefined);
    // Hours that cannot be kept are refused with the reason, and stop a build.
    setHours(store, 'open', { from: 22, to: 8 });
    assert.match(calendarProblem(calendarOf(store, 'open'), 'Shop', 'open'), /^Shop is open from 22:00 to 8:00: the second hour must be later than the first/);
    assert.deepEqual(networkProblems([store], []).filter((problem) => /second hour/.test(problem.text)).map((problem) => [problem.level, problem.pins]), [['error', [store.id]]]);
    assert.match(calendarProblem({ from: 8, to: 20, days: Array(7).fill(false) }, 'Shop', 'receive'), /^Shop receives on no day of the week/);
    // As a schedule: nothing outside the hours, and within them as much above 1 as they are short of the week.
    assert.deepEqual(calendarSamples(open, 2, { average: true }), [[0, 0], [8 * 3600, 2], [22 * 3600, 0], [32 * 3600, 2], [46 * 3600, 0]]);
    assert.deepEqual(calendarSamples({ from: 0, to: 24, days: [true, false, true, true, true, true, true] }, 3), [[0, 1], [24 * 3600, 0], [48 * 3600, 1], [72 * 3600, 0]], 'all day but Tuesday');
    assert.equal(calendarSamples(null, 5), null);
    // What hours ask of a lane's vehicles: a day's goods loaded in eight hours, and half the closed time at the door.
    assert.deepEqual(laneGates(null, null), { peak: 1, waitDays: 0 });
    assert.equal(laneGates({ from: 9, to: 17, days: Array(7).fill(true) }, null).peak, 3);
    assert.ok(Math.abs(laneGates(null, { from: 6, to: 9, days: Array(7).fill(true) }).waitDays - 0.875 * 0.875 / 2) < 1e-12);
});

test('a site\'s hours reach the model as one stored schedule each, whatever the categories: its demand, the lanes into it and the lanes out of it', async () => {
    const { setHours } = await import('../../packages/toolbox/lib/calendars.mjs');
    const { built, document } = placed({ change: ({ pins }) => { setHours(pins[2], 'open', { from: 8, to: 22 }); setHours(pins[2], 'receive', { from: 6, to: 9 }); setHours(pins[1], 'dispatch', { from: 9, to: 17 }); setHours(pins[0], 'dispatch', { day: 6, on: false }); } });
    const scheduled = document.sharedParameters.filter((shared) => shared.schedule).map((shared) => [shared.name, shared.schedule.interpolation, shared.schedule.samples[1]]);
    assert.deepEqual(scheduled.sort(), [['Store 1 is open', 'hold', [8 * 3600, 24 / 14]], ['Store 1 receives', 'hold', [6 * 3600, 8]], ['Supplier 1 dispatches', 'hold', [144 * 3600, 0]], ['Warehouse 1 dispatches', 'hold', [9 * 3600, 3]]].sort());
    // One parameter for the store's three categories, on each one's demand; and for each lane the hours of its ends.
    const usesOf = (name) => { const id = document.sharedParameters.find((shared) => shared.name === name).id; return [...document.nodes.flatMap((node) => node.sourceTerms.filter((term) => term.parameters.some((parameter) => parameter.sharedParameterId === id)).map((term) => `${node.name}.${term.state}`))].sort(); };
    assert.deepEqual(usesOf('Store 1 is open'), ['Store 1: Ambient.demandRate', 'Store 1: Chilled.demandRate', 'Store 1: Frozen.demandRate']);
    assert.deepEqual(usesOf('Store 1 receives'), ['Road Warehouse 1 → Store 1: Ambient.arriving', 'Road Warehouse 1 → Store 1: Chilled.arriving', 'Road Warehouse 1 → Store 1: Frozen.arriving']);
    assert.equal(usesOf('Warehouse 1 dispatches').filter((use) => /canLoad$/.test(use)).length, 6, 'its lanes to both stores, in each category');
    assert.equal(usesOf('Supplier 1 dispatches').filter((use) => /wanted$/.test(use)).length, 3);
    // Said once for each, by site; and the lane has more vehicles than without hours.
    assert.deepEqual(built.provenance.filter((entry) => /hours$/.test(entry.parameter)).map((entry) => [entry.entity, entry.parameter, entry.value, entry.basis]).sort(), [['Store 1', 'Opening hours', 98, 'user'], ['Store 1', 'Receiving hours', 21, 'user'], ['Supplier 1', 'Dispatch hours', 144, 'user'], ['Warehouse 1', 'Dispatch hours', 56, 'user']].sort());
    const fleetOf = (model) => model.lanes.filter((lane) => lane.link === 'Road Warehouse 1 → Store 1').reduce((sum, lane) => sum + lane.fleet + lane.fleet2, 0);
    assert.ok(fleetOf(built) > fleetOf(placed().built));
    // With no hours, no schedule: the model is as it was.
    assert.ok(!placed().document.sharedParameters.some((shared) => shared.schedule));
});

test('holidays and peaks: an event\'s effect on a category\'s demand as a schedule, the days suppliers are closed, and what is wrong with one', async () => {
    const { closeDuring, createHoliday, demandChange, describeHoliday, holidayProblem, holidaysForModel, seasonSamples, supplierClosures } = await import('../../packages/toolbox/lib/holidays.mjs');
    const first = createHoliday([]);
    assert.deepEqual([first.name, first.day, first.days, first.demand, first.suppliersClosed, holidayProblem(first)], ['Holiday 1', 14, 1, {}, false, null]);
    assert.equal(createHoliday([first]).name, 'Holiday 2');
    const festival = { name: 'Festival', day: 12, days: 3, demand: { all: 80, chilled: 150 }, beforeDays: 3, beforePercent: 30, afterDays: 2, afterPercent: -20, suppliersClosed: true };
    // A category's own change, else the one for all goods; days before and after; 1 on an ordinary day.
    assert.deepEqual([demandChange(festival, 'chilled'), demandChange(festival, 'ambient'), demandChange(festival, null)], [150, 80, 80]);
    assert.deepEqual(seasonSamples([festival], 'ambient', 28), [[0, 1], [9 * 86400, 1.3], [12 * 86400, 1.8], [15 * 86400, 0.8], [17 * 86400, 1]]);
    assert.deepEqual(seasonSamples([festival], 'chilled', 28)[2], [12 * 86400, 2.5]);
    assert.equal(seasonSamples([{ ...festival, demand: {}, beforePercent: 0, afterPercent: 0 }], 'ambient', 28), null, 'an event that changes no demand is no schedule');
    assert.equal(seasonSamples([], 'ambient', 28), null);
    // Everything closed: nothing sold. Two events on the same day multiply.
    assert.deepEqual(seasonSamples([{ name: 'Closed', day: 3, days: 1, demand: { all: -100 } }], null, 7), [[0, 1], [3 * 86400, 0], [4 * 86400, 1]]);
    assert.deepEqual(seasonSamples([{ name: 'A', day: 2, days: 2, demand: { all: 50 } }, { name: 'B', day: 3, days: 1, demand: { all: 100 } }], null, 7).map(([, value]) => value), [1, 1.5, 3, 1]);
    // The days suppliers do not dispatch, merged where they touch, and a schedule closed over them.
    assert.deepEqual(supplierClosures([festival, { name: 'Bridge', day: 15, days: 1, suppliersClosed: true }, { name: 'Open', day: 20, days: 2 }], 28), [{ from: 12 * 86400, to: 16 * 86400 }]);
    assert.deepEqual(closeDuring(null, [{ from: 86400, to: 2 * 86400 }]), [[0, 1], [86400, 0], [2 * 86400, 1]]);
    assert.deepEqual(closeDuring([[0, 0], [8 * 3600, 3], [16 * 3600, 0], [32 * 3600, 3], [40 * 3600, 0]], [{ from: 86400, to: 2 * 86400 }]), [[0, 0], [8 * 3600, 3], [16 * 3600, 0]], 'a day shift, with the second day closed');
    assert.deepEqual(closeDuring([[0, 1]], []), [[0, 1]]);
    assert.equal(describeHoliday(festival, 'chilled', 'Chilled'), 'Festival (day 12 for 3 days): Chilled demand +150%; the 3 days before +30%; the 2 days after -20%; suppliers do not dispatch');
    // What is wrong, said; and only sound events reach the model.
    assert.equal(holidayProblem({ ...festival, name: ' ' }), 'A holiday or peak needs a name.');
    assert.equal(holidayProblem({ ...festival, days: 0 }), 'Festival: it lasts a day or more.');
    assert.equal(holidayProblem({ ...festival, day: 1 }), 'Festival: its 3 days of stocking up would start before the run does. Start it later, or stock up for fewer days.');
    assert.equal(holidayProblem({ ...festival, demand: { all: -120 } }), 'Festival: demand cannot fall by more than 100%.');
    assert.equal(holidayProblem(festival, 10), 'Festival: it starts on day 12, after the run\'s 10 days.');
    assert.deepEqual(holidaysForModel([festival, { ...festival, days: 0 }]).map((event) => [event.name, event.demand, event.suppliersClosed]), [['Festival', { all: 80, chilled: 150 }, true]]);
    assert.deepEqual(networkProblems([], [], null, null, [{ ...festival, days: 0 }]).filter((problem) => /lasts a day/.test(problem.text)).map((problem) => problem.level), ['error']);
});

test('a holiday reaches the model as one schedule for each category\'s demand, and closes the suppliers\' dispatching', async () => {
    const festival = [{ name: 'Festival', day: 12, days: 3, demand: { chilled: 150 }, beforeDays: 0, beforePercent: 0, afterDays: 0, afterPercent: 0, suppliersClosed: true }];
    const { pins, links } = placed();
    const network = networkSelection(pins, links, { catalogue: defaultCatalogue(), categories: defaultCategoryCatalogue(), holidays: festival });
    assert.deepEqual(network.holidays.map((event) => event.name), ['Festival']);
    const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
    const selection = Object.fromEntries(Object.entries(network.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));
    const built = buildRegionModel({ builder: new ModelBuilder(templates), selection, route: router.route, links: network.links, options: { vehicles: network.vehicles, unit: network.unit, categories: network.categories, holidays: network.holidays } });
    const scheduled = built.document.sharedParameters.filter((shared) => shared.schedule).map((shared) => [shared.name, shared.schedule.samples]);
    // Chilled alone has a pattern: the festival changes nothing else. The supplier is closed in every category, by one parameter.
    assert.deepEqual(scheduled, [['Supplier 1 dispatches', [[0, 1], [12 * 86400, 0], [15 * 86400, 1]]], ['Holidays and peaks: Chilled', [[0, 1], [12 * 86400, 2.5], [15 * 86400, 1]]]]);
    assert.ok(built.provenance.some((entry) => entry.entity === 'Holidays and peaks: Chilled' && entry.parameter === 'Festival' && entry.basis === 'user'));
    assert.ok(built.provenance.some((entry) => entry.entity === 'Supplier 1' && entry.parameter === 'Closed for holidays' && entry.value === 3));
});
