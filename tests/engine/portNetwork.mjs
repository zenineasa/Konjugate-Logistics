/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs the port network built from this plugin's templates (scripts/portNetwork.mjs) through the
// real engine CLI:
//   - baseline: a balanced network stays exactly at its steady state
//   - berth outage: ships queue at anchorage while the berths run at 30 TEU/day, and the queue
//     clears once they recover
//   - truck shortage: lane A's 90 trucks cannot carry Warehouse A's 70 TEU/day, so its stock and
//     Zone 2's service fall
//   - rail relief: the same 90 trucks plus a rail lane taking 40% of Warehouse A's orders
// Every scenario must conserve containers, conserve each road lane's trucks, and keep each
// warehouse's on-order count equal to what waits on and travels along its lanes.
//
// Usage: node tests/engine/portNetwork.mjs [path/to/konjugateEngine]
// (defaults to the sibling Konjugate checkout's out/engine build)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { konjugateModule } from '../../scripts/konjugatePaths.mjs';
import { buildPortNetwork } from '../../scripts/portNetwork.mjs';

const { encodeProjectFile } = await import(pathToFileURL(konjugateModule('src/projectFile.mjs')));
const { decodeResultFile } = await import(pathToFileURL(konjugateModule('src/engineProtocol.mjs')));
const { decodeValidationReport } = await import(pathToFileURL(konjugateModule('src/reportProtocol.mjs')));

const executable = process.argv[2] ?? konjugateModule(join('out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine'));
const directory = await mkdtemp(join(tmpdir(), 'konjugateLogisticsToolbox-'));
const day = 86400;

function execute(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

async function run(name, options = {}) {
    const document = await buildPortNetwork(options);
    const inputPath = join(directory, `${name}.kjt`);
    const reportPath = join(directory, `${name}.report`);
    const outputPath = join(directory, `${name}.kjr`);
    const configurationPath = join(directory, `${name}.json`);
    const { globalTimeStep, outputInterval } = document.runConfigurations[0];
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(document)));
    await writeFile(configurationPath, JSON.stringify({ name, targetTime: 120 * day, globalTimeStep, outputInterval }));
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
    return { name, document, series, has: (key) => stateIds.has(key) };
}

const sum = (arrays) => arrays[0].map((_, index) => arrays.reduce((total, values) => total + values[index], 0));
const maxDrift = (values) => Math.max(...values.map((value) => Math.abs(value - values[0])));
const loaded = (series, lane) => sum(['loaded1', 'loaded2', 'loaded3'].map((stage) => series(`${lane}.${stage}`)));

function checkInvariants({ name, series, has }, { fleetsChange = false } = {}) {
    const lanes = ['Road lane A', 'Road lane B', ...(has('Rail lane.loaded1') ? ['Rail lane'] : [])];
    // Containers: everything at the port, on the lanes, in the warehouses and delivered, minus arrivals.
    const containers = sum([
        series('Port.queue'), series('Port.stock'), ...lanes.map((lane) => loaded(series, lane)),
        series('Warehouse A.stock'), series('Warehouse B.stock'),
        ...['Zone 1', 'Zone 2', 'Zone 3'].map((zone) => series(`${zone}.delivered`)),
        series('Port.arrived').map((value) => -value)
    ]);
    assert.ok(maxDrift(containers) < 1e-6, `${name}: containers must be conserved (drift ${maxDrift(containers)} TEU).`);
    // Trucks: idle + returning + loaded trucks of each size, per road lane, unless the scenario hires trucks; and the
    // loaded trucks of both sizes carry exactly the containers in transit.
    for (const lane of fleetsChange ? ['Road lane B'] : ['Road lane A', 'Road lane B']) {
        for (const size of ['', '2']) {
            const trucks = sum([series(`${lane}.idleTrucks${size}`), series(`${lane}.returning${size}`), series(`${lane}.loadedTrucks${size}`)]);
            assert.ok(maxDrift(trucks) < 1e-6, `${name}: ${lane} must keep its trucks${size ? ' of the second size' : ''} (drift ${maxDrift(trucks)}).`);
        }
    }
    for (const lane of ['Road lane A', 'Road lane B']) {
        const carried = sum([series(`${lane}.loadedTrucks`).map((value) => 2 * value), series(`${lane}.loadedTrucks2`)]);
        const gap = carried.map((value, index) => value - loaded(series, lane)[index]);
        assert.ok(Math.max(...gap.map(Math.abs)) < 1e-6, `${name}: ${lane}'s loaded trucks must carry exactly what is in transit.`);
    }
    // On order = what waits on and travels along the warehouse's lanes.
    const lanesOf = { 'Warehouse A': lanes.filter((lane) => lane !== 'Road lane B'), 'Warehouse B': ['Road lane B'] };
    for (const [warehouse, itsLanes] of Object.entries(lanesOf)) {
        const pipeline = sum(itsLanes.flatMap((lane) => [series(`${lane}.requested`), loaded(series, lane)]));
        const gap = series(`${warehouse}.onOrder`).map((value, index) => value - pipeline[index]);
        assert.ok(maxDrift(gap) < 1e-6 && Math.abs(gap[0]) < 1e-6, `${name}: ${warehouse} on order must match its lanes (drift ${maxDrift(gap)}).`);
    }
    for (const key of ['Port.queue', 'Port.stock', 'Warehouse A.stock', 'Warehouse B.stock', 'Road lane A.idleTrucks', 'Road lane B.idleTrucks']) {
        assert.ok(Math.min(...series(key)) > -1e-9, `${name}: ${key} must not go negative.`);
    }
}

