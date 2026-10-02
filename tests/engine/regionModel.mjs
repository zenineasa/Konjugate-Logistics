/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs a model built by region import from the synthetic region (tests/fixtures/syntheticRegion.mjs)
// through the real engine CLI:
//   - baseline: every stock, queue and rate holds its starting value, and costs accrue
//   - berth outage at the busiest port: ships queue at anchorage, and the queue clears afterwards
//   - arrivals that follow the port's IMF PortWatch history (a stored parameter schedule): each day's
//     arrivals are that day's imports, and the busy days queue ships beyond the berths' capacity
//   - with an invented fleet operator (two truck sizes), a baseline that holds still, and the window's scenarios
//     followed as stored schedules from day 0: a road closed (its warehouse's other lane takes its orders), the
//     operator's trucks halved, and demand stepped up
//   - a chokepoint cut at Port Alder with part of its cargo diverted to Birch Harbour over standby lanes
// Both must conserve containers, conserve every road lane's trucks, and keep each warehouse's on-order
// count equal to what waits on and travels along its lanes.
//
// Usage: node tests/engine/regionModel.mjs [path/to/konjugateEngine]

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultSelection, discoverRegion } from '../../packages/toolbox/lib/discovery.mjs';
import { generateOperator } from '../../packages/toolbox/lib/operator.mjs';
import { disruptionPlan } from '../../packages/toolbox/lib/chokepoints.mjs';
import { closurePlan, demandPlan, diversionPlan, fleetPlan } from '../../packages/toolbox/lib/scenarios.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { createRouter } from '../../packages/toolbox/lib/roadGraph.mjs';
import { konjugateModule } from '../../scripts/konjugatePaths.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { syntheticPortwatch, syntheticRegion } from '../fixtures/syntheticRegion.mjs';

const { encodeProjectFile } = await import(pathToFileURL(konjugateModule('src/projectFile.mjs')));
const { decodeResultFile } = await import(pathToFileURL(konjugateModule('src/engineProtocol.mjs')));
const { decodeValidationReport } = await import(pathToFileURL(konjugateModule('src/reportProtocol.mjs')));

const executable = process.argv[2] ?? konjugateModule(join('out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine'));
const directory = await mkdtemp(join(tmpdir(), 'konjugateLogisticsRegion-'));
const day = 86400;
const templates = await loadTemplates();
const { candidates, roadGraph } = discoverRegion(syntheticRegion());
const route = createRouter(roadGraph).route;
// The same region with Port Alder matched to its (synthetic) PortWatch history.
const withHistory = discoverRegion(Object.fromEntries(Object.entries({ ...syntheticRegion(), ...syntheticPortwatch() }).map(([kind, value]) => [kind, [JSON.stringify(value)]])));

function execute(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

async function run(name, { days, change = () => {}, region = candidates, selection = defaultSelection(region), options = {} }) {
    const builder = new ModelBuilder(templates);
    const built = buildRegionModel({ builder, selection, route, options });
    change(builder, built);
    const document = builder.document({ days, stepDays: 15 / 1440, outputDays: 1 / 24 });
    const inputPath = join(directory, `${name}.kjt`);
    const reportPath = join(directory, `${name}.report`);
    const outputPath = join(directory, `${name}.kjr`);
    const configurationPath = join(directory, `${name}.json`);
    const { globalTimeStep, outputInterval } = document.runConfigurations[0];
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(document)));
    await writeFile(configurationPath, JSON.stringify({ name, targetTime: days * day, globalTimeStep, outputInterval }));
    assert.equal(await execute(['validate', inputPath, '--report', reportPath]), 0, `${name}: validation failed to run.`);
    const report = decodeValidationReport(await readFile(reportPath));
    assert.equal(report.valid, true, `${name}: ${JSON.stringify(report.issues ?? report)}`);
    assert.equal(await execute(['run', inputPath, '--configuration', configurationPath, '--output', outputPath]), 0, `${name}: run failed.`);
    const result = decodeResultFile(await readFile(outputPath));
    const stateIds = new Map(document.nodes.flatMap((node) => node.states.map((state) => [`${node.name}.${state.symbol}`, state.id])));
    const series = (key) => {
        if (!stateIds.has(key)) throw new Error(`${name}: no state ${key}.`);
        const stateId = stateIds.get(key);
        return result.samples.map((sample) => sample.states.find((state) => state.stateId === stateId).value);
    };
    return { name, document, built, series };
}

