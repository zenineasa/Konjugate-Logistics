/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The Logistics Toolbox window in the real app, offline: the main process's fetch is replaced so the place
// search and the five OpenStreetMap queries are answered from the synthetic region
// (tests/fixtures/syntheticRegion.mjs). Through the window:
//   - the sample region discovers without any network
//   - a place search and "Fetch map data" send one query per kind for the chosen area, and discovery shows
//     the candidates, the coverage report and its notices
//   - a port's volume is set, the model is built and appears in the canvas with the importer's node count
//   - dragging a kept site on the map rebuilds the model with new lane distances
//   - a customer added on the map is served in the rebuilt model
//   - a chokepoint disruption, its cargo lost, delayed or diverted to another port; then an invented fleet operator, labelled synthetic, and a road closure, a fleet cut
//     and a demand surge from the scenario tabs
// Uses Playwright from the Konjugate checkout, as the other interaction test does.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installBuiltPackages } from '../../scripts/installDev.mjs';
import { konjugateDir, konjugateModule } from '../../scripts/konjugatePaths.mjs';
import { syntheticPortwatch, syntheticRegion } from '../fixtures/syntheticRegion.mjs';

const require = createRequire(join(konjugateDir, 'package.json'));
const { _electron: electron } = require('playwright');
const electronPath = require('electron');
const { decodeProjectFile, encodeProjectFile } = await import(pathToFileURL(konjugateModule('src/projectFile.mjs')));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const scratch = await mkdtemp(join(tmpdir(), 'konjugate-logistics-region-'));
const userData = join(scratch, 'userData');
const extraArgs = (process.env.KONJUGATE_ELECTRON_ARGS ?? '').split(' ').filter(Boolean);

