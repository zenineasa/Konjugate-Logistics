/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A site's own figure is its alone: a stock without one of its own runs on its role's default, never on the figure of a
// site placed before it. The Warehouse template declares its holding cost and its stock cover once for the whole model
// (project-wide), and a site with its own is placed with a parameter of its own; these tests read the model's document,
// so they see what the engine runs on.

import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultCategoryCatalogue, setCategoryField } from '../../packages/toolbox/lib/categories.mjs';
import { createPin, networkSelection, routeLinks, setField, suggestLinks } from '../../packages/toolbox/lib/network.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { buildRoadGraph } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { defaultCatalogue } from '../../packages/toolbox/lib/vehicles.mjs';
import { equationHelpers, loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { ModelBuilder as ToolboxModelBuilder } from '../../packages/toolbox/lib/modelBuilder.mjs';
import { gridRoads } from '../fixtures/roadGrid.mjs';

const templates = await loadTemplates();
const grid = gridRoads({ size: 20, spacing: 400 });
const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(grid.features)));

// Two warehouses and two stores, each warehouse serving the store beside it; `set` gives sites figures of their own.
function build(set, { categories = null } = {}) {
    const pins = [];
    const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
    add('supplier', grid.at(1, 1), { fields: { supply: 40 } });
    const sites = {
        first: add('warehouse', grid.at(6, 6)),
        second: add('warehouse', grid.at(14, 14)),
        nearFirst: add('store', grid.at(4, 8), { fields: { demand: 20 } }),
        nearSecond: add('store', grid.at(16, 12), { fields: { demand: 10 } })
    };
    set(sites);
    const links = suggestLinks(pins, [], router);
    routeLinks(pins, links, router);
    const network = networkSelection(pins, links, { catalogue: defaultCatalogue(), ...(categories ? { categories } : {}) });
    const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
    const selection = Object.fromEntries(Object.entries(network.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));
    const built = buildRegionModel({ builder: new ModelBuilder(templates), selection, route: router.route, links: network.links, options: { vehicles: network.vehicles, unit: network.unit, ...(network.categories ? { categories: network.categories } : {}) } });
    return { built, sites };
}

// What each stock node's parameter of this symbol holds in the document: { node name: value }.
function inDocument(built, symbol) {
    const shared = new Map(built.document.sharedParameters.map((item) => [item.id, item]));
    return Object.fromEntries(built.document.nodes.map((node) => [node.name, node.sourceTerms.flatMap((term) => term.parameters ?? []).find((parameter) => parameter.symbol === symbol)])
        .filter(([, parameter]) => parameter).map(([name, parameter]) => [name, shared.get(parameter.sharedParameterId).value]));
}

// The stock nodes of a site: a warehouse's own node, a store's stock room (named after it).
const stockOf = (values, site) => Object.entries(values).filter(([name]) => name === site.name || name === `${site.name} stock`).map(([, value]) => value);

// The warehouse placed first in the model is the one under test: else the leak would not show.
function placedFirst(built, site) {
    const warehouses = built.holding.filter((item) => !item.store);
    assert.equal(warehouses[0].site, site.name, 'the warehouse with its own figure is placed first, so the case tested is the one that leaked');
}

test('the first warehouse\'s own holding cost is its alone: the other warehouse and the stores\' stock rooms keep the default', () => {
    const { built, sites } = build(({ first }) => setField(first, 'holdingCost', '0.9'));
    placedFirst(built, sites.first);
    const values = inDocument(built, 'holdingCostPerDay');
    assert.deepEqual(stockOf(values, sites.first), [0.9]);
    for (const site of [sites.second, sites.nearFirst, sites.nearSecond]) assert.deepEqual(stockOf(values, site), [0.5], site.name);
    // Each stock says whose figure it is: the first warehouse its own, the rest none (the default every stock without one shares).
    for (const item of built.holding) assert.equal(item.from, item.site === sites.first.name ? sites.first.name : null, item.node);
    // The model-wide entry in the provenance is the library's default, as it says, not the warehouse's own.
    const wide = built.provenance.find((entry) => entry.entity === 'Every component' && /^Holding cost per/.test(entry.parameter));
    assert.deepEqual([wide.value, wide.basis], [0.5, 'assumed']);
    const own = built.provenance.find((entry) => entry.entity === sites.first.name && entry.parameter === 'Holding cost');
    assert.deepEqual([own.value, own.basis], [0.9, 'user']);
});

