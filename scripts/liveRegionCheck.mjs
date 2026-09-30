/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Region import against real OpenStreetMap data, for development: fetches a region from the public
// Overpass API (one query per kind, one at a time), caches the answers in out/regionCache/, and prints
// what discovery found, the coverage report and notices, and the model a default selection builds.
// With --run it also runs that model through the engine CLI and checks that the baseline holds still.
//
//   node scripts/liveRegionCheck.mjs --bbox south,west,north,east [--run] [--refresh]
//   node scripts/liveRegionCheck.mjs --place "Jebel Ali" [--radius 40] [--run]
//
// Public Overpass and Nominatim servers are shared and fair-use: answers are cached, and --refresh is
// needed to fetch again. Map data © OpenStreetMap contributors, ODbL.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultSelection, discoverRegion } from '../packages/toolbox/lib/discovery.mjs';
import { overpassQueries, overpassUrl } from '../packages/toolbox/lib/overpass.mjs';
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
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(place)}`, { headers: { 'User-Agent': userAgent } });
    if (!response.ok) throw new Error(`Nominatim answered ${response.status}.`);
    const [found] = await response.json();
    if (!found) throw new Error(`Nominatim found no place called "${place}".`);
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
for (const [kind, query] of Object.entries(overpassQueries(bbox))) {
    const file = join(cache, `${kind}.json`);
    if (existsSync(file) && !flag('refresh')) {
        answers[kind] = await readFile(file, 'utf8');
        console.log(`${kind}: cached, ${(answers[kind].length / 1024).toFixed(0)} KB`);
        continue;
    }
    const started = Date.now();
    const response = await fetch(overpassUrl(query), { headers: { 'User-Agent': userAgent } });
    const text = await response.text();
    if (!response.ok) throw new Error(`Overpass answered ${response.status} for ${kind}: ${text.slice(0, 300)}`);
    await writeFile(file, text);
    answers[kind] = text;
    const size = Buffer.byteLength(text);
    console.log(`${kind}: ${(size / 1024).toFixed(0)} KB in ${((Date.now() - started) / 1000).toFixed(1)} s${size > hostFetchLimit ? `  -- OVER the add-on's ${hostFetchLimit / 1024 / 1024} MB fetch limit` : ''}`);
}

const started = Date.now();
const discovered = discoverRegion(answers);
console.log(`\nDiscovery took ${((Date.now() - started) / 1000).toFixed(1)} s; the road graph has ${discovered.roadGraph.vertices.size} vertices.`);
console.log('\nCoverage:', JSON.stringify(discovered.coverage, null, 2));
console.log('\nNotices:');
for (const notice of discovered.notices) console.log(`  [${notice.level}] ${notice.text}`);
const show = (title, items, describe) => {
    console.log(`\n${title} (${items.length} found; top 10):`);
    for (const item of items.slice(0, 10)) console.log(`  ${item.name} -- ${describe(item)}`);
};
show('Ports', discovered.candidates.ports, (port) => `${port.areaSquareKilometres} km², ${port.parts} part(s), ${port.commercial ? 'commercial' : 'no commercial tag'}, ${port.anchorages} anchorage(s)`);
show('Logistics zones', discovered.candidates.zones, (zone) => `${Math.round(zone.floorAreaSquareMetres / 1000)}k m² floor (${zone.floorAreaBasis}), ${zone.buildings} building(s), ${zone.roadKilometres} km to a major road`);
show('Towns', discovered.candidates.towns, (town) => `${town.population.toLocaleString('en')} (${town.populationBasis})`);

const routeStarted = Date.now();
const builder = new ModelBuilder(await loadTemplates());
const built = buildRegionModel({ builder, selection: defaultSelection(discovered.candidates), route: createRouter(discovered.roadGraph).route });
console.log(`\nModel: ${built.document.nodes.length} nodes, ${built.document.edges.length} edges, built in ${((Date.now() - routeStarted) / 1000).toFixed(1)} s.`);
for (const lane of built.lanes) console.log(`  ${lane.name}: ${lane.rate.toFixed(1)} TEU/day, ${lane.kilometres} km, ${(lane.leadTime * 24).toFixed(1)} h, ${lane.fleet} trucks (${lane.basis})`);
for (const item of built.served) console.log(`  ${item.town} <- ${item.zone}: ${item.demand.toFixed(1)} TEU/day, ${item.hours.toFixed(1)} h`);
for (const warning of built.warnings) console.log(`  ! ${warning}`);
await writeFile(join(cache, 'model.kjt.json'), JSON.stringify(built.document));

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
        console.log(`\nEngine: 10 days in 15-minute steps; the largest relative drift of any stock is ${worst.toExponential(2)} ${worst < 1e-6 ? '(holds still)' : '(NOT steady)'}.`);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