async function openToolbox(app, window) {
    await window.waitForSelector('.addonTool[data-addon-id="konjugate.logistics.toolbox"][data-command-id="openLogisticsToolbox"]', { timeout: 30000 });
    const known = new Set(app.windows());
    await window.click('.addonTool[data-addon-id="konjugate.logistics.toolbox"][data-command-id="openLogisticsToolbox"]');
    for (let attempt = 0; attempt < 150; attempt += 1) {
        const page = app.windows().find((candidate) => !known.has(candidate) && candidate.url().includes('konjugate.logistics.toolbox'));
        if (page) {
            await page.waitForLoadState('domcontentloaded');
            return page;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The Logistics toolbox window did not open.');
}

async function waitForFile(path) {
    for (let attempt = 0; attempt < 150; attempt += 1) {
        try { if ((await stat(path)).size > 0) return; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${path} was not written.`);
}

try {
    await installBuiltPackages(userData);
    const projectPath = join(scratch, 'empty.kjt');
    await writeFile(projectPath, await encodeProjectFile(JSON.stringify({
        format: 'konjugate', version: 1, metadata: { units: 'SI' }, nodes: [], edges: [], sharedParameters: [],
        runConfigurations: [{ id: 1, name: 'Default', globalTimeStep: 900, outputInterval: 3600 }], activeRunConfigurationId: 1
    })));
    let app = await electron.launch({ executablePath: electronPath, args: [konjugateDir, ...extraArgs, `--user-data-dir=${userData}`, projectPath], env });
    try {
        // The network, answered from the synthetic region; every address asked for is recorded.
        await app.evaluate((_electron, answers) => {
            globalThis.logisticsRequests = [];
            const kindOf = (query) => (query.includes('"landuse"="port"') ? 'ports' : query.includes('"building"="warehouse"') ? 'logistics'
                : query.includes('"highway"') ? 'roads' : query.includes('"railway"="rail"') ? 'rail' : query.includes('"place"') ? 'places' : null);
            globalThis.fetch = async (url) => {
                const address = new URL(url);
                globalThis.logisticsRequests.push(address.href);
                if (address.hostname === 'nominatim.openstreetmap.org') {
                    return new Response(JSON.stringify([{ display_name: 'Port Alder, Synthetic Coast', type: 'harbour', lat: '-29.99', lon: '-19.9', boundingbox: ['-29.9', '-29.8', '-19.75', '-19.6'] }]), { status: 200 });
                }
                // The map server's status page: a free slot now, so no fetch waits.
                if (address.href === 'https://overpass-api.de/api/status') return new Response('Rate limit: 2\n2 slots available now.\n', { status: 200 });
                if (address.hostname === 'overpass-api.de') return new Response(answers[kindOf(address.searchParams.get('data'))], { status: 200 });
                // IMF PortWatch: the ports around the region, and Port Alder's history.
                if (address.hostname === 'services9.arcgis.com' && address.pathname.includes('/PortWatch_ports_database/')) return new Response(answers.portwatchPorts, { status: 200 });
                if (address.hostname === 'services9.arcgis.com' && address.pathname.includes('/Daily_Ports_Data/') && address.searchParams.get('where') === "portid='port9001'") return new Response(answers.portwatchActivity, { status: 200 });
                // A chokepoint's transits: 40 container ships a day in its busiest full year, 10 a day lately.
                if (address.hostname === 'services9.arcgis.com' && address.pathname.includes('/Daily_Chokepoints_Data/')) {
                    return new Response(address.searchParams.has('groupByFieldsForStatistics') ? answers.chokepointYearly : answers.chokepointRecent, { status: 200 });
                }
                return new Response('not found', { status: 404 });
            };
        }, Object.fromEntries(Object.entries({
            ...syntheticRegion(), ...syntheticPortwatch(),
            chokepointYearly: { features: [{ attributes: { year: 2023, containerShips: 40, days: 365 } }, { attributes: { year: 2024, containerShips: 20, days: 366 } }] },
            chokepointRecent: { features: Array.from({ length: 30 }, (_, index) => ({ attributes: { date: `2026-09-${String(index + 1).padStart(2, '0')}`, n_container: 10 } })) }
        }).map(([kind, answer]) => [kind, JSON.stringify(answer)])));

        const window = await app.firstWindow();
        await window.waitForLoadState('domcontentloaded');
        await window.waitForSelector('.addonTool[data-addon-id="konjugate.logistics.toolbox"][data-command-id="openLogisticsToolbox"]', { timeout: 30000 });
        await window.click('.addonTool[data-addon-id="konjugate.logistics.toolbox"][data-command-id="openLogisticsToolbox"]');
        let toolbox = null;
        for (let attempt = 0; attempt < 150 && !toolbox; attempt += 1) {
            toolbox = app.windows().find((candidate) => candidate.url().includes('konjugate.logistics.toolbox'));
            if (!toolbox) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(toolbox, 'The Logistics toolbox window did not open.');
        const log = [];
        toolbox.on('console', (message) => log.push(`${message.type()}: ${message.text().slice(0, 300)}`));
        toolbox.on('pageerror', (error) => log.push(`pageerror: ${error.message}`));
        // On a failure, what the window shows: its build and scenario status, the last result's summary and the tab.
        const fail = async (error) => {
            const shown = await toolbox.evaluate(() => ({
                build: document.querySelector('#buildStatus')?.innerText, scenario: document.querySelector('#scenarioStatus')?.innerText,
                result: document.querySelector('#scenarioResult p')?.textContent, tab: document.querySelector('#scenarioTabs .active')?.dataset.scenario
            })).catch((problem) => problem.message);
            throw new Error(`${error.message}\nThe window shows: ${JSON.stringify(shown)}\nToolbox window log:\n${log.join('\n')}`);
        };
        await toolbox.waitForLoadState('domcontentloaded');
        const counts = (page = toolbox) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-count]')].map((node) => [node.dataset.count, node.textContent])));

        // 1. The sample region, with no network at all.
        await toolbox.click('#sampleButton');
        await toolbox.waitForSelector('#stepCurate:not([hidden]) #candidateList li', { timeout: 30000 }).catch(fail);
        assert.deepEqual(await counts(), { ports: '2/2', zones: '2/2', towns: '3/3' });

        // 2. A place search, then the region's data, one query per kind for the chosen area.
        await toolbox.fill('#searchInput', 'Port Alder');
        await toolbox.click('#searchButton');
        await toolbox.click('#searchResults button[data-index="0"]');
        await toolbox.selectOption('#marginSelect', '25');
        assert.match(await toolbox.textContent('#areaSize'), /^\d+ × \d+ km/);
        await toolbox.click('#fetchButton');
        await toolbox.waitForFunction(() => document.querySelectorAll('#fetchProgress li.done').length === 6, null, { timeout: 60000 }).catch(fail);
        // The rows finish before the window discovers the region again, and the sample's Port Alder is already
        // listed: wait for the whole fetch to end (the button is enabled again) before reading the results.
        await toolbox.waitForFunction(() => !document.querySelector('#fetchButton').disabled, null, { timeout: 60000 }).catch(fail);
        await toolbox.waitForFunction(() => /Port Alder/.test(document.querySelector('#candidateList')?.textContent ?? ''), null, { timeout: 30000 }).catch(fail);
        const requests = await app.evaluate(() => globalThis.logisticsRequests);
        const queries = requests.filter((url) => url.includes('overpass-api.de/api/interpreter')).map((url) => new URL(url).searchParams.get('data'));
        const boxOf = (query) => query.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/).slice(1).map(Number);
        const roadQueries = queries.filter((query) => query.includes('"highway"'));
        assert.ok(roadQueries.length > 1, 'An area this large fetches its roads in tiles.');
        for (const query of roadQueries) {
            const [south, west, north, east] = boxOf(query);
            assert.ok((north - south) * 111.32 <= 40.01 && (east - west) * 111.32 * Math.cos((south + north) / 2 * Math.PI / 180) <= 40.01, 'No tile is wider than 40 km.');
        }
        for (const marker of ['"landuse"="port"', '"building"="warehouse"', '"highway"', '"railway"="rail"', '"place"']) assert.ok(queries.some((query) => query.includes(marker)), `Every kind is fetched (${marker}).`);
        const bbox = new URL(requests.find((url) => url.includes('overpass-api.de/api/interpreter'))).searchParams.get('data').match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/).slice(1).map(Number);
        assert.ok(bbox[0] < -29.9 - 0.2 && bbox[2] > -29.8 + 0.2, `25 km is added around the place (${bbox}).`);
        assert.match(await toolbox.textContent('#coverageSummary'), /Warehouses\s*good/);
        assert.match(await toolbox.textContent('#notices'), /marinas, fishing and passenger harbours were left out/);
        assert.equal(await toolbox.locator('#map .site').count(), 7);
        // Port activity: the ports list, then the history of the one port that matched (Port Alder), and nothing else.
        const portwatch = requests.filter((url) => url.includes('services9.arcgis.com'));
        assert.equal(portwatch.length, 2, portwatch.join('\n'));
        assert.ok(portwatch.every((url) => new URL(url).pathname.startsWith('/weJ1QsnbMYJlCHdG/ArcGIS/rest/services/')), 'only under the IMF account');
        assert.match(await toolbox.textContent('#fetchProgress [data-kind="portwatch"]'), /1 port matched/);
        assert.match(await toolbox.textContent('#notices'), /Port activity from IMF PortWatch: Port Alder imports about 137 TEU a day/);
        assert.match(await toolbox.textContent('#attribution'), /IMF PortWatch \(Source: International Monetary Fund\)/);

        // 3. Port Alder hands 150 TEU a day inland; build, and the model is in the canvas.
        await toolbox.locator('#candidateList li', { hasText: 'Port Alder' }).locator('input[type="number"]').fill('150');
        await toolbox.click('#buildButton');
        await toolbox.waitForSelector('#buildStatus .notice.ok, #buildStatus .notice.error', { timeout: 60000 }).catch(fail);
        const built = await toolbox.textContent('#buildStatus');
        assert.match(built, /^2 ports, \d+ road lanes?, 3 towns served: (\d+) nodes and (\d+) relationships, now in the canvas\./);
        const [, nodes, edges] = built.match(/(\d+) nodes and (\d+) relationships/).map(Number);
        await window.waitForFunction(([n, e]) => new RegExp(`${n} nodes`).test(document.querySelector('.modelStatus').textContent) && new RegExp(`${e} relationships`).test(document.querySelector('.modelStatus').textContent), [nodes, edges], { timeout: 30000 });
        assert.match(await toolbox.textContent('#buildResult'), /Containers handed inland: 150/);
        assert.ok(await toolbox.locator('#map .lane').count() > 0, 'The lanes are drawn on the map.');

        // 4. Drag Alder Industrial Park a little north: the model is rebuilt with new distances to it.
        const laneKilometres = () => toolbox.evaluate(() => [...document.querySelectorAll('#buildResult table:first-of-type tbody tr')].filter((row) => /Port Alder → Alder Industrial Park/.test(row.textContent)).map((row) => row.cells[2].textContent)[0]);
        const before = await laneKilometres();
        assert.ok(before, 'Port Alder supplies Alder Industrial Park.');
        const park = toolbox.locator('#map .site.zone').filter({ has: toolbox.locator('title', { hasText: 'Alder Industrial Park' }) });
        const box = await park.boundingBox();
        await toolbox.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await toolbox.mouse.down();
        await toolbox.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 8, { steps: 4 });
        await toolbox.mouse.up();
        await toolbox.waitForFunction(() => /moved/.test(document.querySelector('#candidateList').textContent) || document.querySelector('[data-group="zones"]').classList.contains('active'), null, { timeout: 5000 }).catch(() => {});
        await toolbox.waitForFunction((previous) => {
            const row = [...document.querySelectorAll('#buildResult table:first-of-type tbody tr')].find((item) => /Port Alder → Alder Industrial Park/.test(item.textContent));
            return row && row.cells[2].textContent !== previous && !document.querySelector('#buildStatus .notice.warning');
        }, before, { timeout: 30000 }).catch(fail);
        const after = await laneKilometres();
        assert.notEqual(after, before);

        // 5. A customer added on the map is served in the rebuilt model.
        await toolbox.click('[data-add="town"]');
        const mapBox = await toolbox.locator('#map').boundingBox();
        await toolbox.mouse.click(mapBox.x + mapBox.width * 0.6, mapBox.y + mapBox.height * 0.4);
        await toolbox.fill('#addSiteName', 'Harbour customers');
        await toolbox.click('#addSiteForm button[type="submit"]');
        await toolbox.waitForFunction(() => /Harbour customers/.test(document.querySelector('#buildResult')?.textContent ?? ''), null, { timeout: 30000 }).catch(fail);
        assert.match(await toolbox.textContent('#buildStatus'), /4 towns served/);
        assert.equal(log.filter((line) => line.startsWith('pageerror') || line.startsWith('error')).length, 0, log.join('\n'));

        // 5b. A chokepoint disruption. Port Alder lies on open sea, so it depends on Suez only once its share is set; then
        // three days at a quarter of the usual transits (the drop PortWatch shows) cost it 150 x 75% x 3 TEU.
        await toolbox.waitForFunction(() => !document.querySelector('#stepScenario').hidden && !document.querySelector('#buildButton').disabled, null, { timeout: 30000 }).catch(fail);
        await toolbox.selectOption('#chokepointSelect', 'chokepoint1');
        await toolbox.waitForFunction(() => /10\.0 container ships a day .* against 40\.0 in 2023, its busiest full year: 75% fewer/.test(document.querySelector('#transitSummary').textContent), null, { timeout: 30000 }).catch(fail);
        await toolbox.click('#useDrop');
        assert.equal(await toolbox.inputValue('#cutInput'), '75');
        await toolbox.fill('#startInput', '2');
        await toolbox.fill('#durationInput', '3');
        await toolbox.click('#runScenarioButton');
        await toolbox.waitForFunction(() => /None of the ports depends on Suez Canal/.test(document.querySelector('#scenarioStatus').textContent), null, { timeout: 10000 }).catch(fail);
        const alderShare = toolbox.locator('#dependenceTable tr[data-port="Port Alder"] input');
        assert.equal(await alderShare.inputValue(), '0');
        await alderShare.fill('100');
        await alderShare.dispatchEvent('change');
        await toolbox.click('#runScenarioButton');
        await toolbox.waitForFunction(() => /Kept out \(TEU\)/.test(document.querySelector('#scenarioResult').textContent), null, { timeout: 120000 }).catch(fail);
        const alderRow = () => toolbox.evaluate(() => [...[...document.querySelectorAll('#scenarioResult tr')].find((row) => row.cells[0]?.textContent === 'Port Alder').cells].map((cell) => Number(cell.textContent.replace(/,/g, ''))));
        const [, keptOut, caughtUp, lost] = await alderRow();
        assert.ok(Math.abs(keptOut - 337.5) <= 1 && Math.abs(lost - 337.5) <= 1 && caughtUp === 0, `Port Alder should miss 150 x 75% x 3 = 337.5 TEU, all of it lost (shown ${keptOut}, ${caughtUp}, ${lost}).`);
        // Again with 60% of it delayed, arriving over 5 days after: 202.5 TEU arrive later, and 135 never do.
        await toolbox.fill('#delayedInput', '60');
        await toolbox.fill('#catchUpInput', '5');
        await toolbox.click('#runScenarioButton');
        await toolbox.waitForFunction(() => /60% of the cargo kept out arrives over the 5 days after/.test(document.querySelector('#scenarioResult').textContent), null, { timeout: 120000 }).catch(fail);
        const [, keptOutAgain, caughtUpAgain, lostAgain] = await alderRow();
        assert.ok(Math.abs(keptOutAgain - 337.5) <= 1 && Math.abs(caughtUpAgain - 202.5) <= 1 && Math.abs(lostAgain - 135) <= 1, `60% of 337.5 TEU should arrive later and 135 never (shown ${keptOutAgain}, ${caughtUpAgain}, ${lostAgain}).`);
        assert.match(await toolbox.textContent('#scenarioResult'), /Suez Canal: transits cut by 75% from day 2 for 3 days, reaching Port Alder \(100% of its ships\)/);
        assert.equal(await toolbox.locator('#showScenarioButton').isDisabled(), false);
        // Again with half of it diverted to Birch Harbour, outside the canal, whose berths take 400 TEU a day meanwhile:
        // 168.75 TEU land there instead, and its lanes hire trucks for them.
        await toolbox.fill('#delayedInput', '0');
        await toolbox.fill('#divertedInput', '50');
        await toolbox.dispatchEvent('#divertedInput', 'input');
        assert.equal(await toolbox.locator('#diversionRow').isVisible(), true);
        assert.deepEqual(await toolbox.evaluate(() => [...document.querySelectorAll('#divertToSelect option')].map((option) => option.value)), ['Birch Harbour'], 'only ports outside the chokepoint');
        await toolbox.fill('#divertBerthsInput', '400');
        await toolbox.click('#runScenarioButton');
        await toolbox.waitForFunction(() => /50% of it is diverted to Birch Harbour \(169 TEU\), whose berths take 400 TEU\/day, and trucked inland over \d lanes? with \d+ trucks/.test(document.querySelector('#scenarioResult').textContent), null, { timeout: 120000 }).catch(fail);
        // Birch Harbour shows the cargo it received as diverted here, not as a negative loss.
        const birchRow = await toolbox.evaluate(() => {
            const table = [...document.querySelectorAll('#scenarioResult table')].find((item) => /Kept out/.test(item.textContent));
            const row = [...table.querySelectorAll('tr')].find((item) => item.cells[0]?.textContent === 'Birch Harbour');
            return [...row.cells].map((cell) => Number(cell.textContent.replace(/,/g, '')));
        });
        assert.deepEqual(birchRow.slice(1, 4), [0, 0, 0], 'it kept nothing out');
        assert.ok(Math.abs(birchRow[4] - 168.75) <= 1, `about 169 TEU diverted here (shown ${birchRow[4]})`);
        // The summary says how long orders waited, not only whether they were delivered.
        assert.match(await toolbox.textContent('#scenarioResult'), /Days an order waited/);
        // The map shows what the lanes carried while the cut lasted: Port Alder's less, Birch Harbour's standby lanes more.
        assert.equal(await toolbox.locator('#flowView').isVisible(), true);
        assert.match(await toolbox.textContent('#flowView [data-flows="scenario"]'), /^Scenario, day 2 to 5$/);
        assert.ok(await toolbox.locator('#map .lane.rose').count() > 0, 'the lanes the cargo was diverted to carried more');
        assert.ok(await toolbox.locator('#map .lane.fell, #map .lane.stopped').count() > 0, 'the lanes from the cut port carried less');
        await toolbox.click('#flowView [data-flows="baseline"]');
        assert.equal(await toolbox.locator('#map .lane.rose, #map .lane.fell, #map .lane.stopped').count(), 0, 'the baseline is the model as built');
        await toolbox.click('#flowView [data-flows="scenario"]');
        assert.ok(await toolbox.locator('#map .lane.rose').count() > 0);
        // People buy less while the cut lasts: the same diversion with every town ordering half as much, so less is owed.
        const backlogCost = () => toolbox.evaluate(() => Number([...document.querySelectorAll('#scenarioResult tr')].find((row) => row.cells[0]?.textContent === 'Backlog cost').cells[1].textContent.replace(/,/g, '')));
        const backlogBefore = await backlogCost();
        await toolbox.fill('#demandDuringInput', '-50');
        await toolbox.click('#runScenarioButton');
        await toolbox.waitForFunction(() => /every town's orders fall 50% while it lasts/.test(document.querySelector('#scenarioResult').textContent), null, { timeout: 120000 }).catch(fail);
        const backlogAfter = await backlogCost();
        assert.ok(backlogAfter < backlogBefore, `with half the orders the backlog should cost less (${backlogAfter} against ${backlogBefore})`);
        await toolbox.fill('#demandDuringInput', '0');
        assert.equal(log.filter((line) => line.startsWith('pageerror') || line.startsWith('error')).length, 0, log.join('\n'));

        // 5b'. Two settings changed in quick succession, the second while the first is still building: both reach the model.
        // The weight of a TEU starts a build; the assumed volume a port (Birch Harbour, the one not matched) is changed
        // during it, and must still reach the model.
        await toolbox.fill('#tonnesPerTeuInput', '12'); await toolbox.dispatchEvent('#tonnesPerTeuInput', 'change');
        await toolbox.waitForFunction(() => /Building the model/.test(document.querySelector('#buildStatus').textContent), null, { timeout: 10000 }).catch(() => {});
        await toolbox.click('#kindTabs [data-group="ports"]');
        await toolbox.fill('#portVolume', '80'); await toolbox.dispatchEvent('#portVolume', 'change');
        await toolbox.waitForFunction((volume) => [...document.querySelectorAll('#buildResult details tr')].some((row) => row.cells[0]?.textContent === 'Birch Harbour' && row.cells[1]?.textContent.startsWith(`Containers handed inland: ${volume}`)) && document.querySelector('#buildStatus .notice.ok'), '80', { timeout: 120000 }).catch(fail);
        await toolbox.fill('#tonnesPerTeuInput', '10'); await toolbox.dispatchEvent('#tonnesPerTeuInput', 'change');
        await toolbox.fill('#portVolume', '100'); await toolbox.dispatchEvent('#portVolume', 'change');
        await toolbox.waitForFunction((volume) => [...document.querySelectorAll('#buildResult details tr')].some((row) => row.cells[0]?.textContent === 'Birch Harbour' && row.cells[1]?.textContent.startsWith(`Containers handed inland: ${volume}`)) && document.querySelector('#buildStatus .notice.ok'), '100', { timeout: 120000 }).catch(fail);
        await toolbox.click('#kindTabs [data-group="towns"]');

        // 5c. An invented fleet operator: the model is rebuilt with its trucks, labelled synthetic.
        await toolbox.selectOption('#operatorSelect', 'synthetic');
        await toolbox.waitForFunction(() => /Quayside Haulage \(an invented operator\)/.test(document.querySelector('#buildResult').textContent), null, { timeout: 60000 }).catch(fail);
        assert.match(await toolbox.textContent('#buildResult'), /synthetic: invented and plausible, not a real company/);
        assert.ok(await toolbox.locator('#buildResult .basis.synthetic', { hasText: 'operator' }).count() >= 2, 'its lanes are marked');
        assert.match(await toolbox.textContent('#buildResult details summary'), /\d+ synthetic/);
        assert.ok(!/fall behind/.test(await toolbox.textContent('#buildStatus')), 'it keeps up with its lanes');
        const runTab = async (tab, expected, setUp = async () => {}) => {
            await toolbox.click(`#scenarioTabs [data-scenario="${tab}"]`);
            assert.equal(await toolbox.locator(`.scenarioPanel[data-panel="${tab}"]`).isVisible(), true);
            await setUp();
            await toolbox.click('#runScenarioButton');
            await toolbox.waitForFunction((pattern) => new RegExp(pattern).test(document.querySelector('#scenarioResult').textContent), expected.source, { timeout: 120000 }).catch(fail);
            const result = await toolbox.textContent('#scenarioResult');
            assert.match(result, /Orders delivered/);
            return result;
        };
        // The busiest lane closed for 3 days from day 2, its trucks waiting: the cargo waits at the port, and its
        // warehouse lives on its stock (three days' cover, so its towns are still served).
        await runTab('roadClosure', /closed from day 2 for 3 days: \d+ TEU a day it no longer carries, its orders waiting/);
        const lowest = () => toolbox.evaluate(() => [...document.querySelectorAll('#scenarioResult table')].find((table) => /Lowest stock/.test(table.textContent))
            .querySelectorAll('td.worse').length);
        assert.ok(await lowest() >= 1, 'the closed lane\'s warehouse runs down its stock');
        // On a detour instead, the lane keeps carrying, at a higher cost.
        await runTab('roadClosure', /on a detour from day 2 for 3 days: 4\.0 h and \d+ km more each way/, async () => {
            await toolbox.selectOption('#closureModeSelect', 'detour');
            assert.equal(await toolbox.locator('#closureDetourRow').isVisible(), true);
            await toolbox.fill('#detourHoursInput', '4');
        });
        // The operator's trucks cut by 40%.
        await runTab('fleetChange', /Trucks on the lanes Quayside Haulage \(an invented operator\) carries changed by -40% from day 2 for 3 days: \d+ to \d+\./, async () => {
            assert.equal(await toolbox.inputValue('#fleetLanesSelect'), 'operator');
            await toolbox.fill('#fleetChangeInput', '-40');
        });
        // Demand up by half everywhere.
        const surge = await runTab('demandSurge', /Demand up 50% in every town from day 2 for 3 days: \d+ TEU more ordered\./, () => toolbox.fill('#demandChangeInput', '50'));
        assert.ok(/Highest backlog/.test(surge));
        assert.equal(log.filter((line) => line.startsWith('pageerror') || line.startsWith('error')).length, 0, log.join('\n'));

        // 6. The session is kept with the project: closing and reopening the window carries on where it was.
        const curated = await counts();
        await toolbox.close();
        toolbox = await openToolbox(app, window);
        await toolbox.waitForFunction(() => /Restored the session kept with this project/.test(document.querySelector('#regionStatus').textContent), null, { timeout: 30000 });
        assert.deepEqual(await counts(toolbox), curated);
        assert.equal(await toolbox.evaluate(() => document.querySelector('#kindTabs .active').dataset.group), 'towns', 'it reopens on the list last shown');
        await toolbox.click('#kindTabs [data-group="ports"]');
        assert.equal(await toolbox.locator('#candidateList li', { hasText: 'Port Alder' }).locator('input[type="number"]').inputValue(), '150');
        assert.match(await toolbox.textContent('#buildResult'), /Harbour customers/);
        assert.match(await toolbox.textContent('#scenarioResult'), /Demand up 50% in every town/, 'and the last scenario run');
        assert.equal(await toolbox.evaluate(() => document.querySelector('#scenarioTabs .active').dataset.scenario), 'demandSurge', 'on its tab');
        assert.equal(await toolbox.inputValue('#demandChangeInput'), '50');
        assert.equal(await toolbox.inputValue('#closureModeSelect'), 'detour');
        assert.equal(await toolbox.inputValue('#operatorSelect'), 'synthetic');
        assert.equal(await toolbox.inputValue('#chokepointSelect'), 'chokepoint1');
        // A scenario run straight after the session is restored builds the model again first, then runs.
        await toolbox.fill('#demandChangeInput', '40');
        await toolbox.click('#runScenarioButton');
        await toolbox.waitForFunction(() => /Demand up 40%/.test(document.querySelector('#scenarioResult').textContent) || /notice error/.test(document.querySelector('#scenarioStatus').innerHTML), null, { timeout: 180000 });
        assert.equal((await toolbox.textContent('#scenarioStatus')).trim(), '', 'no "Import your data first" after a restore');

        // 7. Saving the project writes the session into it: the window's state and the map data it was built from.
        const savedPath = join(scratch, 'region.kjt');
        await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, savedPath);
        // A change shown in Konjugate and saved at once: the save waits for the project on its way from the toolbox,
        // so it carries the change.
        await toolbox.fill('#demandChangeInput', '35');
        await toolbox.dispatchEvent('#demandChangeInput', 'change');
        await toolbox.click('#showScenarioButton');
        await window.click('#saveButton');
        // The canvas holds the disruption's results now, so Konjugate asks what to save: the model alone is enough here.
        const asked = await window.waitForFunction(() => document.querySelector('#saveContentDialog').open, null, { timeout: 10000 }).then(() => true, () => false);
        assert.ok(asked, 'Saving a project with the disruption\'s results should ask what to save.');
        await window.check('#saveContentDialog input[value="model"]');
        await window.click('#saveContentContinue');
        await waitForFile(savedPath);
        const saved = JSON.parse(await decodeProjectFile(await readFile(savedPath)));
        const entry = saved.addonData?.['konjugate.logistics.toolbox'];
        assert.ok(entry, 'The project carries the toolbox session.');
        assert.deepEqual([...new Set(entry.inputs.map((input) => input.role))].sort(), ['logistics', 'places', 'ports', 'portwatchActivity', 'portwatchPorts', 'rail', 'roads']);
        assert.ok(entry.inputs.every((input) => /^https:\/\/(overpass-api\.de|services9\.arcgis\.com)\//.test(input.url ?? '') && input.retrievedAt), 'Every input records where and when it was fetched.');
        assert.equal(entry.window.kept.towns.length, 3, 'the three kept towns');
        assert.deepEqual(entry.window.added.map((site) => site.name), ['Harbour customers'], 'and the customer added on the map');
        assert.equal(entry.window.operator, 'synthetic', 'and the invented operator');
        assert.equal(saved.nodes.length, nodes + 1, 'the model with the added customer');
        assert.equal(entry.window.scenarioSettings.demand.change, 35, 'and the change shown in Konjugate just before saving');
        await app.close();
        app = null;

        // 8. Reopening the saved project on a machine with no network restores the session from the project alone.
        const offline = await electron.launch({ executablePath: electronPath, args: [konjugateDir, ...extraArgs, `--user-data-dir=${userData}`, savedPath], env });
        try {
            await offline.evaluate(() => {
                globalThis.logisticsRequests = [];
                globalThis.fetch = async (url) => { globalThis.logisticsRequests.push(String(url)); throw new Error('offline'); };
            });
            const offlineWindow = await offline.firstWindow();
            await offlineWindow.waitForLoadState('domcontentloaded');
            const reopened = await openToolbox(offline, offlineWindow);
            await reopened.waitForFunction(() => /Restored the session kept with this project/.test(document.querySelector('#regionStatus').textContent), null, { timeout: 30000 });
            assert.deepEqual(await counts(reopened), curated);
            assert.match(await reopened.textContent('#buildResult'), /Harbour customers/);
            assert.ok(await reopened.locator('#map .lane').count() > 0, 'The built lanes are drawn again.');
            assert.deepEqual(await offline.evaluate(() => globalThis.logisticsRequests), [], 'Nothing was fetched.');
        } finally {
            await offline.close().catch(() => {});
        }
        console.log(`✓ logistics region window: the sample region and a searched region discover offline; the model (${nodes} nodes, ${edges} relationships) opens in the canvas; dragging Alder Industrial Park moves its lane from ${before} to ${after} km; a customer added on the map is served; a chokepoint's cargo is diverted to Birch Harbour; an invented operator is labelled synthetic; a road closure, a detour, a fleet cut and a demand surge run from their tabs; the session is kept with the project (and a scenario runs straight after it is restored), saved with it, and restored from it with no network.`);
    } finally {
        await app?.close().catch(() => {});
    }
} finally {
    await rm(scratch, { recursive: true, force: true });
}
