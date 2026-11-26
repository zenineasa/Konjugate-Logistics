/* Copyright © 2026 Zenin Easa Panthakkalakath */

// How these costs are worked out (lib/costs.mjs): every cost a result reports has its rule and its inputs, and each
// input's value and where it came from are the model's as built, which are the network's own figures.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { explainCosts, notIncluded, reportedCosts } from '../../packages/toolbox/lib/costs.mjs';
import { costParts } from '../../packages/toolbox/lib/summary.mjs';
import { categoriesForModel, defaultCategoryCatalogue, setCategoryField } from '../../packages/toolbox/lib/categories.mjs';
import { createPin, networkSelection, routeLinks, setCandidate, setField, suggestLinks } from '../../packages/toolbox/lib/network.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { buildRoadGraph } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { defaultCatalogue, setVehicleField } from '../../packages/toolbox/lib/vehicles.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { gridRoads } from '../fixtures/roadGrid.mjs';

const toolboxSource = await readFile(new URL('../../packages/toolbox/toolbox.mjs', import.meta.url), 'utf8');
const templates = await loadTemplates();
const grid = gridRoads({ size: 20, spacing: 400 });
const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(grid.features)));

// A network of three categories with figures of the user's and assumed ones mixed: a heavy truck's cost per km and a
// warehouse's holding cost given, a store's value of a pallet sold and Chilled's own value, and a candidate warehouse
// with a fixed cost a month and a cost to open (left out of the model, as candidates are).
function placed() {
    const vehicles = defaultCatalogue();
    setVehicleField(vehicles.find((type) => type.id === 'heavyTruck'), 'costPerKm', '2.2');
    const categories = defaultCategoryCatalogue();
    setCategoryField(categories.find((category) => category.id === 'chilled'), 'saleValue', '2500');
    const pins = [];
    const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
    add('supplier', grid.at(1, 1), { fields: { supply: 40 } });
    const warehouse = add('warehouse', grid.at(8, 8), { fields: { capacity: 200 } });
    setField(warehouse, 'holdingCost', '0.7');
    add('store', grid.at(12, 4), { fields: { demand: 30 } });
    const shop = add('store', grid.at(4, 14), { fields: { demand: 10 } });
    setField(shop, 'saleValue', '1500');
    add('customerArea', grid.at(14, 14), { fields: { demand: 2 } });
    const candidate = add('warehouse', grid.at(16, 3));
    setCandidate(candidate, true);
    setField(candidate, 'fixedCost', '2000');
    setField(candidate, 'openingCost', '50000');
    const links = suggestLinks(pins, [], router);
    routeLinks(pins, links, router);
    const network = networkSelection(pins, links, { catalogue: vehicles, categories });
    const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
    const selection = Object.fromEntries(Object.entries(network.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));
    const built = buildRegionModel({ builder: new ModelBuilder(templates), selection, route: router.route, links: network.links, options: { vehicles: network.vehicles, unit: network.unit, categories: network.categories } });
    return { pins, links, vehicles, categories, built };
}
const totals = {
    transport: { baseline: 100, scenario: 120 }, fleet: { baseline: 50, scenario: 50 }, holding: { baseline: 10, scenario: 8 },
    backlog: { baseline: 1, scenario: 30 }, lostValue: { baseline: 0, scenario: 4000 }, lost: { baseline: 0, scenario: 4 }, fill: { baseline: 1, scenario: 0.9 }
};
const result = { start: 5, days: 85, describe: 'Warehouse 1 → Store 1 closed from day 5 for 10 days.', totals };

