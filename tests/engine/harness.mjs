/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Running a built model through the real engine CLI, and the invariants every logistics model keeps:
// containers conserved (in the whole model and in each part of it that is joined up, so in each product category on
// its own), every road lane's trucks conserved (unless a scenario changes the fleets), each warehouse's on-order count
// equal to what waits on and travels along its lanes, and each supplier's order book equal to what waits on its lanes.

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

export function checkInvariants(result, options = {}) {
    const goods = checkGoods(result);
    checkRest(result, options);
    return goods;
}

function checkGoods({ name, document, series }) {
    const ofType = (type) => document.nodes.filter((node) => node.type === type).map((node) => node.name);
    const ports = ofType('Port');
    const lanes = ofType('Road lane');
    const warehouses = ofType('Warehouse');
    const towns = ofType('Demand zone');
    const suppliers = ofType('Supplier');
    assert.ok((ports.length || suppliers.length) && lanes.length && warehouses.length && towns.length, `${name}: the model has every kind of node.`);
    const loaded = (lane) => sum(['loaded1', 'loaded2', 'loaded3'].map((stage) => series(`${lane}.${stage}`)));
    const making = (supplier) => sum(['making1', 'making2', 'making3', 'stock'].map((stage) => series(`${supplier}.${stage}`)));
    // What a node holds of the goods, less what has entered the model through it.
    const held = new Map([
        ...ports.map((port) => [port, [series(`${port}.queue`), series(`${port}.stock`), series(`${port}.arrived`).map((value) => -value)]]),
        ...suppliers.map((supplier) => [supplier, [making(supplier), series(`${supplier}.made`).map((value) => -value)]]),
        ...lanes.map((lane) => [lane, [loaded(lane)]]), ...warehouses.map((warehouse) => [warehouse, [series(`${warehouse}.stock`)]]),
        ...towns.map((town) => [town, [series(`${town}.delivered`)]])
    ]);
    const goods = [...held.values()].flat();
    const containers = sum(goods);
    assert.ok(maxDrift(containers) < tolerance(goods), `${name}: goods must be conserved (drift ${maxDrift(containers)}).`);
    // And in each part of the model that is joined up: a product category's goods never become another's.
    const names = new Map(document.nodes.map((node) => [node.id, node.name]));
    const group = new Map(document.nodes.map((node) => [node.name, node.name]));
    const find = (node) => { while (group.get(node) !== node) node = group.get(node); return node; };
    for (const edge of document.edges) group.set(find(names.get(edge.source.nodeId)), find(names.get(edge.target.nodeId)));
    const parts = new Map();
    for (const [node, series] of held) parts.set(find(node), [...(parts.get(find(node)) ?? []), ...series]);
    for (const [part, its] of parts) {
        assert.ok(maxDrift(sum(its)) < tolerance(its), `${name}: the goods of the part of the model around ${part} must be conserved (drift ${maxDrift(sum(its))}).`);
    }
    // A supplier makes everything ordered from it: what it has still to make is what was ordered less what it has
    // started, and what waits on its lanes is what it has to make, is making or has ready.
    for (const supplier of suppliers) {
        const book = [series(`${supplier}.toMake`), series(`${supplier}.ordered`).map((value) => -value), series(`${supplier}.made`)];
        assert.ok(maxDrift(sum(book)) < tolerance(book), `${name}: ${supplier}'s orders must be made or waiting (drift ${maxDrift(sum(book))}).`);
        const itsLanes = [...new Set(document.edges.filter((edge) => names.get(edge.source.nodeId) === supplier && lanes.includes(names.get(edge.target.nodeId))).map((edge) => names.get(edge.target.nodeId)))];
        const waiting = [series(`${supplier}.toMake`), making(supplier), ...itsLanes.map((lane) => series(`${lane}.requested`).map((value) => -value))];
        assert.ok(maxDrift(sum(waiting)) < tolerance(waiting), `${name}: what waits on ${supplier}'s lanes must be what it has to make or has ready (drift ${maxDrift(sum(waiting))}).`);
    }
    return { parts: parts.size };
}

function checkRest({ name, document, series }, { fleetsChange = false } = {}) {
    const ofType = (type) => document.nodes.filter((node) => node.type === type).map((node) => node.name);
    const lanes = ofType('Road lane');
    const warehouses = ofType('Warehouse');
    const towns = ofType('Demand zone');
    const loaded = (lane) => sum(['loaded1', 'loaded2', 'loaded3'].map((stage) => series(`${lane}.${stage}`)));
    for (const lane of fleetsChange ? [] : lanes) {
        for (const size of ['', '2']) {
            const parts = [series(`${lane}.idleTrucks${size}`), series(`${lane}.returning${size}`), series(`${lane}.loadedTrucks${size}`)];
            const trucks = sum(parts);
            assert.ok(maxDrift(trucks) < tolerance(parts), `${name}: ${lane} must keep its trucks${size ? ' of the second size' : ''} (drift ${maxDrift(trucks)}).`);
        }
    }
    // Every order is delivered, lost or still waiting.
    for (const town of towns) {
        const parts = ['backlog', 'ordered', 'delivered', 'lost'].map((symbol) => series(`${town}.${symbol}`));
        const [backlog, ordered, delivered, lost] = parts;
        const gap = backlog.map((value, index) => value - backlog[0] - (ordered[index] - delivered[index] - lost[index]));
        assert.ok(Math.max(...gap.map(Math.abs)) < tolerance(parts), `${name}: ${town}'s orders must be delivered, lost or waiting (drift ${Math.max(...gap.map(Math.abs))}).`);
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
    const cumulative = /^(arrived|handled|delivered|ordered|made|lost|transportCost|fleetCost|holdingCost|backlogCost)$/;
    for (const node of document.nodes) {
        for (const state of node.states) {
            if (cumulative.test(state.symbol)) continue;
            const values = series(`${node.name}.${state.symbol}`);
            assert.ok(maxDrift(values) < 1e-6 * Math.max(1, Math.abs(values[0])), `${name}: ${node.name}.${state.symbol} should hold still (drift ${maxDrift(values)}).`);
        }
    }
}