const fill = (series, zone, from, to) => {
    const delivered = series(`${zone}.delivered`);
    const ordered = series(`${zone}.ordered`);
    return (delivered[to] - delivered[from]) / (ordered[to] - ordered[from]);
};
const average = (values, from, to) => values.slice(from, to + 1).reduce((total, value) => total + value, 0) / (to - from + 1);

try {
    // Baseline: every stock, queue and rate holds its starting value.
    const baseline = await run('baseline');
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
    assert.ok(baseline.series('Road lane A.transportCost').at(-1) > 0 && baseline.series('Warehouse A.holdingCost').at(-1) > 0, 'baseline: costs should accrue.');

    // Berth outage: 30 TEU/day at the berths from day 20 to 50 against 100 arriving.
    const outage = await run('outage', { outageCapacity: 30 });
    checkInvariants(outage);
    const queue = outage.series('Port.queue');
    assert.ok(Math.abs(queue[50] - (25 + 70 * 30)) < 5, `outage: the anchorage should hold about 2,125 TEU by day 50 (got ${queue[50]}).`);
    assert.ok(outage.series('Port.waitDays')[49] > 60, 'outage: the anchorage wait should exceed 60 days late in the outage.');
    assert.ok(queue[120] < 100, `outage: the queue should clear after the berths recover (day 120: ${queue[120]}).`);
    assert.ok(fill(outage.series, 'Zone 2', 20, 70) < fill(outage.series, 'Zone 1', 20, 70), 'outage: Zone 1 should be served ahead of Zone 2.');

    // Truck shortage: 90 trucks on lane A instead of 170.
    const shortage = await run('shortage', { laneAFleet: 90 });
    checkInvariants(shortage);
    // A saturated fleet carries trucks x capacity per round trip: 90 x 2 TEU / (2 x 2 days + 0.25) = 42.35 TEU/day.
    const carried = average(shortage.series('Road lane A.arriving'), 30, 90);
    const roundTripCapacity = 90 * 2 / (2 * 2 + 0.25);
    assert.ok(Math.abs(carried - roundTripCapacity) < 0.01 * roundTripCapacity, `shortage: 90 trucks should carry ${roundTripCapacity.toFixed(2)} TEU/day (got ${carried}).`);
    assert.ok(shortage.series('Road lane A.utilisation')[60] > 0.9, 'shortage: nearly every truck should be on the road.');
    assert.ok(shortage.series('Warehouse A.stock')[60] < 100, 'shortage: Warehouse A should run down.');

    // Rail relief: the same 90 trucks, with rail taking 40% of Warehouse A's orders.
    const relief = await run('relief', { laneAFleet: 90, railShare: 0.4 });
    checkInvariants(relief);
    assert.ok(relief.series('Warehouse A.stock')[60] > shortage.series('Warehouse A.stock')[60] + 50, 'relief: rail should keep Warehouse A stocked.');
    // 40% by rail leaves 42 TEU/day for the road, just inside what the 90 trucks can carry.
    assert.ok(Math.abs(average(relief.series('Road lane A.arriving'), 30, 90) - 42) < 0.5, 'relief: the road should carry the remaining 42 TEU/day.');
    assert.ok(fill(relief.series, 'Zone 2', 20, 90) > fill(shortage.series, 'Zone 2', 20, 90) + 0.2, 'relief: Zone 2 should be served far better.');
    assert.ok(relief.series('Rail lane.transportCost').at(-1) > 0, 'relief: rail should carry and charge.');

    // Hiring: the same 90 trucks, with the fleet size set to 170: trucks are hired over a few days
    // and lane A carries Warehouse A's 70 TEU/day again.
    const hiring = await run('hiring', { laneAFleet: 90, laneAFleetSize: 170 });
    checkInvariants(hiring, { fleetsChange: true });
    const fleetA = sum([hiring.series('Road lane A.idleTrucks'), hiring.series('Road lane A.returning'), hiring.series('Road lane A.loadedTrucks')]);
    assert.ok(Math.abs(fleetA[20] - 170) < 1, `hiring: lane A should reach 170 trucks within 20 days (got ${fleetA[20]}).`);
    assert.ok(Math.abs(average(hiring.series('Road lane A.arriving'), 60, 120) - 70) < 0.5, 'hiring: lane A should carry 70 TEU/day again.');
    assert.ok(fill(hiring.series, 'Zone 2', 20, 90) > fill(shortage.series, 'Zone 2', 20, 90) + 0.2, 'hiring: Zone 2 should be served far better.');

    console.log(`✓ port network from templates: baseline holds; outage queues ${queue[50].toFixed(0)} TEU at anchorage; 90 trucks carry ${carried.toFixed(1)} TEU/day; rail restores Zone 2 from ${(100 * fill(shortage.series, 'Zone 2', 20, 90)).toFixed(0)}% to ${(100 * fill(relief.series, 'Zone 2', 20, 90)).toFixed(0)}% served; containers, trucks and orders conserved.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