test('every cost the results report has its rule, and the window labels its cost rows from the same list', () => {
    const { pins, links, vehicles, categories, built } = placed();
    const explained = explainCosts({ built, network: { pins, links, vehicles, categories }, result, sites: { rows: [{}] } });
    assert.deepEqual(explained.costs.map((cost) => cost.key), reportedCosts.map((cost) => cost.key));
    for (const cost of explained.costs) assert.ok(cost.how.length > 60 && cost.label, `${cost.key} is explained`);
    // The parts of the running cost in the headline, and every cost the summary sums from the model's states.
    const keys = new Set(explained.costs.map((cost) => cost.key));
    for (const [key] of costParts) assert.ok(keys.has(key), key);
    const signals = JSON.parse(/const summarySignals = (\[[^\]]+\])/.exec(toolboxSource)[1].replace(/'/g, '"'));
    const fromSignal = { transportCost: 'transport', fleetCost: 'fleet', holdingCost: 'holding', backlogCost: 'backlog' };
    for (const signal of signals.filter((name) => /Cost$/.test(name))) assert.ok(keys.has(fromSignal[signal]), `${signal} is summarised and explained`);
    // No cost row in a result is labelled by hand: each comes from reportedCosts, so a new one needs an explanation.
    const handLabelled = [...toolboxSource.matchAll(/totalsRow\(\s*(['`])([^'`]*)\1/g)].map((match) => match[2]).filter((label) => /cost|value/i.test(label));
    assert.deepEqual(handLabelled, []);
    for (const key of ['transport', 'fleet', 'holding', 'running', 'lostValue', 'backlog']) assert.ok(new RegExp(`costLabel\\('${key}'\\)|\\['transport', 'fleet', 'holding'\\]`).test(toolboxSource), key);
    // The site comparison's columns are explained: cost a month, fixed and the cost to open.
    assert.match(toolboxSource, /cost a month<\/th>/);
    // Without a comparison and no candidate, its costs are not listed.
    const plain = explainCosts({ built, network: { pins: pins.filter((pin) => !pin.proposed), links, vehicles, categories }, result });
    assert.deepEqual(plain.costs.map((cost) => cost.key), ['transport', 'fleet', 'holding', 'running', 'lostValue', 'backlog']);
});

test('each input is the model\'s as built, which is the network\'s own figure, with where it came from and where it is set', () => {
    const { pins, links, vehicles, categories, built } = placed();
    const explained = explainCosts({ built, network: { pins, links, vehicles, categories }, result, sites: { rows: [{}] } });
    const cost = (key) => explained.costs.find((item) => item.key === key);
    const input = (key, name) => cost(key).inputs.find((item) => item.name === name);
    // Vehicles: each type on the links, its costs as the catalogue has them, yours or assumed.
    const used = [...new Set(built.lanes.flatMap((lane) => (lane.vehicles ?? []).map((item) => item.type)))];
    for (const id of used) {
        const type = vehicles.find((each) => each.id === id);
        const perKm = input('transport', `${type.name}: cost per km`);
        const perDay = input('fleet', `${type.name}: cost per day`);
        assert.deepEqual([perKm.value, perKm.basis], [type.fields.costPerKm.value, type.fields.costPerKm.basis === 'user' ? 'yours' : 'assumed'], type.name);
        assert.deepEqual([perDay.value, perDay.basis], [type.fields.costPerDay.value, 'assumed']);
        assert.deepEqual([perKm.target, perDay.target], [{ kind: 'vehicle', id, field: 'costPerKm' }, { kind: 'vehicle', id, field: 'costPerDay' }]);
        // How many the build put on the links: the categories' shares add up to whole vehicles.
        const count = built.lanes.reduce((sum, lane) => sum + (lane.vehicles ?? []).filter((item) => item.type === id).reduce((all, item) => all + item.fleet, 0), 0);
        assert.match(perDay.note, new RegExp(`^${Math.round(count)} on the links as built\\.$`));
    }
    assert.equal(input('transport', 'Heavy truck: cost per km').value, 2.2);
    assert.equal(input('transport', 'Heavy truck: cost per km').basis, 'yours');
    // Every link once, however many categories it carries: its routed distance, and the link it is set on.
    const linkNames = [...new Set(built.lanes.map((lane) => `${lane.fromSite} → ${lane.site}`))];
    const distances = cost('transport').inputs.filter((item) => / distance$/.test(item.name));
    assert.deepEqual(distances.map((item) => item.name.replace(/: distance$/, '')), linkNames);
    for (const item of distances) {
        const lane = built.lanes.find((each) => `${each.fromSite} → ${each.site}: distance` === item.name);
        const link = links.find((each) => each.id === item.target.id);
        assert.deepEqual([item.value, item.basis, item.unit], [lane.kilometres, 'routed', 'km']);
        assert.deepEqual([pins.find((pin) => pin.id === link.from).name, pins.find((pin) => pin.id === link.to).name], [lane.fromSite, lane.site]);
    }
    assert.match(distances.find((item) => /Store 1/.test(item.name)).note, /Carried by medium trucks and refrigerated trucks\./);
    // Holding: the warehouse's own 0.7, set on its card; the stores' stock rooms at the figure the model links them to,
    // the default every stock without one of its own shares (not the warehouse's own: see the next test).
    const warehouse = pins.find((pin) => pin.name === 'Warehouse 1');
    assert.deepEqual(input('holding', 'Warehouse 1'), { name: 'Warehouse 1', value: 0.7, unit: 'a pallet a day', basis: 'yours', target: { kind: 'site', id: warehouse.id, field: 'holdingCost' } });
    const rooms = input('holding', 'Stock rooms of Store 1 and Store 2');
    assert.deepEqual([rooms.value, rooms.basis, rooms.target], [0.5, 'assumed', null]);
    assert.match(rooms.note, /^The figure every stock without one of its own shares, a default\. A store's card has no holding cost of its own\.$/);
    assert.ok(!cost('holding').inputs.some((item) => /component library/.test(item.note ?? '')), 'never the library default the provenance claims');
    assert.ok(explained.knownLimits.some((item) => /A store or a dark store has no holding cost of its own/.test(item)));
    assert.ok(explained.knownLimits.some((item) => /value of a pallet sold is not yet in the model's record/.test(item)));
    // Sales lost: each store's share lost when short, and its value of a pallet sold, by category where they differ.
    const shop = pins.find((pin) => pin.name === 'Store 2');
    assert.deepEqual(input('lostValue', 'Store 2: sales lost when out'), { name: 'Store 2: sales lost when out', value: 80, unit: '%', basis: 'assumed', target: { kind: 'site', id: shop.id, field: 'lostSales' } });
    const values = cost('lostValue').inputs.filter((item) => /value of a pallet sold$/.test(item.name));
    for (const store of built.stores) {
        const category = built.categories.find((each) => each.id === store.category).name;
        const row = values.find((item) => item.name === `${store.site}, ${category}: value of a pallet sold`);
        assert.equal(row.value, store.saleValue, `${store.name} is priced as the summary prices it`);
    }
    assert.deepEqual(values.find((item) => item.name === 'Store 2, Ambient: value of a pallet sold').value, 1500);
    assert.deepEqual(values.find((item) => item.name === 'Store 2, Ambient: value of a pallet sold').basis, 'yours');
    const chilled = values.find((item) => item.name === 'Store 1, Chilled: value of a pallet sold');
    assert.deepEqual([chilled.value, chilled.basis, chilled.target], [2500, 'yours', { kind: 'category', id: 'chilled', field: 'saleValue' }]);
    assert.equal(values.find((item) => item.name === 'Store 1, Ambient: value of a pallet sold').basis, 'assumed');
    // Backlog: the model-wide charge, assumed, set nowhere in the window.
    assert.deepEqual(cost('backlog').inputs.map((item) => [item.value, item.basis, item.target]), [[5, 'assumed', null]]);
    // The candidate's fixed cost and cost to open, from its card; the warehouse in use gave none.
    const candidate = pins.find((pin) => pin.proposed);
    assert.deepEqual(cost('fixed').inputs.map((item) => [item.name, item.value, item.basis]), [['Warehouse 1', null, 'none'], [candidate.name, 2000, 'yours']]);
    assert.deepEqual(cost('opening').inputs.map((item) => [item.name, item.value, item.basis, item.target.field]), [[candidate.name, 50000, 'yours', 'openingCost']]);
    // The candidate is not in the model, so none of its links' distances are.
    assert.ok(!distances.some((item) => item.name.includes(candidate.name)));
});

// Each stock and the holding cost a pallet a day its node is really linked to in the model's document.
function holdingInDocument(built) {
    const shared = new Map(built.document.sharedParameters.map((item) => [item.id, item]));
    return new Map(built.document.nodes.map((node) => [node.name, node.sourceTerms.flatMap((term) => term.parameters ?? []).find((parameter) => parameter.symbol === 'holdingCostPerDay')])
        .filter(([, parameter]) => parameter).map(([name, parameter]) => [name, shared.get(parameter.sharedParameterId).value]));
}

test('a stock without a holding cost of its own is shown at the figure its node is linked to, and whose figure that is', () => {
    // Two warehouses, the one placed first in the model with a holding cost of its own: the stock that has none of its own
    // (the other warehouse, the stores) is linked to the default, not to it, as it was until 26 November 2026.
    const build = ({ own }) => {
        const vehicles = defaultCatalogue();
        const pins = [];
        const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
        add('supplier', grid.at(1, 1), { fields: { supply: 40 } });
        const first = add('warehouse', grid.at(6, 6));
        const second = add('warehouse', grid.at(14, 14));
        if (own) setField(first, 'holdingCost', '0.9');
        add('store', grid.at(4, 8), { fields: { demand: 20 } });
        add('store', grid.at(16, 12), { fields: { demand: 10 } });
        const links = suggestLinks(pins, [], router);
        routeLinks(pins, links, router);
        const network = networkSelection(pins, links, { catalogue: vehicles });
        const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
        const selection = Object.fromEntries(Object.entries(network.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));
        const built = buildRegionModel({ builder: new ModelBuilder(templates), selection, route: router.route, links: network.links, options: { vehicles: network.vehicles, unit: network.unit } });
        return { pins, links, vehicles, built, first, second };
    };
    let firstWithOwn = false;
    for (const own of [true, false]) {
        const { pins, links, vehicles, built, first, second } = build({ own });
        // The record says what the document does: every stock's value is the one its node's parameter holds.
        const inDocument = holdingInDocument(built);
        assert.equal(built.holding.length, inDocument.size);
        for (const item of built.holding) assert.equal(item.value, inDocument.get(item.node), item.node);
        const explained = explainCosts({ built, network: { pins, links, vehicles, categories: [] } });
        const rows = explained.costs.find((cost) => cost.key === 'holding').inputs;
        const row = (name) => rows.find((item) => item.name === name);
        if (own) {
            firstWithOwn = built.holding.find((item) => !item.store).site === first.name;
            // Its own 0.9 is its alone: the other warehouse and both stock rooms are at the default, said to be one.
            assert.deepEqual([row(first.name).value, row(first.name).basis, row(first.name).note], [0.9, 'yours', undefined]);
            assert.deepEqual([row(second.name).value, row(second.name).basis, row(second.name).target], [0.5, 'assumed', { kind: 'site', id: second.id, field: 'holdingCost' }]);
            const rooms = row('Stock rooms of Store 1 and Store 2');
            assert.deepEqual([rooms.value, rooms.basis, rooms.target], [0.5, 'assumed', null]);
            assert.match(rooms.note, /^The figure every stock without one of its own shares, a default\./);
            // The provenance's model-wide entry is the library's default, as it says.
            assert.equal(built.provenance.find((entry) => entry.entity === 'Every component' && entry.parameter === 'Holding cost per pallet-day').value, 0.5);
        } else {
            for (const item of rows) assert.deepEqual([item.value, item.basis], [0.5, 'assumed'], item.name);
        }
        assert.ok(rows.every((item) => item.value === inDocument.get(built.holding.find((each) => item.name.includes(each.site))?.node)), JSON.stringify(rows));
    }
    assert.ok(firstWithOwn, 'the warehouse with its own figure is placed first, so the case that once leaked is the one tested');
});

test('the figures are the run shown\'s, with the run set beside it, and the notes say what they are of', () => {
    const { pins, links, vehicles, categories, built } = placed();
    const network = { pins, links, vehicles, categories };
    const compared = { number: 1, describe: 'Normal weeks.', totals: { ...totals, transport: { baseline: 100, scenario: 90 } }, sameBuild: true };
    const explained = explainCosts({ built, network, result, compared });
    const figures = (key) => explained.costs.find((item) => item.key === key).figures;
    assert.deepEqual(figures('transport'), { scenario: 120, baseline: 100, compared: 90 });
    assert.deepEqual(figures('running'), { scenario: 178, baseline: 160, compared: 148 });
    assert.deepEqual(figures('lostValue'), { scenario: 4000, baseline: 0, compared: 4000 });
    assert.deepEqual(explained.notes, [
        'Counted from day 5 to the end of the run, 85 days.',
        'The baseline and the scenario follow the same rules on the same inputs, apart from what the scenario changed: Warehouse 1 → Store 1 closed from day 5 for 10 days.',
        'Run 1 ran on the same build, so on these inputs, apart from what its scenario changed.'
    ]);
    // As planned there is no baseline; a run on another build, or a network built again or changed since, says so.
    const planned = explainCosts({ built, network, result: { ...result, absolute: true } });
    assert.deepEqual(planned.costs[0].figures, { scenario: 120 });
    assert.match(planned.notes[1], /^The network as planned/);
    assert.match(explainCosts({ built, network, result, compared: { ...compared, sameBuild: false } }).notes[2], /as it was built then: its inputs may differ/);
    assert.match(explainCosts({ built, network, result, builtAgain: true }).notes.at(-1), /built again after this run/);
    assert.match(explainCosts({ built, network, result, edited: true }).notes.at(-1), /changed the network after it was built/);
    assert.equal(explainCosts({ built: null, network, result }), null);
});

test('what the costs leave out is said, and no text has an em dash', () => {
    const { pins, links, vehicles, categories, built } = placed();
    const explained = explainCosts({ built, network: { pins, links, vehicles, categories }, result, sites: { rows: [{}] } });
    for (const words of ['Congestion', 'Drivers as people', 'Changes in prices', 'What the goods cost to buy or make', 'customer area', 'Fixed costs']) assert.ok(notIncluded.some((item) => item.includes(words)), words);
    const text = JSON.stringify(explained);
    assert.ok(!text.includes('\u2014'), 'no em dash');
    assert.doesNotMatch(text, /, and (?:the|a) [a-z]+ (?:or|and) /, 'no Oxford comma in a list of three');
});

test('a model of two truck sizes and no vehicle catalogue lists the truck costs the model has', () => {
    const built = {
        unit: 'TEU', vehicles: null, stores: [], lanes: [{ name: 'Road Port → Zone', kind: 'supply', from: 'Port', to: 'Zone', kilometres: 40, basis: 'routed' }],
        provenance: [
            { entity: 'Every component', parameter: 'Truck cost per km', value: 1.5, unit: 'cost/km', basis: 'assumed' },
            { entity: 'Every component', parameter: 'Cost per truck per day', value: 0, unit: 'cost/day', basis: 'assumed' },
            { entity: 'Road Port → Zone', parameter: 'Distance', value: 40, unit: 'km', basis: 'routed' }
        ]
    };
    const explained = explainCosts({ built });
    assert.deepEqual(explained.costs.find((cost) => cost.key === 'transport').inputs.map((item) => [item.name, item.value, item.basis]), [['Truck cost per km', 1.5, 'assumed'], ['Port → Zone: distance', 40, 'routed']]);
    assert.deepEqual(explained.costs.find((cost) => cost.key === 'fleet').inputs.map((item) => [item.name, item.value]), [['Cost per truck per day', 0]]);
});
