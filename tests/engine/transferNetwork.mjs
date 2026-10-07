/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs networks in which one warehouse restocks another, placed as the window places them, through the engine:
//   - a hub and a spoke: the spoke has no supplier of its own and takes all it needs from the hub. The baseline holds
//     still, the hub sending out its own stores' goods and the spoke's
//   - a backup link: each warehouse has its own supplier, and a link from the first to the second carries nothing in
//     the baseline. When the second's supplier makes nothing for ten days, its store runs out if the warehouse waits,
//     and keeps its stock if it orders over the backup, whose vehicles are hired for it; the same when the road from
//     its supplier is closed
// All must conserve goods and the order books, and vehicles where no fleet changes.
//
// Usage: node tests/engine/transferNetwork.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPin, networkProblems, networkSelection, routeLinks } from '../../packages/toolbox/lib/network.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { buildRoadGraph } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { closurePlan, supplierPlan } from '../../packages/toolbox/lib/scenarios.mjs';
import { defaultCatalogue } from '../../packages/toolbox/lib/vehicles.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { gridRoads } from '../fixtures/roadGrid.mjs';
import { checkInvariants, checkSteady, day, hour, runDocument } from './harness.mjs';

const directory = await mkdtemp(join(tmpdir(), 'konjugateLogisticsTransfers-'));
const templates = await loadTemplates();
const grid = gridRoads({ size: 40, spacing: 400 });
const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(grid.features)));
const catalogue = defaultCatalogue();