const sum = (arrays) => arrays[0].map((_, index) => arrays.reduce((total, values) => total + values[index], 0));
const maxDrift = (values) => Math.max(...values.map((value) => Math.abs(value - values[0])));
const hour = (days) => Math.round(days * 24);
const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);

function checkInvariants({ name, document, series }, { fleetsChange = false } = {}) {
    const ofType = (type) => document.nodes.filter((node) => node.type === type).map((node) => node.name);
    const ports = ofType('Port');
    const lanes = ofType('Road lane');
    const warehouses = ofType('Warehouse');
    const towns = ofType('Demand zone');
    assert.ok(ports.length && lanes.length && warehouses.length && towns.length, `${name}: the model has every kind of node.`);
    const loaded = (lane) => sum(['loaded1', 'loaded2', 'loaded3'].map((stage) => series(`${lane}.${stage}`)));
    const containers = sum([
        ...ports.flatMap((port) => [series(`${port}.queue`), series(`${port}.stock`), series(`${port}.arrived`).map((value) => -value)]),
        ...lanes.map(loaded), ...warehouses.map((warehouse) => series(`${warehouse}.stock`)), ...towns.map((town) => series(`${town}.delivered`))
    ]);
    assert.ok(maxDrift(containers) < 1e-6, `${name}: containers must be conserved (drift ${maxDrift(containers)} TEU).`);
    for (const lane of fleetsChange ? [] : lanes) {
        for (const size of ['', '2']) {
            const trucks = sum([series(`${lane}.idleTrucks${size}`), series(`${lane}.returning${size}`), series(`${lane}.loadedTrucks${size}`)]);
            assert.ok(maxDrift(trucks) < 1e-6, `${name}: ${lane} must keep its trucks${size ? ' of the second size' : ''} (drift ${maxDrift(trucks)}).`);
        }
    }
    const nodeName = new Map(document.nodes.map((node) => [node.id, node.name]));
    for (const warehouse of warehouses) {
        const itsLanes = [...new Set(document.edges
            .filter((edge) => nodeName.get(edge.target.nodeId) === warehouse && lanes.includes(nodeName.get(edge.source.nodeId)))
            .map((edge) => nodeName.get(edge.source.nodeId)))];
        const pipeline = sum(itsLanes.flatMap((lane) => [series(`${lane}.requested`), loaded(lane)]));
        const gap = series(`${warehouse}.onOrder`).map((value, index) => value - pipeline[index]);
        assert.ok(maxDrift(gap) < 1e-6 && Math.abs(gap[0]) < 1e-6, `${name}: ${warehouse} on order must match its lanes (drift ${maxDrift(gap)}).`);
    }
}