test('the first warehouse\'s own stock cover is its alone: the warehouse placed after it aims for the default', () => {
    const { built, sites } = build(({ first }) => setField(first, 'cover', '7'));
    placedFirst(built, sites.first);
    const values = inDocument(built, 'coverDays');
    assert.deepEqual(stockOf(values, sites.first), [7]);
    assert.deepEqual(stockOf(values, sites.second), [3]);
    // And a store's stock room aims for a store's cover.
    for (const site of [sites.nearFirst, sites.nearSecond]) assert.deepEqual(stockOf(values, site), [2], site.name);
    // Its stock as built is what its own cover sets, the other's what the default does.
    const stock = (site) => built.document.nodes.find((node) => node.name === site.name).states.find((state) => state.symbol === 'stock').initialValue;
    const demand = (site) => built.lanes.filter((lane) => lane.kind === 'store' && lane.from === site.name).reduce((sum, lane) => sum + lane.rate, 0);
    assert.ok(Math.abs(stock(sites.second) - 3 * demand(sites.second)) < 1e-9, `${stock(sites.second)} against ${3 * demand(sites.second)}`);
});

test('a store\'s own stock cover reaches neither the other stores nor the warehouses', () => {
    const { built, sites } = build(({ nearFirst, nearSecond }) => {
        setField(nearFirst, 'cover', '4');
        setField(nearSecond, 'cover', '5');
    });
    const values = inDocument(built, 'coverDays');
    assert.deepEqual([...stockOf(values, sites.nearFirst), ...stockOf(values, sites.nearSecond)], [4, 5]);
    for (const site of [sites.first, sites.second]) assert.deepEqual(stockOf(values, site), [3], site.name);
});

test('a cover cut to one category\'s shelf life reaches no other category\'s warehouses', () => {
    // Ambient is placed first, so its warehouses' covers, cut to its shelf life, are the first of their name.
    const categories = defaultCategoryCatalogue();
    setCategoryField(categories.find((category) => category.id === 'ambient'), 'shelfDays', '1.5');
    const { built, sites } = build(() => {}, { categories });
    const values = inDocument(built, 'coverDays');
    for (const site of [sites.first, sites.second]) {
        const nodes = Object.keys(values).filter((name) => name.startsWith(`${site.name}: `));
        assert.equal(nodes.length, 3, JSON.stringify(Object.keys(values)));
        for (const name of nodes) assert.equal(values[name], /Ambient/.test(name) ? 1.5 : 3, name);
    }
});

test('the model builder never gives a placement\'s own parameter the symbol the others share by', () => {
    const builder = new ToolboxModelBuilder(templates, equationHelpers);
    const declared = [{ key: 'holdingCostPerDay', name: 'Holding cost', symbol: 'holdingCostPerDay', value: 0.5, scope: 'project' }];
    const own = builder.resolveShared(declared, {}, { holdingCostPerDay: { own: true, value: 0.9 } }).get('holdingCostPerDay');
    const shared = builder.resolveShared(declared).get('holdingCostPerDay');
    const again = builder.resolveShared(declared).get('holdingCostPerDay');
    assert.notEqual(own, shared);
    assert.equal(shared, again);
    assert.deepEqual([own.value, shared.value], [0.9, 0.5]);
    assert.equal(shared.symbol, 'holdingCostPerDay');
    assert.notEqual(own.symbol, 'holdingCostPerDay');
    // And an alias's own parameter, likewise: stores share theirs by the alias's symbol.
    const alias = { symbol: 'storeCoverDays', name: 'Stock cover target at stores', value: 2 };
    const coverDeclared = [{ key: 'coverDays', name: 'Stock cover target', symbol: 'coverDays', value: 3, scope: 'project' }];
    const ownStore = builder.resolveShared(coverDeclared, {}, { coverDays: { ...alias, own: true, value: 4 } }).get('coverDays');
    const store = builder.resolveShared(coverDeclared, {}, { coverDays: alias }).get('coverDays');
    assert.deepEqual([ownStore.value, store.value, store.symbol], [4, 2, 'storeCoverDays']);
    // A parameter declared for each placement alone (instance) keeps its symbol when it is the first: nothing shares it.
    const instance = [{ key: 'lostShare', name: 'Lost', symbol: 'lostShare', value: 0, scope: 'instance' }];
    assert.equal(builder.resolveShared(instance, {}, { lostShare: { own: true, value: 0.3 } }).get('lostShare').symbol, 'lostShare');
});
