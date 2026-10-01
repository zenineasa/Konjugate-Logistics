/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Runs a model built by region import from the synthetic region (tests/fixtures/syntheticRegion.mjs)
// through the real engine CLI:
//   - baseline: every stock, queue and rate holds its starting value, and costs accrue
//   - berth outage at the busiest port: ships queue at anchorage, and the queue clears afterwards
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
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { createRouter } from '../../packages/toolbox/lib/roadGraph.mjs';
import { konjugateModule } from '../../scripts/konjugatePaths.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { syntheticRegion } from '../fixtures/syntheticRegion.mjs';

const { encodeProjectFile } = await import(pathToFileURL(konjugateModule('src/projectFile.mjs')));
const { decodeResultFile } = await import(pathToFileURL(konjugateModule('src/engineProtocol.mjs')));
const { decodeValidationReport } = await import(pathToFileURL(konjugateModule('src/reportProtocol.mjs')));

const executable = process.argv[2] ?? konjugateModule(join('out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine'));
const directory = await mkdtemp(join(tmpdir(), 'konjugateLogisticsRegion-'));
const day = 86400;
const templates = await loadTemplates();
const { candidates, roadGraph } = discoverRegion(syntheticRegion());
const route = createRouter(roadGraph).route;

function execute(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

async function run(name, { days, change = () => {} }) {
    const builder = new ModelBuilder(templates);
    const built = buildRegionModel({ builder, selection: defaultSelection(candidates), route });
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

function checkInvariants({ name, document, series }) {
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
    for (const lane of lanes) {
        const trucks = sum([series(`${lane}.idleTrucks`), series(`${lane}.returning`), loaded(lane).map((value) => value / 2)]);
        assert.ok(maxDrift(trucks) < 1e-6, `${name}: ${lane} must keep its trucks (drift ${maxDrift(trucks)}).`);
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
    console.log(`✓ region model from the synthetic region: ${baseline.document.nodes.length} nodes and ${baseline.document.edges.length} edges hold still in the baseline; a berth outage at Port Alder queues ${Math.round(queue[hour(50)]).toLocaleString('en')} TEU; containers, trucks and orders conserved.`);
} finally {
    await rm(directory, { recursive: true, force: true });
}
