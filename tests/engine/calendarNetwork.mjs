/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs a small network whose sites keep hours (a supplier, a warehouse and a store on an invented city grid, placed as
// the window places them) through the engine:
//   - a store open 8 to 22, Monday to Saturday: it sells nothing while it is closed, and a week's sales are what they
//     would be round the clock
//   - a store that receives only from 6 to 9 in the morning, restocked from a warehouse that dispatches from 9 to 17:
//     its goods reach its door after it has stopped receiving and wait there until the next morning, so with little
//     room for stock it runs short; a warehouse that dispatches from 2 to 6 at night reaches it in time
//   - small vehicles that deliver by day (mini-vans from 8 to 20) to a store with its own timing: one that receives
//     from 6 to 9 gets nothing the day it is loaded and runs short; one that receives from 10 to 14 is restocked in time
//   - a festival in the network's calendar: three days of demand up by four fifths, the three days before by a third,
//     the supplier not dispatching while it lasts. The store loses sales over it; with room and cover for more stock
//     it loses far fewer
// All must conserve goods, vehicles and the order books.
//
// Usage: node tests/engine/calendarNetwork.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setHours } from '../../packages/toolbox/lib/calendars.mjs';
import { createPin, networkProblems, networkSelection, routeLinks } from '../../packages/toolbox/lib/network.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { buildRoadGraph } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { defaultCatalogue, setVehicleHours } from '../../packages/toolbox/lib/vehicles.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { gridRoads } from '../fixtures/roadGrid.mjs';
import { checkInvariants, checkSteady, day, hour, runDocument } from './harness.mjs';

const directory = await mkdtemp(join(tmpdir(), 'konjugateLogisticsCalendars-'));
const templates = await loadTemplates();
const grid = gridRoads({ size: 40, spacing: 400 });
const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(grid.features)));
const days = 28;

// The network, its hours set by `keep(pins)`: { supplier, warehouse, store }.
function network(keep = () => {}, holidays = null) {
    const catalogue = defaultCatalogue();
    const pins = [];
    const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
    const supplier = add('supplier', grid.at(2, 2), { name: 'Mill', fields: { supply: 20 } });
    const warehouse = add('warehouse', grid.at(12, 12), { name: 'Depot' });
    // A store with room for a day and a quarter of what it sells.
    const store = add('store', grid.at(30, 30), { name: 'Shop', fields: { demand: 20, capacity: 25 } });
    const link = (from, to) => ({ id: `${from.id}>${to.id}`, from: from.id, to: to.id, basis: 'user' });
    const links = [link(supplier, warehouse), link(warehouse, store)];
    keep({ supplier, warehouse, store, catalogue, toStore: links[1] });
    routeLinks(pins, links, router);
    assert.deepEqual(networkProblems(pins, links, catalogue).filter((problem) => problem.level === 'error'), []);
    const chosen = networkSelection(pins, links, { catalogue, holidays });
    const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
    const selection = Object.fromEntries(Object.entries(chosen.selection).map(([group, entries]) => [group, entries.map((entry) => ({ ...entry, kind: kinds[group], user: true }))]));
    const builder = new ModelBuilder(templates);
    const built = buildRegionModel({ builder, selection, route: router.route, links: chosen.links, options: { vehicles: chosen.vehicles, unit: chosen.unit, days, holidays: chosen.holidays ?? null } });
    return { built, document: builder.document({ days, stepDays: 15 / 1440, outputDays: 1 / 24 }) };
}
const total = (result, key, from = 0) => result.series(key).at(-1) - result.series(key)[hour(from)];

