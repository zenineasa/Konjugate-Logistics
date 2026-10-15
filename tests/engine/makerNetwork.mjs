/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs a network with a maker, placed as the window places it, through the engine: a mill sends flour to a bakery,
// which bakes bread from it (0.8 pallets of flour to a pallet of bread) for a depot and its stores. Flour keeps half a
// year, bread two days. The baseline holds still, the bakery using flour as it bakes and ordering it as it uses it.
// Then the mill's road is closed for ten days:
//   - with two weeks of flour in its store, the bakery bakes on and the stores keep their bread
//   - with two days of flour, it runs out and so do the stores, and they fill again only as fast as the bakery can catch
//     up, baking at its most: the break the store's size decides, and its length what the bakery can bake
// And what it makes is what the flour supplied allows: a mill supplying more flour than the bakery was set to use has
// it use all of it, and make as much more.
// All must conserve each category's goods (flour leaving as it is used, bread entering as it is baked) and the orders.
//
// Usage: node tests/engine/makerNetwork.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { categoriesForModel, createCategory, setMix } from '../../packages/toolbox/lib/categories.mjs';
import { createPin, networkProblems, networkSelection, routeLinks } from '../../packages/toolbox/lib/network.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { buildRoadGraph } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { closurePlan } from '../../packages/toolbox/lib/scenarios.mjs';
import { defaultCatalogue } from '../../packages/toolbox/lib/vehicles.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { gridRoads } from '../fixtures/roadGrid.mjs';
import { checkInvariants, checkSteady, day, hour, runDocument } from './harness.mjs';

const directory = await mkdtemp(join(tmpdir(), 'konjugateLogisticsMakers-'));
const templates = await loadTemplates();
const grid = gridRoads({ size: 40, spacing: 400 });
const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(grid.features)));
const catalogue = defaultCatalogue();
const categories = [createCategory({ id: 'bread', name: 'Bread', share: 50, shelfDays: 2 }), createCategory({ id: 'flour', name: 'Flour', share: 50, shelfDays: 180 })];

