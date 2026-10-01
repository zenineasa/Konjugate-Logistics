/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Region import against real OpenStreetMap data, for development: fetches a region from the public
// Overpass API (one query per kind, one at a time), caches the answers in out/regionCache/, and prints
// what discovery found, the coverage report and notices, and the model a default selection builds.
// With --run it also runs that model through the engine CLI and checks that the baseline holds still, or, with
// --arrivals history, that each matched port's arrivals follow its PortWatch history day by day.
//
//   node scripts/liveRegionCheck.mjs --bbox south,west,north,east [--run] [--refresh]
//   node scripts/liveRegionCheck.mjs --place "Jebel Ali" [--pick 2] [--radius 40] [--run]
//   ... [--overpass overpass.private.coffee]   another Overpass server, when the main one is overloaded
//   ... [--arrivals history]   matched ports' arrivals follow their daily PortWatch history (default: steady average)
//   ... [--from 2025-10-01]   the history period: the model's days from that date (default: the latest days)
//   ... [--disrupt chokepoint6:50:10:30]   with --run, also a disruption: that chokepoint's transits cut by 50% from day 10
//       for 30 days, each kept port losing its share through it (from the sea it lies in), against the baseline
//
// A place search lists what it found, places and areas first; --pick chooses another than the first.
//
// Public Overpass and Nominatim servers are shared and fair-use: answers are cached, and --refresh is
// needed to fetch again. Map data © OpenStreetMap contributors, ODbL.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultSelection, discoverRegion } from '../packages/toolbox/lib/discovery.mjs';
import { maximumSplitDepth, overpassHost, overpassRequests, overpassStatusUrl, overpassUrl, retryableStatus, retryDelaysSeconds, retryPauseSeconds, splitRequest, statusWaitSeconds } from '../packages/toolbox/lib/overpass.mjs';
import { nominatimSearchUrl, rankPlaces } from '../packages/toolbox/lib/places.mjs';
import { chokepointById, chokepointRecentUrl, chokepointYearlyUrl, disruptionPath, summariseTransits } from '../packages/toolbox/lib/chokepoints.mjs';
import { portwatchActivityUrl, portwatchPortsUrl } from '../packages/toolbox/lib/portwatch.mjs';
import { buildRegionModel } from '../packages/toolbox/lib/regionModel.mjs';
import { createRouter } from '../packages/toolbox/lib/roadGraph.mjs';
import { konjugateModule, logisticsRoot } from './konjugatePaths.mjs';
import { loadTemplates, ModelBuilder } from './templatePlacement.mjs';

