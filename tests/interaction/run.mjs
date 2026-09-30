/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Logistics interaction test: launches the sibling Konjugate app with a scratch userData holding the
// freshly built logistics plugin, builds a small port network through the real UI, and checks it
// against the same network built from the templates by scripts/templatePlacement.mjs.
//
// Through the UI: place a port, two road lanes, two warehouses and two demand zones from the
// component library, wire them with the Road shipment and Delivery bundles, and set three shared
// parameters in the parameters table (the second lane's travel time and the second warehouse's
// planned replenishment time, and the first lane's fleet size). Then:
//   - the saved project has the same nodes, equations and shared parameters as the script-built one
//   - the app's run conserves containers, and its final state matches the script-built model run
//     through the engine CLI, state for state
// Then the plugin's example, opened from the Examples dialog, must do what its guide says: hold
// still in the baseline; in forks at day 10, queue ships at anchorage behind a berth outage
// (serving Zone 1 ahead of Zone 2), find the trucks are the bottleneck when demand steps up, and
// serve Zone 2 again once lane A's fleet grows.
// Konjugate's own interaction runner cannot be extended from outside, so this drives the app
// through Playwright, as the fintech toolbox does.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildModels } from '../../scripts/buildModels.mjs';
import { installBuiltPackages } from '../../scripts/installDev.mjs';
import { konjugateDir, konjugateModule } from '../../scripts/konjugatePaths.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';

const require = createRequire(join(konjugateDir, 'package.json'));
const { _electron: electron } = require('playwright');
const electronPath = require('electron');
const { decodeProjectFile, encodeProjectFile } = await import(pathToFileURL(konjugateModule('src/projectFile.mjs')));
const { decodeResultFile } = await import(pathToFileURL(konjugateModule('src/engineProtocol.mjs')));

const day = 86400;
const days = 120;
const runConfiguration = { id: 1, name: `${days} days`, globalTimeStep: 0.05 * day, outputInterval: day };
// Values the test sets in the parameters table, by shared-parameter symbol.
const edits = { leadTime2: 3, planningLeadTime2: 3.5, fleetSize: 200 };
const engineExecutable = konjugateModule(join('out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine'));

// Extra Electron switches, for example to run without a GPU: KONJUGATE_ELECTRON_ARGS='--no-sandbox --use-gl=angle --use-angle=swiftshader'.
const extraArgs = (process.env.KONJUGATE_ELECTRON_ARGS ?? '').split(' ').filter(Boolean);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const scratch = await mkdtemp(join(tmpdir(), 'konjugate-logistics-'));
const userData = join(scratch, 'userData');

// The same network the test builds in the app: templates placed in the same order, bundles on the
// same pairs, the same parameter edits.
async function scriptBuiltNetwork() {
    const model = new ModelBuilder(await loadTemplates());
    const port = model.placeNode('port');
    const lanes = [model.placeNode('roadLane'), model.placeNode('roadLane')];
    const warehouses = [model.placeNode('warehouse'), model.placeNode('warehouse')];
    const zones = [model.placeNode('demandZone'), model.placeNode('demandZone')];
    warehouses.forEach((warehouse, index) => model.applyBundle('roadShipment', { origin: port, lane: lanes[index], destination: warehouse }));
    warehouses.forEach((warehouse, index) => model.applyBundle('delivery', { warehouse, zone: zones[index] }));
    for (const [symbol, value] of Object.entries(edits)) model.setShared(symbol, value);
    const document = model.document({ days });
    Object.assign(document.runConfigurations[0], { globalTimeStep: runConfiguration.globalTimeStep, outputInterval: runConfiguration.outputInterval });
    return document;
}

function runEngine(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(engineExecutable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', resolve);
    });
}

async function finalStatesFromCli(document) {
    const inputPath = join(scratch, 'scriptBuilt.kjt');
    const configurationPath = join(scratch, 'scriptBuilt.json');
    const outputPath = join(scratch, 'scriptBuilt.kjr');
    await writeFile(inputPath, await encodeProjectFile(JSON.stringify(document)));
    await writeFile(configurationPath, JSON.stringify({ name: 'scriptBuilt', targetTime: days * day, globalTimeStep: runConfiguration.globalTimeStep, outputInterval: runConfiguration.outputInterval }));
    assert.equal(await runEngine(['run', inputPath, '--configuration', configurationPath, '--output', outputPath]), 0, 'The engine CLI run of the script-built network failed.');
    return decodeResultFile(await readFile(outputPath)).samples.at(-1);
}