// `cover`: days of flour the bakery aims to hold; `millSupply`: what the mill supplies a day.
function network({ cover, millSupply = 32 }) {
    const pins = [];
    const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
    const mill = add('supplier', grid.at(2, 2), { name: 'Mill', fields: { supply: millSupply } });
    setMix(mill, 'bread', 0, categories);
    const bakery = add('maker', grid.at(12, 10), { name: 'Bakery', fields: { supply: 40, perUnit: 0.8, cover, makingDays: 0.25 } });
    bakery.recipe = { makes: 'bread', uses: 'flour' };
    const depot = add('warehouse', grid.at(26, 24), { name: 'Depot' });
    const stores = [[30, 30], [22, 34]].map(([x, y], index) => {
        const store = add('store', grid.at(x, y), { name: `Store ${index + 1}`, fields: { demand: 20 } });
        setMix(store, 'flour', 0, categories);
        return store;
    });
    const link = (from, to) => ({ id: `${from.id}>${to.id}`, from: from.id, to: to.id, basis: 'user' });
    const links = [link(mill, bakery), link(bakery, depot), ...stores.map((store) => link(depot, store))];
    routeLinks(pins, links, router);
    assert.deepEqual(networkProblems(pins, links, catalogue, categories).filter((problem) => problem.level === 'error'), []);
    const chosen = networkSelection(pins, links, { catalogue, categories });
    const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
    const selection = Object.fromEntries(Object.entries(chosen.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));
    return (change = () => {}) => {
        const builder = new ModelBuilder(templates);
        const built = buildRegionModel({ builder, selection, route: router.route, links: chosen.links, options: { vehicles: chosen.vehicles, unit: chosen.unit, categories: categoriesForModel(categories) } });
        change(builder, built);
        return { built, document: builder.document({ days: 30, stepDays: 15 / 1440, outputDays: 1 / 24 }) };
    };
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
const window = { start: 5 * day, duration: 10 * day, forkAt: 0, runTime: 30 * day };
const lowest = (result, key, from = 5, to = 20) => Math.min(...result.series(key).slice(hour(from), hour(to)));

try {
    // ---- the baseline: flour used as bread is baked, the bakery's store ordering it as it is used.
    const build = network({ cover: 14 });
    const { built, document } = build();
    const flourLane = built.lanes.find((lane) => lane.name === 'Road Mill → Bakery: Flour');
    const breadLane = built.lanes.find((lane) => lane.name === 'Road Bakery → Depot: Bread');
    assert.ok(flourLane && breadLane, built.lanes.map((lane) => lane.name).join(', '));
    // 40 pallets of bread a day from 32 of flour: what the mill supplies is what the bakery uses.
    assert.ok(Math.abs(flourLane.rate - 32) < 1e-9 && Math.abs(breadLane.rate - 40) < 1e-9, `${flourLane.rate} of flour, ${breadLane.rate} of bread`);
    assert.ok(document.nodes.some((node) => node.type === 'Maker' && node.name === 'Bakery: Bread'), 'the bakery bakes as a maker');
    assert.ok(document.nodes.some((node) => node.type === 'Warehouse' && node.name === 'Bakery: Flour'), 'and holds its flour as a store');
    const baseline = await runDocument(directory, 'maker-baseline', document, 30);
    assert.equal(checkInvariants(baseline).parts, 1, 'one network: the flour joined to the bread through the bakery');
    checkSteady(baseline);
    const used = baseline.series('Bakery: Bread.used');
    const made = baseline.series('Bakery: Bread.made');
    assert.ok(Math.abs((used.at(-1) - used[0]) / (made.at(-1) - made[0]) - 0.8) < 1e-6, 'it uses 0.8 of flour for each pallet of bread it makes');
    assert.ok(Math.abs(baseline.series('Bakery: Flour.stock')[0] - 32 * 14) < 1e-6, 'two weeks of flour in store');

    // ---- the mill's road closed for ten days: the bakery waits for it.
    const closure = (cover) => closurePlan({ lanes: network({ cover })().built.lanes, closed: 'Road Mill → Bakery: Flour', mode: 'wait', ...window });
    const long = await runDocument(directory, 'maker-closed-long', build(follow(closure(14).supplied)).document, 30);
    checkInvariants(long);
    const short = await runDocument(directory, 'maker-closed-short', network({ cover: 2 })(follow(closure(2).supplied)).document, 30);
    checkInvariants(short);
    const shelves = (result) => lowest(result, 'Store 1 stock: Bread.stock') / result.series('Store 1 stock: Bread.stock')[0];
    const flourLeft = lowest(long, 'Bakery: Flour.stock') / long.series('Bakery: Flour.stock')[0];
    assert.ok(flourLeft > 0.1 && flourLeft < 0.5, `with two weeks of flour the store runs down but not out (${(100 * flourLeft).toFixed(0)}% at the lowest)`);
    assert.ok(shelves(long) > 0.95, `and the stores keep their bread (${(100 * shelves(long)).toFixed(0)}% at the lowest)`);
    assert.ok(shelves(short) < 0.1, `with two days of flour the stores run out of bread (${(100 * shelves(short)).toFixed(0)}% at the lowest)`);
    assert.ok(lowest(short, 'Bakery: Flour.stock') < 0.01 * short.series('Bakery: Flour.stock')[0], 'the bakery\'s flour gone');
    // Once the road reopens, a bakery that ran out bakes at its most (half as much again as usual) until it has caught
    // up with the orders that waited, so the stores fill slowly: what it can bake decides how long the break lasts.
    const bakedAfter = short.series('Bakery: Bread.makeRate')[hour(18)];
    assert.ok(Math.abs(bakedAfter - 60) < 0.5, `after the reopening it bakes at its most, 60 a day (${bakedAfter.toFixed(1)})`);
    const refilled = short.series('Store 1 stock: Bread.stock');
    assert.ok(refilled[hour(29)] > 3 * refilled[hour(20)], `and the stores fill again (${refilled[hour(20)].toFixed(1)} on day 20, ${refilled[hour(29)].toFixed(1)} on day 29)`);

    // ---- a mill supplying more than the bakery was set to use: it uses all of it, and bakes as much more.
    const more = network({ cover: 14, millSupply: 40 })();
    const moreBread = more.built.lanes.find((lane) => lane.name === 'Road Bakery → Depot: Bread');
    assert.ok(Math.abs(moreBread.rate - 50) < 1e-9, `40 of flour makes 50 of bread (${moreBread.rate})`);
    assert.match(more.built.warnings.join(' '), /Flour: what Bakery would use \(32 pallets\/day, for what it is set to make\) differs from what the suppliers and ports supply \(40 pallets\/day\); it uses what is supplied, 1\.25 times as much, and makes as much more\./);
    const moreRun = await runDocument(directory, 'maker-more', more.document, 30);
    checkInvariants(moreRun);
    checkSteady(moreRun);

    console.log(`✓ network with a maker: a bakery bakes 40 pallets of bread a day from 32 of flour, 0.8 a pallet, and the baseline holds still; with the mill's road closed for ten days, two weeks of flour in store runs down to ${(100 * flourLeft).toFixed(0)}% and the stores keep ${(100 * shelves(long)).toFixed(0)}% of their bread, while two days of flour runs out, the stores fall to ${(100 * shelves(short)).toFixed(0)}% and fill again only as the bakery catches up at its most, ${bakedAfter.toFixed(0)} a day; a mill supplying 40 of flour has it bake 50; each category's goods and the orders conserved.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