const hostFetchLimit = 5 * 1024 * 1024;
const userAgent = 'konjugate-logistics region check (https://github.com/zenineasa/Konjugate)';
const argument = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 ? process.argv[index + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

async function bboxOf() {
    if (argument('bbox')) {
        const [south, west, north, east] = argument('bbox').split(',').map(Number);
        if (![south, west, north, east].every(Number.isFinite) || south >= north || west >= east) throw new Error('--bbox is south,west,north,east in degrees.');
        return { south, west, north, east };
    }
    const place = argument('place');
    if (!place) throw new Error('Give --bbox south,west,north,east or --place "name".');
    const response = await fetch(nominatimSearchUrl(place), { headers: { 'User-Agent': userAgent } });
    if (!response.ok) throw new Error(`Nominatim answered ${response.status}.`);
    const places = rankPlaces(await response.json());
    if (!places.length) throw new Error(`Nominatim found no place called "${place}".`);
    const pick = Number(argument('pick') ?? 1);
    places.slice(0, 5).forEach((item, index) => console.log(`${index + 1 === pick ? '>' : ' '} ${index + 1}. ${item.display_name} (${item.category ?? item.class}/${item.type})`));
    const found = places[pick - 1];
    if (!found) throw new Error(`There is no match number ${pick}.`);
    const radius = Number(argument('radius') ?? 40);
    const lat = Number(found.lat);
    const lon = Number(found.lon);
    const dLat = radius / 111.32;
    const dLon = radius / (111.32 * Math.cos(lat * Math.PI / 180));
    console.log(`${found.display_name}: ${lat.toFixed(4)}, ${lon.toFixed(4)}; a box ${radius} km each way.`);
    return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

const bbox = await bboxOf();
const key = [bbox.south, bbox.west, bbox.north, bbox.east].map((value) => value.toFixed(3)).join('_');
const cache = join(logisticsRoot, 'out', 'regionCache', key);
await mkdir(cache, { recursive: true });
const answers = {};
const pause = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const host = argument('overpass') ?? overpassHost;
if (host !== overpassHost) console.log(`Using the Overpass server at ${host}.`);
// How long the server says to wait before a slot is free (null when its status page says nothing usable).
async function serverWait() {
    try {
        const response = await fetch(overpassStatusUrl(host), { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(15000) });
        return response.ok ? statusWaitSeconds(await response.text()) : null;
    } catch {
        return null;
    }
}
const queue = overpassRequests(bbox);
while (queue.length) {
    const request = queue.shift();
    const label = request.parts > 1 || request.depth ? `${request.kind} ${request.part}/${request.parts}` : request.kind;
    // Keyed by the query itself, so a changed query is fetched afresh rather than read from an old answer.
    const file = join(cache, `${request.kind}-${request.part}-${createHash('sha256').update(request.query).digest('hex').slice(0, 8)}.json`);
    let text;
    // A tile fetched before as quarters: go straight to the quarters, rather than download it whole again.
    if (existsSync(`${file}.split`) && !flag('refresh')) {
        console.log(`${label}: fetched before as four quarters`);
        queue.unshift(...splitRequest(request));
        continue;
    }
    if (existsSync(file) && !flag('refresh')) {
        text = await readFile(file, 'utf8');
        console.log(`${label}: cached, ${(text.length / 1024).toFixed(0)} KB`);
    } else {
        for (let attempt = 0; ; attempt += 1) {
            const before = await serverWait();
            if (before > 0) {
                console.log(`${label}: the server has no free slot; waiting ${before} s as it asks`);
                await pause(before + 1);
            }
            const started = Date.now();
            let response;
            try {
                response = await fetch(overpassUrl(request.query, host), { headers: { 'User-Agent': userAgent } });
                text = await response.text();
            } catch (error) {
                // A dropped connection is the same as a busy answer: try again after a pause.
                response = { ok: false, status: 503 };
                text = `the connection failed (${error.cause?.code ?? error.message})`;
            }
            if (response.ok) {
                const size = Buffer.byteLength(text);
                // As the add-on does: a tile too large to accept is fetched again as four quarters.
                if (size > hostFetchLimit && request.depth < maximumSplitDepth) {
                    console.log(`${label}: ${(size / 1024).toFixed(0)} KB is over the add-on's ${hostFetchLimit / 1024 / 1024} MB fetch limit; fetching it as four quarters`);
                    queue.unshift(...splitRequest(request));
                    await writeFile(`${file}.split`, '');
                    text = null;
                    break;
                }
                console.log(`${label}: ${(size / 1024).toFixed(0)} KB in ${((Date.now() - started) / 1000).toFixed(1)} s${size > hostFetchLimit ? `  -- OVER the add-on's ${hostFetchLimit / 1024 / 1024} MB fetch limit` : ''}${Date.now() - started > 20000 ? `  -- slower than the add-on\u2019s 20 s fetch limit${request.depth < maximumSplitDepth ? '; the add-on would fetch it as four quarters' : ', and too deep to split again'}` : ''}`);
                await writeFile(file, text);
                break;
            }
            if (!retryableStatus(response.status) || attempt >= retryDelaysSeconds.length) {
                console.error(`\nOverpass answered ${response.status} for ${label}: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`);
                console.error(`The parts fetched so far are cached; run the same command again later to continue from ${label}${host === overpassHost ? ', or add --overpass overpass.private.coffee to use another public server' : ''}.`);
                process.exit(1);
            }
            const seconds = retryPauseSeconds(attempt, await serverWait());
            const overloaded = /Dispatcher_Client|open64/.test(text) ? ', overloaded' : '';
            console.log(`${label}: the server is busy (${response.status}${overloaded}); trying again in ${seconds} s (${attempt + 1} of ${retryDelaysSeconds.length})`);
            await pause(seconds);
        }
        await pause(1);
    }
    if (text !== null) (answers[request.kind] ??= []).push(text);
}

// IMF PortWatch: the ports around the region, then a year of history for each that matches a port found.
// Cached like the map data; --refresh fetches it again (the history is updated weekly).
async function cachedFetch(label, url, file) {
    if (existsSync(file) && !flag('refresh')) {
        const text = await readFile(file, 'utf8');
        console.log(`${label}: cached, ${(text.length / 1024).toFixed(0)} KB`);
        return text;
    }
    const started = Date.now();
    const response = await fetch(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(60000) });
    const text = await response.text();
    if (!response.ok || /^\s*\{\s*"error"/.test(text)) throw new Error(`IMF PortWatch answered ${response.status} for ${label}: ${text.slice(0, 200)}`);
    console.log(`${label}: ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    await writeFile(file, text);
    return text;
}
try {
    answers.portwatchPorts = [await cachedFetch('PortWatch ports', portwatchPortsUrl(bbox), join(cache, 'portwatch-ports.json'))];
    const portids = [...new Set(discoverRegion(answers, { bbox }).candidates.ports.map((port) => port.portwatch?.portid).filter(Boolean))];
    answers.portwatchActivity = [];
    for (const portid of portids) answers.portwatchActivity.push(await cachedFetch(`PortWatch ${portid}`, portwatchActivityUrl(portid), join(cache, `portwatch-${portid}.json`)));
} catch (error) {
    console.log(`Port activity could not be fetched (${error.message}); ports keep assumed volumes.`);
    delete answers.portwatchPorts;
    delete answers.portwatchActivity;
}

const started = Date.now();
const discovered = discoverRegion(answers, { bbox });
console.log(`\nDiscovery took ${((Date.now() - started) / 1000).toFixed(1)} s; the road graph has ${discovered.roadGraph.vertices.size} vertices.`);
console.log('\nCoverage:', JSON.stringify(discovered.coverage, null, 2));
console.log('\nNotices:');
for (const notice of discovered.notices) console.log(`  [${notice.level}] ${notice.text}`);
const show = (title, items, describe) => {
    console.log(`\n${title} (${items.length} found; top 10):`);
    for (const item of items.slice(0, 10)) console.log(`  ${item.name} -- ${describe(item)}`);
};
show('Ports', discovered.candidates.ports, (port) => `${port.areaSquareKilometres} km², ${port.parts} part(s), ${port.commercial ? 'commercial' : 'no commercial tag'}, ${port.anchorages} anchorage(s)${port.portwatch ? `; PortWatch ${port.portwatch.portid} ${port.portwatch.name} at ${port.portwatch.kilometres} km` : ''}${port.activity ? `: ${Math.round(port.activity.importTonnesPerDay).toLocaleString('en')} t/day container imports = ${Math.round(port.activity.teuPerDay).toLocaleString('en')} TEU/day, ${port.activity.containerCallsPerDay.toFixed(1)} container calls/day (${port.activity.from} to ${port.activity.to})` : ''}`);
show('Logistics zones', discovered.candidates.zones, (zone) => `${Math.round(zone.floorAreaSquareMetres / 1000)}k m² floor (${zone.floorAreaBasis}), ${zone.buildings} building(s), ${zone.roadKilometres} km to a major road`);
show('Towns', discovered.candidates.towns, (town) => `${town.population.toLocaleString('en')} (${town.populationBasis})${town.suburbs ? `, ${town.suburbs.length} suburbs` : ''}`);

const routeStarted = Date.now();
const builder = new ModelBuilder(await loadTemplates());
const arrivalsMode = argument('arrivals') ?? 'average';
if (!['average', 'history'].includes(arrivalsMode)) throw new Error('--arrivals is average or history.');
const built = buildRegionModel({ builder, selection: defaultSelection(discovered.candidates), route: createRouter(discovered.roadGraph).route, options: { arrivals: arrivalsMode, ...(argument('from') ? { historyFrom: argument('from') } : {}) } });
for (const history of built.histories) console.log(`  ${history.port}: arrivals follow its history from ${history.from} (model day 0) to ${history.to}`);
console.log(`\nModel: ${built.document.nodes.length} nodes, ${built.document.edges.length} edges, built in ${((Date.now() - routeStarted) / 1000).toFixed(1)} s.`);
for (const item of built.provenance.filter((entry) => entry.parameter === 'Containers handed inland')) console.log(`  ${item.entity} hands inland ${item.value.toFixed(1)} TEU/day (${item.basis}): ${item.detail}`);
for (const lane of built.lanes) console.log(`  ${lane.name}: ${lane.rate.toFixed(1)} TEU/day, ${lane.kilometres} km, ${(lane.leadTime * 24).toFixed(1)} h, ${lane.fleet} trucks (${lane.basis})`);
for (const item of built.served) console.log(`  ${item.town} <- ${item.zone}: ${item.demand.toFixed(1)} TEU/day, ${item.hours.toFixed(1)} h`);
for (const warning of built.warnings) console.log(`  ! ${warning}`);
await writeFile(join(cache, 'model.kjt.json'), JSON.stringify(built.document));

// The chokepoints the kept ports depend on, and how busy each is lately against its busiest full year.
const keptPorts = defaultSelection(discovered.candidates).ports;
const dependedOn = [...new Set(keptPorts.flatMap((port) => Object.keys(port.chokepoints?.shares ?? {})))];
if (keptPorts.length) console.log('\nChokepoints:');
for (const port of keptPorts) console.log(`  ${port.name}: ${port.chokepoints?.sea ? `${port.chokepoints.sea}, ${Object.entries(port.chokepoints.shares).map(([id, share]) => `${Math.round(share * 100)}% through ${chokepointById.get(id).name}`).join(', ')}` : 'open sea, no chokepoint'}`);
for (const id of dependedOn) {
    try {
        const transits = summariseTransits(
            await cachedFetch(`PortWatch ${id} by year`, chokepointYearlyUrl(id), join(cache, `chokepoint-${id}-years.json`)),
            await cachedFetch(`PortWatch ${id} lately`, chokepointRecentUrl(id), join(cache, `chokepoint-${id}-recent.json`)));
        if (transits) console.log(`  ${chokepointById.get(id).name}: ${transits.recent.containerShips.toFixed(1)} container ships a day from ${transits.recent.from} to ${transits.recent.to}, against ${transits.usual.containerShips.toFixed(1)} in ${transits.usual.year}; ${Math.round(transits.drop * 100)}% fewer. By year: ${transits.years.map((year) => `${year.year} ${year.containerShips.toFixed(1)}`).join(', ')}`);
    } catch (error) {
        console.log(`  ${chokepointById.get(id).name}: transits could not be fetched (${error.message})`);
    }
}

if (flag('run')) {
    const { encodeProjectFile } = await import(pathToFileURL(konjugateModule('src/projectFile.mjs')));
    const { decodeResultFile } = await import(pathToFileURL(konjugateModule('src/engineProtocol.mjs')));
    const executable = konjugateModule(join('out', 'engine', process.platform === 'win32' ? 'konjugateEngine.exe' : 'konjugateEngine'));
    const directory = await mkdtemp(join(tmpdir(), 'konjugateRegionCheck-'));
    try {
        const document = builder.document({ days: 10, stepDays: 15 / 1440, outputDays: 1 / 24 });
        await writeFile(join(directory, 'model.kjt'), await encodeProjectFile(JSON.stringify(document)));
        await writeFile(join(directory, 'run.json'), JSON.stringify({ targetTime: 10 * 86400, globalTimeStep: 900, outputInterval: 3600 }));
        const code = await new Promise((resolve, reject) => {
            const child = spawn(executable, ['run', join(directory, 'model.kjt'), '--configuration', join(directory, 'run.json'), '--output', join(directory, 'result.kjr')], { stdio: ['ignore', 'ignore', 'inherit'] });
            child.once('error', reject);
            child.once('exit', resolve);
        });
        if (code !== 0) throw new Error(`The engine exited with ${code}.`);
        const result = decodeResultFile(await readFile(join(directory, 'result.kjr')));
        const first = new Map(result.samples[0].states.map((state) => [state.stateId, state.value]));
        const cumulative = new Set(document.nodes.flatMap((node) => node.states.filter((state) => /^(arrived|handled|delivered|ordered|transportCost|holdingCost|backlogCost)$/.test(state.symbol)).map((state) => state.id)));
        let worst = 0;
        for (const state of result.samples.at(-1).states) {
            if (cumulative.has(state.stateId)) continue;
            worst = Math.max(worst, Math.abs(state.value - first.get(state.stateId)) / Math.max(1, Math.abs(first.get(state.stateId))));
        }
        if (!built.histories.length) {
            console.log(`\nEngine: 10 days in 15-minute steps; the largest relative drift of any stock is ${worst.toExponential(2)} ${worst < 1e-6 ? '(holds still)' : '(NOT steady)'}.`);
        } else {
            // Each port whose arrivals follow its history: what arrived over the 10 days against the schedule's 10 days.
            const last = new Map(result.samples.at(-1).states.map((state) => [state.stateId, state.value]));
            for (const history of built.histories) {
                const node = document.nodes.find((item) => item.name === history.port);
                const indexed = built.parameterIndex.findLast((entry) => entry.entity === history.port && entry.key === 'vesselArrivals');
                const samples = document.sharedParameters.find((item) => item.id === indexed.sharedParameterId).schedule.samples;
                const expected = samples.filter(([time]) => time < 10 * 86400).reduce((total, [, value]) => total + value, 0);
                const arrived = last.get(node.states.find((state) => state.symbol === 'arrived').id);
                const queue = result.samples.map((sample) => sample.states.find((state) => state.stateId === node.states.find((item) => item.symbol === 'queue').id).value);
                console.log(`\nEngine: ${history.port} received ${arrived.toFixed(1)} TEU over 10 days, against ${expected.toFixed(1)} in its history ${Math.abs(arrived - expected) < 1e-6 * expected ? '(follows it)' : '(DOES NOT follow it)'}; its anchorage queue ranged ${Math.min(...queue).toFixed(0)} to ${Math.max(...queue).toFixed(0)} TEU.`);
            }
        }

        // A disruption, run here as the window's fork would follow it: each dependent port's arrivals from the day it
        // starts are its own arrivals scaled by its share through the chokepoint times the cut.
        if (argument('disrupt')) {
            const [id, cutPercent, startDay, days] = argument('disrupt').split(':');
            if (!chokepointById.has(id) || ![cutPercent, startDay, days].every((value) => Number.isFinite(Number(value)))) throw new Error('--disrupt is chokepointN:cutPercent:startDay:days.');
            const runDays = Math.min(built.days, Number(startDay) + Number(days) + 30);
            const runFor = async (name, document) => {
                await writeFile(join(directory, `${name}.kjt`), await encodeProjectFile(JSON.stringify(document)));
                await writeFile(join(directory, `${name}.json`), JSON.stringify({ targetTime: runDays * 86400, globalTimeStep: 900, outputInterval: 3600 }));
                const exit = await new Promise((resolve, reject) => {
                    const child = spawn(executable, ['run', join(directory, `${name}.kjt`), '--configuration', join(directory, `${name}.json`), '--output', join(directory, `${name}.kjr`)], { stdio: ['ignore', 'ignore', 'inherit'] });
                    child.once('error', reject);
                    child.once('exit', resolve);
                });
                if (exit !== 0) throw new Error(`The engine exited with ${exit} for the ${name} run.`);
                const decoded = decodeResultFile(await readFile(join(directory, `${name}.kjr`)));
                return (node, symbol) => {
                    const stateId = document.nodes.find((item) => item.name === node).states.find((state) => state.symbol === symbol).id;
                    return decoded.samples.map((sample) => [sample.time / 86400, sample.states.find((state) => state.stateId === stateId).value]);
                };
            };
            const baselineDocument = builder.document({ days: runDays, stepDays: 15 / 1440, outputDays: 1 / 24 });
            const disrupted = structuredClone(baselineDocument);
            const affected = [];
            for (const port of keptPorts) {
                const share = port.chokepoints?.shares?.[id] ?? 0;
                if (!(share > 0)) continue;
                const builtPort = built.ports.find((item) => item.name === port.name);
                const indexed = built.parameterIndex.findLast((entry) => entry.entity === port.name && entry.key === 'vesselArrivals');
                const shared = disrupted.sharedParameters.find((item) => item.id === indexed.sharedParameterId);
                shared.schedule = { interpolation: 'linear', samples: disruptionPath({ base: builtPort.schedule ?? builtPort.arrivals, dependence: share, cut: Number(cutPercent) / 100, start: Number(startDay) * 86400, duration: Number(days) * 86400, forkAt: 0, runTime: runDays * 86400 }) };
                affected.push(`${port.name} (${Math.round(share * 100)}%)`);
            }
            const already = built.ports.filter((port) => affected.some((item) => item.startsWith(`${port.name} (`)) && port.usual > 0 && port.arrivals < 0.5 * port.usual);
            for (const port of already) console.log(`\n! ${port.name} is modelled at ${port.arrivals.toFixed(0)} TEU a day, against about ${port.usual.toFixed(0)} before its history changed: this period may already be the disruption, and cutting it again counts it twice. Try --from a date before the break.`);
            if (!affected.length) {
                console.log(`\nDisruption: no kept port depends on ${chokepointById.get(id).name}.`);
            } else {
                const [before, after] = [await runFor('baseline', baselineDocument), await runFor('disrupted', disrupted)];
                console.log(`\nDisruption: ${chokepointById.get(id).name} cut by ${cutPercent}% from day ${startDay} for ${days} days, reaching ${affected.join(', ')}; ${runDays} days run.`);
                const lowest = (series) => series.reduce((best, point) => (point[1] < best[1] ? point : best));
                const highest = (series) => series.reduce((best, point) => (point[1] > best[1] ? point : best));
                for (const port of built.ports) console.log(`  ${port.name}: ${(before(port.name, 'arrived').at(-1)[1] - after(port.name, 'arrived').at(-1)[1]).toFixed(0)} TEU did not arrive`);
                for (const zone of [...new Set(built.lanes.map((lane) => lane.to))]) {
                    const [day, low] = lowest(after(zone, 'stock'));
                    console.log(`  ${zone}: stock fell to ${low.toFixed(0)} TEU on day ${day.toFixed(1)} (baseline lowest ${lowest(before(zone, 'stock'))[1].toFixed(0)})`);
                }
                for (const town of [...new Set(built.served.map((item) => item.town))]) {
                    const [day, peak] = highest(after(town, 'backlog'));
                    console.log(`  ${town}: backlog peaked at ${peak.toFixed(0)} TEU on day ${day.toFixed(1)} (baseline highest ${highest(before(town, 'backlog'))[1].toFixed(0)})`);
                }
            }
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