try {
    // ---- with no hours kept, as before: the baseline holds still.
    const plain = network();
    assert.ok(!plain.document.sharedParameters.some((shared) => shared.schedule), 'no site keeps hours: no schedule');
    const still = await runDocument(directory, 'calendar-none', plain.document, days);
    checkInvariants(still);
    checkSteady(still);

    // ---- a store open 8 to 22, Monday to Saturday.
    const opened = network(({ store }) => { setHours(store, 'open', { from: 8, to: 22 }); setHours(store, 'open', { day: 6, on: false }); });
    const pattern = opened.document.sharedParameters.find((shared) => shared.name === 'Shop is open');
    assert.deepEqual([pattern.schedule.interpolation, pattern.schedule.samples.slice(0, 3)], ['hold', [[0, 0], [8 * 3600, 2], [22 * 3600, 0]]], 'open 84 hours of the week\'s 168: twice the demand while it is');
    assert.ok(opened.built.provenance.some((entry) => entry.entity === 'Shop' && entry.parameter === 'Opening hours' && entry.value === 84 && /^Yours: 8:00 to 22:00, Monday to Saturday\./.test(entry.detail)));
    const openRun = await runDocument(directory, 'calendar-open', opened.document, days);
    checkInvariants(openRun);
    const rate = openRun.series('Shop.demandRate');
    assert.deepEqual([rate[hour(1) + 3], rate[hour(1) + 12], rate[hour(1) + 23]].map((value) => Number(value.toFixed(6))), [0, 40, 0], 'Tuesday: nothing at 3, forty a day at noon, nothing at 23');
    assert.ok(Math.max(...rate.slice(hour(6), hour(7))) < 1e-9, 'closed all Sunday');
    const ordered = total(openRun, 'Shop.ordered');
    assert.ok(Math.abs(ordered - 20 * days) < 0.01 * 20 * days, `four weeks' sales are what they would be round the clock (${ordered.toFixed(1)} of ${20 * days} pallets)`);

    // ---- a store that receives from 6 to 9. Its warehouse dispatches by day, 9 to 17: what it sends reaches the store
    // after 9 and waits at the door until the next morning. Or it dispatches at night, 2 to 6, and arrives in time.
    const shift = (from, to) => network(({ warehouse, store }) => { setHours(store, 'receive', { from: 6, to: 9 }); setHours(warehouse, 'dispatch', { from, to }); });
    const byDay = shift(9, 17);
    const lane = byDay.built.lanes.find((item) => item.name === 'Road Depot → Shop');
    assert.ok(lane.leadTime * 24 < 4, `the drive is short (${(lane.leadTime * 24).toFixed(1)} h): the wait is at the door`);
    const gate = (document, name) => document.sharedParameters.find((shared) => shared.name === name).schedule.samples.slice(0, 3);
    assert.deepEqual([gate(byDay.document, 'Shop receives'), gate(byDay.document, 'Depot dispatches')], [[[0, 0], [6 * 3600, 8], [9 * 3600, 0]], [[0, 0], [9 * 3600, 3], [17 * 3600, 0]]], 'nothing outside the hours; within them, as much more as they are short of the day');
    // A lane whose ends keep hours is given more vehicles than its flow alone would need.
    assert.ok(lane.fleet > plain.built.lanes.find((item) => item.name === 'Road Depot → Shop').fleet, 'more vehicles: a day\'s goods are loaded in eight hours, and wait at the door');
    const dayRun = await runDocument(directory, 'calendar-day-shift', byDay.document, days);
    checkInvariants(dayRun);
    const arriving = dayRun.series('Road Depot → Shop.arriving');
    assert.ok(Math.max(...arriving.filter((_, index) => index % 24 >= 10 || index % 24 < 6)) < 1e-9, 'nothing is unloaded outside six to nine');
    assert.ok(Math.max(...arriving) > 20, 'and a day\'s goods in those three hours');
    const nightRun = await runDocument(directory, 'calendar-night-shift', shift(2, 6).document, days);
    checkInvariants(nightRun);
    // After the first week (the run starts with the stock of a network with no hours).
    const lost = (result) => total(result, 'Shop.lost', 7);
    const lowest = (result) => Math.min(...result.series('Shop stock.stock').slice(hour(7)));
    assert.ok(lost(dayRun) > 1 && lowest(dayRun) < 0.1 * 20, `day shift: the store runs short and loses sales (${lost(dayRun).toFixed(1)} pallets lost, ${lowest(dayRun).toFixed(1)} at its lowest).`);
    assert.ok(lost(nightRun) < 0.05 && lowest(nightRun) > lowest(dayRun) + 5, `night shift: it is restocked in time and loses none (${lost(nightRun).toFixed(2)} lost, ${lowest(nightRun).toFixed(1)} at its lowest).`);

    // ---- small vehicles deliver by day: the store's link on mini-vans that run from 8 to 20. A store that receives from
    // 6 to 9 is closed again by the time the first van reaches it, so everything waits at its door until the next
    // morning; one that receives from 10 to 14 takes its goods the day they are loaded.
    const byVan = (from, to) => network(({ store, catalogue, toStore }) => {
        setVehicleHours(catalogue.find((type) => type.id === 'miniVan'), { from: 8, to: 20 });
        toStore.vehicles = [{ type: 'miniVan', fleet: null }];
        setHours(store, 'receive', { from, to });
    });
    const early = byVan(6, 9);
    assert.deepEqual(early.document.sharedParameters.find((shared) => shared.name === 'Depot dispatches by mini-van').schedule.samples.slice(0, 3), [[0, 0], [8 * 3600, 2], [20 * 3600, 0]]);
    assert.ok(early.built.provenance.some((entry) => entry.entity === 'Mini-van' && entry.parameter === 'Runs' && /8:00 to 20:00, every day/.test(entry.detail)));
    const earlyRun = await runDocument(directory, 'calendar-vans-early', early.document, days);
    checkInvariants(earlyRun);
    assert.ok(Math.max(...earlyRun.series('Road Depot → Shop.canLoad').filter((_, index) => index % 24 >= 21 || index % 24 < 8)) < 1e-9, 'no van is loaded at night');
    const middayRun = await runDocument(directory, 'calendar-vans-midday', byVan(10, 14).document, days);
    checkInvariants(middayRun);
    assert.ok(lost(earlyRun) > 10, `vans by day, a store that receives early: it runs short and loses sales (${lost(earlyRun).toFixed(1)} pallets).`);
    assert.ok(lost(middayRun) < 0.05 && lowest(middayRun) > lowest(earlyRun) + 1, `a store that receives at midday is restocked in time (${lost(middayRun).toFixed(2)} lost, ${lowest(middayRun).toFixed(1)} at its lowest).`);

    // ---- a festival: days 12 to 14 at 180% of demand, days 9 to 11 at 130%, the supplier closed while it lasts. It is in
    // the calendar, so in the baseline: there is no scenario here, only the network as it is planned.
    const festival = [{ name: 'Festival', day: 12, days: 3, demand: { all: 80 }, beforeDays: 3, beforePercent: 30, afterDays: 0, afterPercent: 0, suppliersClosed: true }];
    const asItIs = network(() => {}, festival);
    const season = asItIs.document.sharedParameters.find((shared) => shared.name === 'Holidays and peaks');
    assert.deepEqual(season.schedule, { interpolation: 'hold', samples: [[0, 1], [9 * day, 1.3], [12 * day, 1.8], [15 * day, 1]] });
    assert.deepEqual(asItIs.document.sharedParameters.find((shared) => shared.name === 'Mill dispatches').schedule.samples, [[0, 1], [12 * day, 0], [15 * day, 1]], 'the supplier loads nothing over the festival');
    assert.ok(asItIs.built.provenance.some((entry) => entry.entity === 'Holidays and peaks' && entry.parameter === 'Festival' && /demand \+80%; the 3 days before \+30%; suppliers do not dispatch/.test(entry.detail) && entry.basis === 'user'));
    const festivalRun = await runDocument(directory, 'calendar-festival', asItIs.document, days);
    checkInvariants(festivalRun);
    const demandOn = (dayIndex) => Number(festivalRun.series('Shop.demandRate')[hour(dayIndex) + 12].toFixed(6));
    assert.deepEqual([demandOn(5), demandOn(10), demandOn(13), demandOn(16)], [20, 26, 36, 20]);
    assert.ok(Math.max(...festivalRun.series('Road Mill → Depot.canLoad').slice(hour(12) + 1, hour(15))) < 1e-9, 'nothing is loaded at the supplier over the festival');
    const lostOver = (result) => total(result, 'Shop.lost');
    assert.ok(lostOver(festivalRun) > 5, `with room for a day and a quarter of ordinary sales, the store loses sales over the festival (${lostOver(festivalRun).toFixed(1)} pallets).`);
    // The same festival with room for more: four days of cover at the store.
    const stocked = network(({ store }) => { store.fields.capacity = { value: 100, basis: 'user' }; store.fields.cover = { value: 4, basis: 'user' }; }, festival);
    const stockedRun = await runDocument(directory, 'calendar-festival-stocked', stocked.document, days);
    checkInvariants(stockedRun);
    assert.ok(lostOver(stockedRun) < 0.3 * lostOver(festivalRun), `holding more, it loses far fewer (${lostOver(stockedRun).toFixed(1)} against ${lostOver(festivalRun).toFixed(1)} pallets).`);

    console.log(`✓ network with hours: with none kept the baseline holds still; a store open 8 to 22, Monday to Saturday, sells nothing while closed and ${ordered.toFixed(0)} pallets in four weeks, as round the clock; a store that receives from 6 to 9 loses ${lost(dayRun).toFixed(1)} pallets of sales when its warehouse dispatches by day, its goods waiting at the door (stock down to ${lowest(dayRun).toFixed(1)}), and none when it dispatches at night (${lowest(nightRun).toFixed(1)}); on mini-vans that run by day, a store that receives from 6 to 9 loses ${lost(earlyRun).toFixed(1)} pallets and one that receives from 10 to 14 none; over a three-day festival at 180% of demand, the supplier closed, the store loses ${lostOver(festivalRun).toFixed(1)} pallets of sales with room for a day and a quarter and ${lostOver(stockedRun).toFixed(1)} with four days of cover; goods, vehicles and orders conserved.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