// Two suppliers, two warehouses and a store at each; `ownSupplier`: the second warehouse has the second supplier,
// else the first supplier supplies everything through the first warehouse. `transfer` is the link between the warehouses.
function network({ ownSupplier, transfer }) {
    const pins = [];
    const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
    const mill = add('supplier', grid.at(2, 2), { name: 'Mill', fields: { supply: ownSupplier ? 30 : 40 } });
    const farm = ownSupplier ? add('supplier', grid.at(36, 4), { name: 'Farm', fields: { supply: 10 } }) : null;
    const hub = add('warehouse', grid.at(10, 10), { name: 'Hub' });
    const spoke = add('warehouse', grid.at(28, 28), { name: 'Spoke' });
    const near = add('store', grid.at(12, 6), { name: 'Near store', fields: { demand: 30 } });
    const far = add('store', grid.at(32, 30), { name: 'Far store', fields: { demand: 10 } });
    const link = (from, to, more = {}) => ({ id: `${from.id}>${to.id}`, from: from.id, to: to.id, basis: 'user', ...more });
    const links = [link(mill, hub), ...(farm ? [link(farm, spoke)] : []), link(hub, near), link(spoke, far), link(hub, spoke, transfer)];
    routeLinks(pins, links, router);
    assert.deepEqual(networkProblems(pins, links, catalogue).filter((problem) => problem.level === 'error'), []);
    const chosen = networkSelection(pins, links, { catalogue });
    const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
    const selection = Object.fromEntries(Object.entries(chosen.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));
    return (change = () => {}) => {
        const builder = new ModelBuilder(templates);
        const built = buildRegionModel({ builder, selection, route: router.route, links: chosen.links, options: { vehicles: chosen.vehicles, unit: chosen.unit } });
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
const lowest = (result, key) => Math.min(...result.series(key)) / result.series(key)[0];

try {
    // ---- a hub and a spoke.
    const hubAndSpoke = network({ ownSupplier: false, transfer: {} })();
    const standing = hubAndSpoke.built.lanes.find((lane) => lane.name === 'Road Hub → Spoke');
    assert.ok(standing.kind === 'transfer' && Math.abs(standing.rate - 10) < 1e-9 && standing.fleet >= 1);
    const steady = await runDocument(directory, 'transfer-hub', hubAndSpoke.document, 30);
    assert.equal(checkInvariants(steady).parts, 1, 'one network, joined up through the link between its warehouses');
    checkSteady(steady);
    assert.ok(Math.abs(steady.series('Road Hub → Spoke.arriving')[hour(20)] - 10) < 1e-6, 'the spoke receives its ten pallets a day from the hub');

    // ---- a backup link: nothing in the baseline.
    const build = network({ ownSupplier: true, transfer: { backup: true } });
    const { built, document } = build();
    const backup = built.lanes.find((lane) => lane.name === 'Road Hub → Spoke');
    assert.deepEqual([backup.standby, backup.rate, backup.fleet], [true, 0, 0]);
    const baseline = await runDocument(directory, 'transfer-backup-baseline', document, 30);
    checkInvariants(baseline);
    checkSteady(baseline);
    assert.ok(Math.max(...baseline.series('Road Hub → Spoke.arriving')) < 1e-9, 'the backup carries nothing in the baseline');

    // The farm makes nothing for ten days. Waiting, the far store runs out; ordering elsewhere, the spoke orders over
    // the backup, which hires vehicles, and the far store keeps its stock.
    const suppliers = built.ports.filter((port) => port.supplier);
    const waitPlan = supplierPlan({ lanes: built.lanes, suppliers, chosen: ['Farm'], short: 1, mode: 'wait', ...window });
    assert.deepEqual(waitPlan.supplied.fleetSize.entities, ['Road Farm → Spoke'], 'no fleet changes: the lane named keeps the one it has');
    const waitRun = await runDocument(directory, 'transfer-wait', build(follow(waitPlan.supplied)).document, 30);
    checkInvariants(waitRun);
    const elsewherePlan = supplierPlan({ lanes: built.lanes, suppliers, chosen: ['Farm'], short: 1, mode: 'otherSuppliers', ...window });
    assert.deepEqual(elsewherePlan.reroutedTo, ['Road Hub → Spoke']);
    assert.deepEqual(elsewherePlan.supplied.fleetSize.entities, ['Road Hub → Spoke']);
    const hiredFor = elsewherePlan.supplied.fleetSize.samples['Road Hub → Spoke'].find(([time]) => time === window.start)[1];
    assert.ok(hiredFor >= 1, `the backup hires vehicles for the ten pallets a day (${hiredFor})`);
    const elsewhereRun = await runDocument(directory, 'transfer-elsewhere', build(follow(elsewherePlan.supplied)).document, 30);
    checkInvariants(elsewhereRun, { fleetsChange: true });
    const [waited, ordered] = [waitRun, elsewhereRun].map((result) => lowest(result, 'Far store stock.stock'));
    assert.ok(waited < 0.05, `waiting: the far store runs out (${(100 * waited).toFixed(0)}% of its stock at the lowest).`);
    assert.ok(ordered > 0.5, `over the backup: the far store keeps most of its stock (${(100 * ordered).toFixed(0)}% at the lowest).`);
    const carried = Math.max(...elsewhereRun.series('Road Hub → Spoke.arriving'));
    assert.ok(carried > 8, `the backup carries the spoke's ten pallets a day (${carried.toFixed(1)} at most).`);
    assert.ok(elsewhereRun.series('Road Hub → Spoke.arriving').at(-1) < 0.5, 'and nothing again once the farm is back');

    // The road from the farm closed instead, the spoke ordering from its other sources: the backup again.
    const closure = closurePlan({ lanes: built.lanes, closed: 'Road Farm → Spoke', mode: 'otherPorts', ...window });
    assert.deepEqual(closure.reroutedTo, ['Road Hub → Spoke']);
    const closedRun = await runDocument(directory, 'transfer-closure', build(follow(closure.supplied)).document, 30);
    checkInvariants(closedRun, { fleetsChange: true });
    assert.ok(lowest(closedRun, 'Far store stock.stock') > 0.5, `road closed: the far store keeps most of its stock over the backup (${(100 * lowest(closedRun, 'Far store stock.stock')).toFixed(0)}%).`);

    console.log(`✓ network with links between warehouses: a hub restocks a spoke with 10 pallets a day and the baseline holds still; a backup link carries nothing until the spoke's supplier makes nothing, when the far store falls to ${(100 * waited).toFixed(0)}% of its stock waiting and keeps ${(100 * ordered).toFixed(0)}% ordering over the backup (${hiredFor} vehicles hired, ${carried.toFixed(1)} pallets a day at most), and ${(100 * lowest(closedRun, 'Far store stock.stock')).toFixed(0)}% when the road from its supplier is closed; goods, vehicles and orders conserved.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
