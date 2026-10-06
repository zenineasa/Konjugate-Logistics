/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Running a built model through the real engine CLI, and the invariants every logistics model keeps:
// containers conserved, every road lane's trucks conserved (unless a scenario changes the fleets), and each
// warehouse's on-order count equal to what waits on and travels along its lanes.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { konjugateModule } from '../../scripts/konjugatePaths.mjs';

const { encodeProjectFile } = await import(pathToFileURL(konjugateModule('src/projectFile.mjs')));
const { decodeResultFile } = await import(pathToFileURL(konjugateModule('src/engineProtocol.mjs')));
const { decodeValidationReport } = await import(pathToFileURL(konjugateModule('src/reportProtocol.mjs')));

export const day = 86400;
export const executable = process.argv[2] ?? konjugateModule(join('out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine'));
// KONJUGATE_ENGINE=export runs the model as Konjugate's code export writes it, a standalone Python program that
// follows the engine step for step (Konjugate checks this in its codeExportFidelity test): for a machine with no
// engine build of its own. Validation is then the equation checks the model builder already made.
const useExport = process.env.KONJUGATE_ENGINE === 'export';

async function runExported(directory, name, document, days) {
    const { generateStandaloneProgram, buildModel } = await import(pathToFileURL(konjugateModule('src/codeExport.mjs')));
    const sourcePath = join(directory, `${name}Model.py`);
    const outputPath = join(directory, `${name}.csv`);
    await writeFile(sourcePath, generateStandaloneProgram(document, 'python'));
    const run = (command, args) => new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name}: ${command} exited with ${code}.`))));
    });
    await run(process.env.PYTHON ?? 'python3', ['-I', sourcePath, '--target-time', String(days * day), '--output', outputPath]);
    const rows = (await readFile(outputPath, 'utf8')).trim().split('\n').slice(1).map((line) => line.split(',').map(Number));
    const columns = new Map();
    let column = 1;
    for (const plan of buildModel(document).nodePlans) for (const state of plan.node.states) columns.set(`${plan.node.name}.${state.symbol}`, column++);
    const series = (key) => {
        if (!columns.has(key)) throw new Error(`${name}: no state ${key}.`);
        const index = columns.get(key);
        return rows.map((row) => row[index]);
    };
    return { name, document, series };
}

function execute(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

// Validates and runs `document` for `days`, in `directory`; returns { series(key) } of "Node.state" values, hourly.
export async function runDocument(directory, name, document, days) {
    if (useExport) return runExported(directory, name, document, days);
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
    return { name, document, series };
}

export const sum = (arrays) => arrays[0].map((_, index) => arrays.reduce((total, values) => total + values[index], 0));
// What a sum of series may drift by: rounding only. An exported program writes ten significant digits, so a sum of
// large values may drift by a few billionths of their size.
export const tolerance = (arrays) => 1e-6 + (useExport ? 1e-9 * arrays.reduce((total, values) => total + Math.max(...values.map(Math.abs)), 0) : 0);
export const maxDrift = (values) => Math.max(...values.map((value) => Math.abs(value - values[0])));
export const hour = (days) => Math.round(days * 24);

export function checkInvariants({ name, document, series }, { fleetsChange = false } = {}) {
    const ofType = (type) => document.nodes.filter((node) => node.type === type).map((node) => node.name);
    const ports = ofType('Port');
    const lanes = ofType('Road lane');
    const warehouses = ofType('Warehouse');
    const towns = ofType('Demand zone');
    assert.ok(ports.length && lanes.length && warehouses.length && towns.length, `${name}: the model has every kind of node.`);
    const loaded = (lane) => sum(['loaded1', 'loaded2', 'loaded3'].map((stage) => series(`${lane}.${stage}`)));
    const goods = [
        ...ports.flatMap((port) => [series(`${port}.queue`), series(`${port}.stock`), series(`${port}.arrived`).map((value) => -value)]),
        ...lanes.map(loaded), ...warehouses.map((warehouse) => series(`${warehouse}.stock`)), ...towns.map((town) => series(`${town}.delivered`))
    ];
    const containers = sum(goods);
    assert.ok(maxDrift(containers) < tolerance(goods), `${name}: goods must be conserved (drift ${maxDrift(containers)}).`);
    for (const lane of fleetsChange ? [] : lanes) {
        for (const size of ['', '2']) {
            const parts = [series(`${lane}.idleTrucks${size}`), series(`${lane}.returning${size}`), series(`${lane}.loadedTrucks${size}`)];
            const trucks = sum(parts);
            assert.ok(maxDrift(trucks) < tolerance(parts), `${name}: ${lane} must keep its trucks${size ? ' of the second size' : ''} (drift ${maxDrift(trucks)}).`);
        }
    }
    const nodeName = new Map(document.nodes.map((node) => [node.id, node.name]));
    for (const warehouse of warehouses) {
        const itsLanes = [...new Set(document.edges
            .filter((edge) => nodeName.get(edge.target.nodeId) === warehouse && lanes.includes(nodeName.get(edge.source.nodeId)))
            .map((edge) => nodeName.get(edge.source.nodeId)))];
        const parts = [series(`${warehouse}.onOrder`), ...itsLanes.flatMap((lane) => [series(`${lane}.requested`), loaded(lane)])];
        const pipeline = sum(parts.slice(1));
        const gap = parts[0].map((value, index) => value - pipeline[index]);
        assert.ok(maxDrift(gap) < tolerance(parts) && Math.abs(gap[0]) < tolerance(parts), `${name}: ${warehouse} on order must match its lanes (drift ${maxDrift(gap)}).`);
    }
}

// Every state that is not a running total holds still.
export function checkSteady({ name, document, series }) {
    const cumulative = /^(arrived|handled|delivered|ordered|transportCost|fleetCost|holdingCost|backlogCost)$/;
    for (const node of document.nodes) {
        for (const state of node.states) {
            if (cumulative.test(state.symbol)) continue;
            const values = series(`${node.name}.${state.symbol}`);
            assert.ok(maxDrift(values) < 1e-6 * Math.max(1, Math.abs(values[0])), `${name}: ${node.name}.${state.symbol} should hold still (drift ${maxDrift(values)}).`);
        }
    }
}
