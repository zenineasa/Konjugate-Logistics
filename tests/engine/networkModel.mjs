/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs a network placed as a user places it on the map (three suppliers, two warehouses, twenty stores, a dark
// store and a customer area on an invented city grid, linked as suggested and routed as the window routes) through
// the real engine CLI:
//   - baseline: every stock, queue and rate holds its starting value
//   - a demand surge at the stores of one warehouse: their orders wait, then are delivered
//   - the busiest supply lane closed for ten days, its trucks waiting: its warehouse runs down its stock
// All must conserve goods and trucks, and keep each warehouse's on-order count equal to its lanes.
//
// Usage: node tests/engine/networkModel.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPin, networkSelection, routeLinks, suggestLinks } from '../../packages/toolbox/lib/network.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { buildRoadGraph } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { closurePlan, demandPlan } from '../../packages/toolbox/lib/scenarios.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { gridRoads, randomPoint, seeded } from '../fixtures/roadGrid.mjs';
import { checkInvariants, checkSteady, day, hour, runDocument } from './harness.mjs';

const directory = await mkdtemp(join(tmpdir(), 'konjugateLogisticsNetwork-'));
const templates = await loadTemplates();
const grid = gridRoads({ size: 40, spacing: 400 });
const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(grid.features)));
const pins = [];
const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
add('supplier', grid.at(1, 1), { fields: { supply: 80 } });
add('supplier', grid.at(38, 2));
add('supplier', grid.at(20, 38));
add('warehouse', grid.at(10, 10));
add('warehouse', grid.at(28, 26));
const random = seeded(4);
for (let index = 0; index < 20; index += 1) add('store', randomPoint(random, grid.bounds), { fields: index % 4 === 0 ? { demand: 12 } : {} });
add('darkStore', grid.at(20, 20));
add('customerArea', grid.at(35, 35), { fields: { population: 40000 } });
const links = suggestLinks(pins, [], router);
routeLinks(pins, links, router);
const network = networkSelection(pins, links);
// The importer resolves each pin to a site; with no map data behind them, the pins are the sites.
const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
const selection = Object.fromEntries(Object.entries(network.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));

function build(change = () => {}) {
    const builder = new ModelBuilder(templates);
    const built = buildRegionModel({ builder, selection, route: router.route, links: network.links, options: {} });
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
    assert.equal(plain.built.lanes.length, links.filter((link) => pins.find((pin) => pin.id === link.from).role === 'supplier').length, 'one lane per supply link');
    const baseline = await runDocument(directory, 'network-baseline', plain.document, 30);
    checkInvariants(baseline);
    checkSteady(baseline);
    const window = { start: 5 * day, duration: 10 * day, forkAt: 0, runTime: 30 * day };

    // The stores of the first warehouse sell half as much again for ten days.
    const firstWarehouse = pins.find((pin) => pin.role === 'warehouse').name;
    const itsTowns = plain.built.towns.filter((town) => plain.built.served.some((item) => item.town === town.name && item.zone === firstWarehouse));
    const surge = demandPlan({ towns: itsTowns, change: 0.5, ...window });
    const surged = await runDocument(directory, 'network-surge', build(follow(surge.supplied)).document, 30);
    checkInvariants(surged);
    const backlog = (result, at) => itsTowns.reduce((total, town) => total + result.series(`${town.name}.backlog`)[hour(at)], 0);
    assert.ok(backlog(surged, 14) > 1.2 * backlog(baseline, 14), `surge: orders should wait at the peak (${backlog(surged, 14).toFixed(1)} against ${backlog(baseline, 14).toFixed(1)}).`);
    const ordered = itsTowns.reduce((total, town) => total + surged.series(`${town.name}.ordered`).at(-1) - baseline.series(`${town.name}.ordered`).at(-1), 0);
    assert.ok(Math.abs(ordered - surge.extraTeu) < 0.01 * surge.extraTeu, `surge: ${surge.extraTeu.toFixed(0)} more should be ordered (got ${ordered}).`);

    // The busiest supply lane closed for ten days, its trucks waiting.
    const busiest = [...plain.built.lanes].sort((a, b) => b.rate - a.rate)[0];
    const closed = await runDocument(directory, 'network-closure', build(follow(closurePlan({ lanes: plain.built.lanes, closed: busiest.name, mode: 'wait', ...window }).supplied)).document, 30);
    checkInvariants(closed);
    const stock = (result) => result.series(`${busiest.to}.stock`)[hour(15)];
    assert.ok(stock(closed) < 0.9 * stock(baseline), `closure: ${busiest.to} should run down its stock (${stock(closed).toFixed(1)} against ${stock(baseline).toFixed(1)}).`);

    console.log(`✓ network model from pins and links: ${plain.document.nodes.length} nodes (${pins.length} pins, ${plain.built.lanes.length} lanes) hold still in the baseline; a demand surge at ${firstWarehouse}'s stores orders ${surge.extraTeu.toFixed(0)} more; closing ${busiest.name.replace(/^Road /, '')} runs ${busiest.to} down to ${stock(closed).toFixed(0)}; goods, trucks and orders conserved.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