try {
    const baseline = await run('baseline', { days: 30 });
    checkInvariants(baseline);
    const cumulative = /\.(arrived|handled|delivered|ordered|transportCost|holdingCost|backlogCost)$/;
    for (const node of baseline.document.nodes) {
        for (const state of node.states) {
            const key = `${node.name}.${state.symbol}`;
            if (cumulative.test(key)) continue;
            const values = baseline.series(key);
            assert.ok(maxDrift(values) < 1e-6 * Math.max(1, Math.abs(values[0])), `baseline: ${key} should hold still (drift ${maxDrift(values)}).`);
        }
    }
    const firstLane = baseline.built.lanes[0].name;
    assert.ok(baseline.series(`${firstLane}.transportCost`).at(-1) > 0, 'baseline: transport cost should accrue.');

    // The busiest port's berths drop to a fifth of their capacity from day 20 to 50 (the template's outage window).
    let arrivals;
    let berths;
    const outage = await run('outage', {
        days: 70,
        change: (builder, built) => {
            arrivals = built.parameterIndex.find((entry) => entry.key === 'vesselArrivals' && entry.entity === 'Port Alder').value;
            berths = built.parameterIndex.find((entry) => entry.key === 'berthCapacity' && entry.entity === 'Port Alder').value;
            const port = built.parameterIndex.find((entry) => entry.key === 'outageCapacity' && entry.entity === 'Port Alder');
            builder.setShared(port.symbol, berths / 5);
        }
    });
    checkInvariants(outage);
    const queue = outage.series('Port Alder.queue');
    // Arrivals against a fifth of the berths for 30 days, on top of the quarter-day of arrivals waiting at the start.
    const expected = arrivals * 0.25 + (arrivals - berths / 5) * 30;
    assert.ok(Math.abs(queue[hour(50)] - expected) < 0.01 * expected, `outage: about ${Math.round(expected)} TEU should be at anchorage by day 50 (got ${queue[hour(50)]}).`);
    // Afterwards the berths clear the backlog with their spare capacity: berths - arrivals a day, for 20 days.
    const cleared = (berths - arrivals) * 20;
    assert.ok(Math.abs(queue[hour(70)] - (queue[hour(50)] - cleared)) < 0.01 * expected, `outage: the queue should shrink by about ${Math.round(cleared)} TEU in the 20 days after the outage (day 70: ${queue[hour(70)]}).`);

    // Port Alder's arrivals follow its 28 days of history: 120 TEU a day, 240 every seventh day.
    const history = await run('history', { days: 28, region: withHistory.candidates, options: { arrivals: 'history' } });
    checkInvariants(history);
    const samples = history.document.sharedParameters.find((item) => item.id === history.built.parameterIndex.find((entry) => entry.entity === 'Port Alder' && entry.key === 'vesselArrivals').sharedParameterId).schedule.samples;
    const arrived = history.series('Port Alder.arrived');
    let total = 0;
    for (let dayIndex = 0; dayIndex < 28; dayIndex += 1) {
        total += samples[dayIndex][1];
        assert.ok(Math.abs(arrived[hour(dayIndex + 1)] - total) < 1e-6 * total, `history: by the end of day ${dayIndex + 1}, ${total} TEU should have arrived (got ${arrived[hour(dayIndex + 1)]}).`);
    }
    const historyBerths = history.built.parameterIndex.find((entry) => entry.key === 'berthCapacity' && entry.entity === 'Port Alder').value;
    const historyQueue = history.series('Port Alder.queue');
    assert.ok(240 > historyBerths && Math.max(...historyQueue) > historyQueue[0] + 0.5 * (240 - historyBerths), `history: a 240 TEU day beyond ${historyBerths.toFixed(0)} TEU of berths should queue ships (largest queue ${Math.max(...historyQueue)}).`);

    // ---- the operator and the window's scenarios, each followed from day 0 as a stored schedule.
    const plainBuild = buildRegionModel({ builder: new ModelBuilder(templates), selection: defaultSelection(candidates), route });
    const operator = generateOperator(plainBuild, new Map(defaultSelection(candidates).ports.map((port) => [port.name, port])));
    // Each supplied path becomes a schedule on that entity's own parameter.
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
    const withOperator = await run('operator', { days: 30, options: { operator } });
    checkInvariants(withOperator);
    for (const lane of withOperator.built.lanes) {
        for (const symbol of ['idleTrucks', 'idleTrucks2', 'loaded1', 'requested']) {
            const values = withOperator.series(`${lane.name}.${symbol}`);
            assert.ok(maxDrift(values) < 1e-6 * Math.max(1, Math.abs(values[0])), `operator: ${lane.name}.${symbol} should hold still (drift ${maxDrift(values)}).`);
        }
    }
    const contracted = withOperator.built.lanes.filter((lane) => lane.operator);
    assert.ok(contracted.length >= 2 && contracted.every((lane) => lane.fleet2 > 0), 'operator: it carries lanes in both truck sizes.');
    assert.ok(withOperator.series(`${contracted[0].name}.fleetCost`).at(-1) > 0, 'operator: fleet cost should accrue.');

    // A road closed for 10 days at a warehouse with another lane, three ways.
    const closed = withOperator.built.lanes.find((lane) => withOperator.built.lanes.some((other) => other !== lane && other.to === lane.to));
    assert.ok(closed, 'The synthetic region has a warehouse with two lanes.');
    const sibling = withOperator.built.lanes.find((lane) => lane !== closed && lane.to === closed.to);
    const carried = (result, lane, from, to) => result.series(`${lane}.arriving`).slice(hour(from), hour(to)).reduce((total, value) => total + value, 0) / (hour(to) - hour(from));
    const closure = (mode, extra = {}) => run(`closure-${mode}`, { days: 30, options: { operator }, change: follow(closurePlan({ lanes: withOperator.built.lanes, closed: closed.name, mode, ...extra, ...window }).supplied) });
    const stockAt = (result, at) => result.series(`${closed.to}.stock`)[hour(at)];
    // Its trucks wait: the lane carries nothing, the cargo waits in its port's yard, and once it reopens the lane
    // works through the orders that queued, faster than its usual flow.
    const waited = await closure('wait');
    checkInvariants(waited);
    assert.ok(carried(waited, closed.name, 8, 15) < 0.01 * closed.rate, `closure: ${closed.name} should carry nothing once its trucks are home (got ${carried(waited, closed.name, 8, 15)} TEU/day).`);
    const yardGrew = waited.series(`${closed.from}.stock`)[hour(15)] - withOperator.series(`${closed.from}.stock`)[hour(15)];
    assert.ok(yardGrew > 0.64 * closed.rate * 10, `closure: about ${(closed.rate * 10).toFixed(0)} TEU should wait in ${closed.from}'s yard by day 15 (got ${yardGrew.toFixed(0)} more than the baseline).`);
    assert.ok(carried(waited, closed.name, 15, 20) > 1.05 * closed.rate, `closure: ${closed.name} should catch up after it reopens (got ${carried(waited, closed.name, 15, 20)} against ${closed.rate}).`);
    // A detour of 6 hours each way: the lane keeps carrying, with more of its trucks on the road, at a higher cost.
    const detoured = await closure('detour', { detourHours: 6 });
    checkInvariants(detoured);
    const cost = (result) => result.series(`${closed.name}.transportCost`)[hour(15)] - result.series(`${closed.name}.transportCost`)[hour(5)];
    assert.ok(cost(detoured) > 1.2 * cost(withOperator), `detour: ${closed.name} should cost more per day (got ${cost(detoured)} against ${cost(withOperator)}).`);
    assert.ok(stockAt(detoured, 15) > stockAt(waited, 15), `detour: ${closed.to} should hold more stock than when the trucks wait.`);
    // The warehouse orders from its other port instead: that lane carries more, but only what its port's yard and
    // trucks allow, and the orders left there hold the warehouse's own lane back after the road reopens.
    const otherPorts = await closure('otherPorts');
    checkInvariants(otherPorts);
    assert.ok(carried(otherPorts, sibling.name, 8, 15) > 1.2 * sibling.rate, `other ports: ${sibling.name} should carry more than its own flow (got ${carried(otherPorts, sibling.name, 8, 15)} against ${sibling.rate}).`);
    assert.ok(stockAt(otherPorts, 29) < stockAt(waited, 29), `other ports: ${closed.to} should recover more slowly than when the trucks wait (${stockAt(otherPorts, 29).toFixed(0)} against ${stockAt(waited, 29).toFixed(0)} on day 29).`);

    // The operator's trucks halved for 10 days: idle trucks are released first, so its lanes run short.
    const fleet = fleetPlan({ lanes: contracted, change: -0.5, ...window });
    const fleetRun = await run('fleet', { days: 30, options: { operator }, change: follow(fleet.supplied) });
    checkInvariants(fleetRun, { fleetsChange: true });
    const trucksOn = (result, lane, at) => ['', '2'].reduce((total, size) => total + ['idleTrucks', 'returning', 'loadedTrucks'].reduce((count, symbol) => count + result.series(`${lane}.${symbol}${size}`)[hour(at)], 0), 0);
    const lane = contracted[0];
    assert.ok(trucksOn(fleetRun, lane.name, 15) < 0.75 * (lane.fleet + lane.fleet2), `fleet: ${lane.name} should be down towards half its ${lane.fleet + lane.fleet2} trucks by day 15 (got ${trucksOn(fleetRun, lane.name, 15)}).`);
    assert.ok(carried(fleetRun, lane.name, 10, 15) < 0.9 * lane.rate, `fleet: ${lane.name} should carry less than its flow (got ${carried(fleetRun, lane.name, 10, 15)} against ${lane.rate}).`);
    assert.ok(Math.abs(trucksOn(fleetRun, lane.name, 30) - (lane.fleet + lane.fleet2)) < 1, `fleet: ${lane.name} should have hired its trucks back by day 30 (got ${trucksOn(fleetRun, lane.name, 30)}).`);

    // Demand up by half everywhere for 10 days: towns' backlogs grow, and the extra is delivered afterwards.
    const demand = demandPlan({ towns: withOperator.built.towns, change: 0.5, ...window });
    const demandRun = await run('demand', { days: 30, options: { operator }, change: follow(demand.supplied) });
    checkInvariants(demandRun);
    const towns = withOperator.built.towns;
    const ordered = towns.reduce((total, town) => total + demandRun.series(`${town.name}.ordered`).at(-1) - withOperator.series(`${town.name}.ordered`).at(-1), 0);
    assert.ok(Math.abs(ordered - demand.extraTeu) < 0.01 * demand.extraTeu, `demand: ${demand.extraTeu.toFixed(0)} TEU more should be ordered (got ${ordered}).`);
    const backlog = (result, at) => towns.reduce((total, town) => total + result.series(`${town.name}.backlog`)[hour(at)], 0);
    assert.ok(backlog(demandRun, 15) > backlog(withOperator, 15) * 1.2, 'demand: orders should wait at the peak.');

    // Port Alder's ships cut by 80% for 10 days; 60% of what is kept out lands at East Quay instead (a small port of the
    // user's own, which in the baseline supplies only the zone nearest it) and is trucked to Alder's warehouses over
    // its lanes: a standby lane to Alder Industrial Park, and its usual lane to the other zone. Both hire trucks for it.
    const withQuay = { ...defaultSelection(candidates) };
    withQuay.ports = [...withQuay.ports, { id: 'added:east', name: 'East Quay', lat: -29.82, lon: -19.62, teuPerDay: 10, kind: 'port', user: true }];
    const quayOptions = { standbyPorts: ['East Quay'] };
    const standby = await run('standby', { days: 30, selection: withQuay, options: quayOptions });
    checkInvariants(standby);
    const standbyLane = standby.built.lanes.find((lane) => lane.standby);
    assert.ok(standbyLane?.from === 'East Quay' && standbyLane.rate === 0 && standbyLane.fleet === 0, 'a standby lane from East Quay, carrying nothing with no trucks');
    for (const node of standby.document.nodes) {
        for (const state of node.states) {
            if (/^(arrived|handled|delivered|ordered|transportCost|fleetCost|holdingCost|backlogCost)$/.test(state.symbol)) continue;
            const values = standby.series(`${node.name}.${state.symbol}`);
            assert.ok(maxDrift(values) < 1e-6 * Math.max(1, Math.abs(values[0])), `standby: ${node.name}.${state.symbol} should hold still (drift ${maxDrift(values)}).`);
        }
    }
    const ports = standby.built.ports;
    const alder = ports.find((port) => port.name === 'Port Alder');
    const cutWindow = { start: 5 * day, duration: 10 * day, forkAt: 0, runTime: 30 * day };
    const cutAlder = disruptionPlan({ base: alder.arrivals, dependence: 1, cut: 0.8, ...cutWindow }).path;
    const diversion = diversionPlan({ lanes: standby.built.lanes, ports, affected: [{ port: 'Port Alder', share: 1 }], to: 'East Quay', cut: 0.8, diverted: 0.6, ...cutWindow, ...standby.built.trucking });
    assert.deepEqual(diversion.unreachable, [], 'every warehouse Alder supplies has a lane from East Quay');
    close(diversion.divertedTeu, alder.arrivals * 0.8 * 0.6 * 10, 1e-6 * diversion.divertedTeu, 'diversion: 60% of 80% of Alder\'s ships for 10 days');
    const supplied = { ...diversion.supplied, vesselArrivals: { entities: ['Port Alder', 'East Quay'], samples: { 'Port Alder': cutAlder, ...diversion.supplied.vesselArrivals.samples } } };
    const lost = await run('cut', { days: 30, selection: withQuay, options: quayOptions, change: follow({ vesselArrivals: { entities: ['Port Alder'], samples: { 'Port Alder': cutAlder } } }) });
    const divertedRun = await run('diverted', { days: 30, selection: withQuay, options: quayOptions, change: follow(supplied) });
    checkInvariants(lost);
    checkInvariants(divertedRun, { fleetsChange: true });
    const received = divertedRun.series('East Quay.arrived').at(-1) - standby.series('East Quay.arrived').at(-1);
    close(received, diversion.divertedTeu, 0.01 * diversion.divertedTeu, 'diversion: East Quay receives the diverted cargo');
    // East Quay's berths are sized for its own 10 TEU a day, so most of the diverted cargo waits at its anchorage, and
    // the towns get little more than when the cargo is lost.
    const quayQueue = (result) => Math.max(...result.series('East Quay.queue'));
    const quayBerths = ports.find((port) => port.name === 'East Quay').berths;
    assert.ok(quayQueue(divertedRun) > 0.8 * (diversion.divertedTeu - (quayBerths - 10) * 10), `diversion: the cargo should wait at East Quay's anchorage (largest queue ${quayQueue(divertedRun).toFixed(0)} TEU).`);
    // With berths for it, the cargo reaches the towns: Alder Industrial Park's share over the standby lane, once its
    // trucks are hired.
    const roomy = diversionPlan({ lanes: standby.built.lanes, ports, affected: [{ port: 'Port Alder', share: 1 }], to: 'East Quay', cut: 0.8, diverted: 0.6, berths: 150, ...cutWindow, ...standby.built.trucking });
    const roomyRun = await run('diverted-berths', { days: 30, selection: withQuay, options: quayOptions, change: follow({ ...roomy.supplied, vesselArrivals: { entities: ['Port Alder', 'East Quay'], samples: { 'Port Alder': cutAlder, ...roomy.supplied.vesselArrivals.samples } } }) });
    checkInvariants(roomyRun, { fleetsChange: true });
    assert.ok(quayQueue(roomyRun) < 0.1 * quayQueue(divertedRun), `diversion: with berths for it, little should wait at East Quay (${quayQueue(roomyRun).toFixed(0)} TEU).`);
    const movedToPark = standby.built.lanes.find((lane) => lane.from === 'Port Alder' && lane.to === standbyLane.to).rate * 0.8 * 0.6;
    const viaQuay = carried(roomyRun, standbyLane.name, 9, 15);
    assert.ok(viaQuay > 0.8 * movedToPark, `diversion: ${standbyLane.name} should carry most of the ${movedToPark.toFixed(0)} TEU a day moved to it (got ${viaQuay.toFixed(1)}).`);
    assert.ok(carried(roomyRun, standbyLane.name, 24, 30) < 0.05 * movedToPark, 'diversion: the standby lane goes quiet again after the disruption.');
    const quayTowns = standby.built.towns;
    const servedBy = (result, at) => quayTowns.reduce((total, town) => total + result.series(`${town.name}.delivered`)[hour(at)], 0);
    assert.ok(servedBy(roomyRun, 20) > servedBy(lost, 20) + 0.5 * diversion.divertedTeu, `diversion: towns should get most of the diverted cargo (${servedBy(roomyRun, 20).toFixed(0)} against ${servedBy(lost, 20).toFixed(0)} TEU by day 20, ${diversion.divertedTeu.toFixed(0)} diverted).`);

    console.log(`✓ region model from the synthetic region: ${baseline.document.nodes.length} nodes and ${baseline.document.edges.length} edges hold still in the baseline; a berth outage at Port Alder queues ${Math.round(queue[hour(50)]).toLocaleString('en')} TEU; arrivals following PortWatch history match it day by day and queue ships on the busy days; an invented operator's two truck sizes hold still; a closed road's trucks wait, detour or order elsewhere (the warehouse holds ${stockAt(waited, 29).toFixed(0)}, ${stockAt(detoured, 29).toFixed(0)} and ${stockAt(otherPorts, 29).toFixed(0)} TEU on day 29); halving the operator's trucks slows ${lane.name.replace(/^Road /, '')} to ${carried(fleetRun, lane.name, 10, 15).toFixed(1)} TEU/day; a demand surge orders ${demand.extraTeu.toFixed(0)} TEU more; ${diversion.divertedTeu.toFixed(0)} TEU of Port Alder's cargo diverted to East Quay waits at its anchorage, or with berths for it reaches the towns over its lanes, a standby one included; containers, trucks and orders conserved.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