// States keyed by node position and symbol ("2.onHand" = the third node placed), so the app-built
// and script-built models compare although their ids differ.
const stateKeys = (document) => new Map(document.nodes.flatMap((node, index) => node.states.map((state) => [state.id, `${index}.${state.symbol}`])));
const keyedValues = (document, sample) => {
    const keys = stateKeys(document);
    return new Map(sample.states.filter((state) => keys.has(state.stateId)).map((state) => [keys.get(state.stateId), state.value]));
};

// Containers are conserved: anchorage + stock everywhere + in transit + delivered - arrived so far.
function containerTotal(document, values) {
    let total = 0;
    document.nodes.forEach((node, index) => {
        for (const symbol of ['queue', 'stock', 'loaded1', 'loaded2', 'loaded3', 'delivered']) {
            if (values.has(`${index}.${symbol}`)) total += values.get(`${index}.${symbol}`);
        }
        if (values.has(`${index}.arrived`)) total -= values.get(`${index}.arrived`);
    });
    return total;
}

// Launches Konjugate (on `projectPath` when given), remembering every engine job so results can be
// read back by id; the caller closes the app.
async function launch(projectPath = null) {
    const app = await electron.launch({ executablePath: electronPath, args: [konjugateDir, ...extraArgs, `--user-data-dir=${userData}`, ...(projectPath ? [projectPath] : [])], env });
    await app.evaluate(({ ipcMain }) => {
        globalThis.logisticsJobIds = [];
        const original = ipcMain._invokeHandlers.get('engineStart');
        ipcMain._invokeHandlers.set('engineStart', async (...args) => {
            const execution = await original(...args);
            globalThis.logisticsJobIds.push(execution.jobId);
            return execution;
        });
    });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForFunction(() => typeof window.componentLibrary?.list === 'function');
    const jobIds = () => app.evaluate(() => globalThis.logisticsJobIds);
    return { app, window, jobIds };
}

// Offline run from the open launch dialog to `days`.
async function startRun(window, days) {
    await window.evaluate((time) => {
        document.querySelector('#runOnlineMode').checked = false;
        document.querySelector('#runOnlineMode').dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#runTargetTime').value = time;
    }, String(days * day));
    await window.click('#startRun');
}

try {
    await installBuiltPackages(userData);
    const projectPath = join(scratch, 'network.kjt');
    await writeFile(projectPath, await encodeProjectFile(JSON.stringify({
        format: 'konjugate', version: 1, metadata: { units: 'SI' }, nodes: [], edges: [], sharedParameters: [],
        runConfigurations: [runConfiguration], activeRunConfigurationId: runConfiguration.id
    })));

    const { app, window, jobIds } = await launch(projectPath);
    let appBuilt;
    let appFinal;
    try {

        // The plugin's templates are discoverable, with their kinds.
        const components = (await window.evaluate(() => window.componentLibrary.list())).filter((component) => component.domains?.includes('logistics'));
        const kinds = Object.fromEntries(components.map((component) => [component.id, component.kind]));
        assert.deepEqual(kinds, {
            port: 'node', roadLane: 'node', railLane: 'node', warehouse: 'node', demandZone: 'node',
            roadShipment: 'bundle', railShipment: 'bundle', delivery: 'bundle'
        });

        // Place the nodes from the component library, in the script's order.
        const count = (index) => window.evaluate((i) => Number(document.querySelectorAll('.modelStatus span')[i].textContent.match(/\d+/)[0]), index);
        await window.click('#componentLibraryButton');
        await window.waitForSelector('#componentLibraryPanel:not([hidden])');
        for (const [index, id] of ['port', 'roadLane', 'roadLane', 'warehouse', 'warehouse', 'demandZone', 'demandZone'].entries()) {
            await window.click(`[data-template-id="${id}"]`);
            await window.waitForFunction((expected) => Number(document.querySelectorAll('.modelStatus span')[0].textContent.match(/\d+/)[0]) === expected, index + 1);
        }
        const [port, laneA, laneB, warehouseA, warehouseB, zone1, zone2] = await window.evaluate(() => window.__debugTransform.allNodeIds());

        // Wire them with the bundles: select exactly the endpoints, click the bundle, expect its edges.
        const applyBundle = async (bundleId, ids, expectedEdges) => {
            const before = await count(1);
            await window.evaluate((selection) => window.__debugTransform.selectExactly(selection), ids);
            await window.click(`[data-template-id="${bundleId}"]`);
            await window.waitForFunction(([edges]) => Number(document.querySelectorAll('.modelStatus span')[1].textContent.match(/\d+/)[0]) === edges, [before + expectedEdges], { timeout: 10000 })
                .catch(async () => { throw new Error(`${bundleId} did not add ${expectedEdges} edges: ${await window.textContent('#componentLibraryHint')}`); });
        };
        // A road shipment has three endpoints; the app matches them by state symbols.
        await applyBundle('roadShipment', [port, laneA, warehouseA], 6);
        await applyBundle('roadShipment', [port, laneB, warehouseB], 6);
        await applyBundle('delivery', [warehouseA, zone1], 3);
        await applyBundle('delivery', [warehouseB, zone2], 3);

        // Edit shared parameters in the parameters table, as a user would.
        await window.click('#parametersButton');
        await window.waitForSelector('#parametersPanel:not([hidden])');
        for (const [symbol, value] of Object.entries(edits)) {
            const edited = await window.evaluate(([name, text]) => {
                const row = [...document.querySelectorAll('#parametersBody tr.sharedRow')].find((candidate) => candidate.querySelector('.symbolCell')?.textContent === name);
                const input = row?.querySelector('input[data-field="value"]');
                if (!input) return false;
                input.value = text;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }, [symbol, String(value)]);
            assert.ok(edited, `No shared parameter row for ${symbol}.`);
        }

        // The engine accepts what the app built.
        await window.waitForFunction(() => document.querySelector('#validationSummary').dataset.validationSource === 'engine', null, { timeout: 30000 });
        assert.equal(await window.evaluate(() => document.querySelector('#validationSummary').classList.contains('error')), false,
            'The app-built network should validate.');

        // Save back to the project file (no dialog: it already has a path) and read what the app built.
        const savedBefore = await readFile(projectPath);
        await window.click('#saveButton');
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const current = await readFile(projectPath);
            if (!current.equals(savedBefore)) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        appBuilt = JSON.parse(await decodeProjectFile(await readFile(projectPath)));

        // Run it in the app to the target time.
        await window.click('#runButton');
        await startRun(window, days);
        await window.waitForFunction(() => document.querySelector('#statusText').textContent === 'Simulation complete', null, { timeout: 120000 });
        const [jobId] = await jobIds();
        appFinal = await window.evaluate(([id, time]) => window.engine.readResultSample(id, time), [jobId, days * day]);
    } finally {
        await app.close().catch(() => {});
    }

    // --- The app built what the templates say. --------------------------------------------------
    const scriptBuilt = await scriptBuiltNetwork();
    assert.equal(appBuilt.nodes.length, 7);
    assert.equal(appBuilt.edges.length, 2 * 6 + 2 * 3);
    const sharedSummary = (document) => Object.fromEntries(document.sharedParameters.map((shared) => [shared.symbol, shared.value]));
    assert.deepEqual(sharedSummary(appBuilt), sharedSummary(scriptBuilt), 'The app and the script should create the same shared parameters with the same values.');
    appBuilt.nodes.forEach((node, index) => {
        const expected = scriptBuilt.nodes[index];
        assert.deepEqual(node.states.map((state) => [state.symbol, state.initialValue]), expected.states.map((state) => [state.symbol, state.initialValue]), `Node ${index} states differ.`);
        assert.deepEqual(node.sourceTerms.map((term) => [term.state, term.expression, Boolean(term.setsValue), (term.parameters ?? []).length]),
            expected.sourceTerms.map((term) => [term.state, term.expression, Boolean(term.setsValue), term.parameters.length]), `Node ${index} source terms differ.`);
    });
    const edgeSummary = (document) => document.edges.map((edge) => [edge.directionality, edge.equationModel.latex, edge.parameters.length]).sort();
    assert.deepEqual(edgeSummary(appBuilt), edgeSummary(scriptBuilt), 'The app and the script should create the same edges.');

    // --- The app's run conserves containers and matches the script-built model run by the CLI. -----
    const appValues = keyedValues(appBuilt, appFinal);
    const initialValues = new Map(appBuilt.nodes.flatMap((node, index) => node.states.map((state) => [`${index}.${state.symbol}`, state.initialValue])));
    const drift = containerTotal(appBuilt, appValues) - containerTotal(appBuilt, initialValues);
    assert.ok(Math.abs(drift) < 1e-6, `The app's run should conserve containers (drift ${drift} TEU).`);
    const cliValues = keyedValues(scriptBuilt, await finalStatesFromCli(scriptBuilt));
    assert.equal(appValues.size, cliValues.size);
    for (const [key, value] of cliValues) {
        assert.ok(Math.abs(appValues.get(key) - value) <= 1e-9 * Math.max(1, Math.abs(value)), `${key}: app ${appValues.get(key)} vs script-built ${value}.`);
    }
    console.log(`✓ logistics interaction: the app placed and wired 7 nodes and 18 edges from the templates, matching the script-built network; its ${days}-day run conserved containers and matched the engine CLI on all ${cliValues.size} states.`);

    // --- The example does what its guide says. ------------------------------------------------------
    const example = (await buildModels(join(scratch, 'models'))).find((model) => model.name === 'portWarehouseNetwork');
    const session = await launch();
    try {
        const { window: exampleWindow, jobIds: exampleJobs } = session;
        // Loading an example over the untitled project may ask to discard it; answer from main.
        await session.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
        await exampleWindow.click('#exampleButton');
        await exampleWindow.waitForSelector('#examplesExplorerDialog[open]');
        await exampleWindow.click('.examplesExplorerItem[data-example-id="portWarehouseNetwork.kjt"]');
        await exampleWindow.click('#examplesExplorerLoad');
        await exampleWindow.waitForFunction(() => !document.querySelector('#examplesExplorerDialog').open);
        await exampleWindow.waitForSelector('#runButton:not([disabled])', { timeout: 30000 });

        // A branch's value of `name` ("Port.yard") at `atDay`.
        const valueAt = async (jobId, name, atDay) => {
            const sample = await exampleWindow.evaluate(([id, time]) => window.engine.readResultSample(id, time), [jobId, atDay * day]);
            return sample.states.find((state) => state.stateId === example.states[name]).value;
        };
        // Share of a zone's orders delivered between two days.
        const fill = async (jobId, zone, from, to) => (
            (await valueAt(jobId, `${zone}.delivered`, to) - await valueAt(jobId, `${zone}.delivered`, from)) /
            (await valueAt(jobId, `${zone}.ordered`, to) - await valueAt(jobId, `${zone}.ordered`, from)));
        // Forks the baseline branch at day 10 with the given live values (by name) and runs to day 120.
        // Forking lives in the Branches panel: the tree of branches, with Fork here at the top.
        const openBranches = async () => {
            if (await exampleWindow.evaluate(() => document.querySelector('#branchesPanel').hidden)) await exampleWindow.click('#branchesButton');
            await exampleWindow.waitForSelector('#branchesPanel:not([hidden])');
        };
        const forkBaseline = async (values) => {
            await openBranches();
            const branchButtons = exampleWindow.locator('#branchTree .branchTreeButton');
            if (await branchButtons.count() > 1) await branchButtons.first().click();
            await exampleWindow.evaluate((time) => {
                const timeline = document.querySelector('#resultTimeline');
                timeline.value = time;
                timeline.dispatchEvent(new Event('input', { bubbles: true }));
            }, String(10 * day));
            const branchesBefore = (await exampleJobs()).length;
            await openBranches();
            await exampleWindow.click('#forkHereButton');
            await exampleWindow.waitForSelector('#forkParameterPanel:not([hidden])');
            assert.equal(await exampleWindow.locator('#forkParameterRows .liveParameterRow').count(), 4, 'The example should offer its four live controls.');
            for (const [name, value] of Object.entries(values)) {
                const input = `#forkParameterRows input[aria-label="${name} value"]`;
                await exampleWindow.fill(input, String(value));
                await exampleWindow.dispatchEvent(input, 'change');
            }
            await exampleWindow.click('#confirmForkParameters');
            await exampleWindow.waitForSelector('#runLaunchDialog[open]');
            await startRun(exampleWindow, days);
            // The fork's own run: wait until it has started and has reached the target time.
            const deadline = Date.now() + 120000;
            let jobs = await exampleJobs();
            while (jobs.length === branchesBefore && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 200));
                jobs = await exampleJobs();
            }
            assert.equal(jobs.length, branchesBefore + 1, 'The fork should start exactly one new run.');
            const jobId = jobs.at(-1);
            while (!(await exampleWindow.evaluate(([id, time]) => window.engine.readResultSample(id, time), [jobId, days * day]))) {
                if (Date.now() > deadline) throw new Error('The fork did not reach its target time.');
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            return jobId;
        };

        // 1. The baseline holds still.
        await exampleWindow.click('#runButton');
        await startRun(exampleWindow, days);
        await exampleWindow.waitForFunction(() => document.querySelector('#statusText').textContent === 'Simulation complete', null, { timeout: 120000 });
        const [baseline] = await exampleJobs();
        assert.ok(Math.abs(await valueAt(baseline, 'Port.queue', days) - 25) < 1e-6, 'Baseline: 25 TEU should wait at anchorage.');
        assert.ok(Math.abs(await valueAt(baseline, 'Port.stock', days) - 300) < 1e-6, 'Baseline: the yard should hold 300 TEU.');
        assert.ok(Math.abs(await valueAt(baseline, 'Warehouse A.stock', days) - 210) < 1e-6, 'Baseline: Warehouse A should hold 210 TEU.');
        for (const zone of ['Zone 1', 'Zone 2', 'Zone 3']) assert.ok(Math.abs(await fill(baseline, zone, 0, days) - 1) < 1e-9, `Baseline: ${zone} should be fully served.`);

        // 2. A berth outage from day 20 to 50 queues ships at anchorage; Zone 1 is served ahead of
        // Zone 2, and the trucks limit the recovery.
        const outage = await forkBaseline({ 'Berth capacity during outage': 30 });
        assert.ok(Math.abs(await valueAt(outage, 'Port.queue', 50) - 2125) < 5, 'Outage: about 2,125 TEU should wait at anchorage by day 50.');
        assert.ok(await valueAt(outage, 'Port.waitDays', 49) > 60, 'Outage: the anchorage wait should exceed 60 days.');
        assert.ok(await valueAt(outage, 'Port.queue', 95) < 50, 'Outage: the anchorage should have cleared by day 95.');
        const zone1 = await fill(outage, 'Zone 1', 20, 60);
        const zone2 = await fill(outage, 'Zone 2', 20, 60);
        assert.ok(zone1 > 0.75 && zone2 < 0.45, `Outage: Zone 1 should get about 80% of its orders (got ${zone1}) and Zone 2 about 41% (got ${zone2}).`);
        assert.ok(await valueAt(outage, 'Zone 2.backlog', days) > 500, 'Outage: Zone 2 should still be far behind at day 120.');

        // 3. A demand step with matching ship arrivals: the port copes, lane A's trucks don't, and
        // port dispatches overshoot (the bullwhip effect).
        const surge = await forkBaseline({ 'Demand step multiplier': 1.3, 'Vessel arrivals': 130 });
        assert.ok(await valueAt(surge, 'Port.waitDays', 60) < 1, 'Surge: the anchorage wait should stay under a day.');
        const surgeZone2 = await fill(surge, 'Zone 2', 60, days);
        assert.ok(surgeZone2 < 0.85, `Surge: Zone 2 should receive about 79% of its orders after day 60 (got ${surgeZone2}).`);
        assert.ok(Math.abs((await valueAt(surge, 'Road lane A.arriving', 100)) - 80) < 1, 'Surge: 170 trucks should carry about 80 TEU/day.');
        let peak = 0;
        for (let atDay = 21; atDay <= 60; atDay += 1) {
            const dispatched = (await valueAt(surge, 'Port.handled', atDay) - await valueAt(surge, 'Port.handled', atDay - 1)) -
                (await valueAt(surge, 'Port.stock', atDay) - await valueAt(surge, 'Port.stock', atDay - 1));
            peak = Math.max(peak, dispatched);
        }
        assert.ok(peak > 120, `Surge: port dispatches should overshoot to over 120 TEU/day (peak ${peak}).`);

        // 4. The same surge with lane A's fleet raised to 210: Zone 2 is served again.
        const hired = await forkBaseline({ 'Demand step multiplier': 1.3, 'Vessel arrivals': 130, 'Fleet size': 210 });
        const hiredZone2 = await fill(hired, 'Zone 2', 60, days);
        assert.ok(hiredZone2 > 0.99, `More trucks: Zone 2 should receive over 99% of its orders (got ${hiredZone2}).`);
        console.log(`✓ logistics example: the baseline holds still; the berth outage queues 2,125 TEU at anchorage and serves Zone 1 (${(100 * zone1).toFixed(0)}%) ahead of Zone 2 (${(100 * zone2).toFixed(0)}%); in the demand surge 170 trucks serve Zone 2 ${(100 * surgeZone2).toFixed(0)}% while port dispatches swing to ${peak.toFixed(0)} TEU/day, and 210 trucks serve it ${(100 * hiredZone2).toFixed(0)}%.`);
    } finally {
        await session.app.close().catch(() => {});
    }
} finally {
    await rm(scratch, { recursive: true, force: true });
}
