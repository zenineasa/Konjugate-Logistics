/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The region importer as the host runs it: the files the window fetched (here the synthetic region, which
// is also the package's sample), Konjugate's equation helpers, and a reader for the package's own JSON.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import importRegion, { osmRoles, portwatchRoles, templateIds } from '../../packages/toolbox/importers/region.mjs';
import { logisticsRoot } from '../../scripts/konjugatePaths.mjs';
import { equationHelpers } from '../../scripts/templatePlacement.mjs';
import { syntheticBbox, syntheticPortwatch, syntheticRegion } from '../fixtures/syntheticRegion.mjs';

const plugin = JSON.parse(await readFile(join(logisticsRoot, 'packages', 'engine', 'plugin.json'), 'utf8'));
const addon = JSON.parse(await readFile(join(logisticsRoot, 'packages', 'toolbox', 'addon.json'), 'utf8'));
// The build copies each component into the add-on as templates/<id>.json.
const helpers = {
    reconcileEquationBindings: equationHelpers.reconcileEquationBindings,
    validateEquationLatex: equationHelpers.validateEquationLatex,
    async readPackageJson(relativePath) {
        // The bundled Natural Earth tiles are files of the toolbox package itself.
        if (/^geography\/[\w.]+\.json$/.test(relativePath)) return JSON.parse(await readFile(join(logisticsRoot, 'packages', 'toolbox', relativePath), 'utf8'));
        const id = relativePath.match(/^templates\/(\w+)\.json$/)?.[1];
        const contribution = plugin.contributes.find((entry) => entry.kind === 'component' && entry.componentId === id);
        if (!contribution) throw new Error(`No ${relativePath} in the package.`);
        return JSON.parse(await readFile(join(logisticsRoot, 'packages', 'engine', contribution.entry), 'utf8'));
    }
};
const regionFiles = (region = syntheticRegion()) => Object.entries(region).map(([role, answer]) => ({ role, name: `${role}.json`, text: JSON.stringify(answer), encoding: 'utf-8' }));
const sizeOf = (value) => Buffer.byteLength(JSON.stringify(value));

test('the manifest declares a file role for every kind the importer reads, and every template it builds from', () => {
    const importer = addon.contributes.importers.find((entry) => entry.importerId === 'region');
    assert.deepEqual(importer.files.map((file) => file.role), [...osmRoles, ...portwatchRoles, 'extract', 'sites', 'times', 'operator']);
    const components = plugin.contributes.filter((entry) => entry.kind === 'component').map((entry) => entry.componentId);
    for (const id of templateIds) assert.ok(components.includes(id), `${id} is a component`);
    assert.deepEqual(addon.network.hosts.sort(), ['nominatim.openstreetmap.org', 'overpass-api.de', 'services9.arcgis.com']);
    // Pages it may open in the browser, for the user to read a travel time off: only the two maps.
    assert.ok(addon.permissions.includes('links.open') && addon.requires.includes('openLink'));
    // A Konjugate whose engine drops a scenario's changes on some models is refused, not run.
    assert.ok(addon.requires.includes('scenarioEveryBackend'));
    // Roads are read from an extract as a binary file, which a Konjugate without that feature would not hand over.
    assert.ok(addon.requires.includes('binaryInputs') && addon.contributes.importers[0].files.find((file) => file.role === 'extract').binary === true);
    assert.deepEqual(addon.links.hosts.sort(), ['www.google.com', 'www.openstreetmap.org']);
    // The scenarios: each follows paths the window supplies, per parameter, forked when the window says.
    assert.ok(addon.permissions.includes('scenario.run'));
    for (const feature of ['scenarioForkTime', 'parameterSchedules', 'suppliedPerParameter']) assert.ok(addon.requires.includes(feature), feature);
    assert.deepEqual(addon.contributes.scenarios.map((scenario) => [scenario.scenarioId, scenario.interventions.map((item) => item.parameter)]), [
        ['chokepointDisruption', ['vesselArrivals', 'orderShare', 'baseDemand']], ['chokepointDiversion', ['vesselArrivals', 'orderShare', 'fleetSize', 'berthCapacity', 'outageCapacity', 'baseDemand']], ['roadClosure', ['laneOpen', 'orderShare', 'leadTime', 'distance', 'fleetSize']], ['fleetChange', ['fleetSize', 'fleetSize2']], ['demandSurge', ['baseDemand']],
        ['supplierTrouble', ['supplierCapacity', 'supplierLeadTime', 'orderShare', 'fleetSize']],
        ['siteDown', ['laneOpen', 'orderShare', 'share', 'fleetSize']]
    ]);
    for (const scenario of addon.contributes.scenarios) {
        assert.equal(scenario.runTime, 90 * 86400);
        assert.ok(scenario.interventions.every((item) => item.target === 'supplied' && item.samples === true));
    }
});

test('discovery returns candidates, coverage, notices and a small map, and no model', async () => {
    const result = await importRegion({ files: regionFiles(), helpers, options: { bbox: syntheticBbox } });
    assert.equal(result.ok, true);
    assert.equal(result.document, undefined);
    const { data } = result;
    assert.equal(data.step, 'discover');
    assert.deepEqual(data.candidates.ports.map((port) => port.name), ['Port Alder', 'Birch Harbour']);
    assert.equal(data.coverage.warehouses.level, 'good');
    assert.ok(data.notices.length > 0);
    assert.deepEqual(data.map.bbox, syntheticBbox);
    assert.ok(data.map.roads.length >= 7 && data.map.industrial.length === 4 && data.map.ports.length === 3 && data.map.anchorages.length === 1);
    assert.ok(data.map.roads.every((road) => road.points.every(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon))));
    assert.ok(sizeOf(data) < 8 * 1024 * 1024, 'within what a window may receive');
});

test('building from the curated selection returns a model, with the user\'s changes and added sites', async () => {
    const discovered = (await importRegion({ files: regionFiles(), helpers })).data.candidates;
    const selection = {
        ports: [{ id: discovered.ports[0].id, teuPerDay: 150 }, { id: discovered.ports[1].id }],
        zones: [{ id: discovered.zones[0].id, name: 'Alder Park' }, { id: 'added:1', name: 'Hilltop depot', lat: -29.8, lon: -19.6 }],
        towns: discovered.towns.map((town) => ({ id: town.id }))
    };
    const result = await importRegion({ files: regionFiles(), helpers, options: { step: 'build', selection } });
    assert.equal(result.ok, true, JSON.stringify(result.report));
    const { data, document, parameterIndex } = result;
    assert.equal(data.step, 'build');
    assert.equal(document.nodes.length, data.nodes);
    assert.ok(document.nodes.some((node) => node.name === 'Alder Park'), 'a renamed zone keeps its new name');
    assert.ok(data.lanes.some((lane) => lane.to === 'Hilltop depot') || data.unusedZones.includes('Hilltop depot'), 'an added site takes part');
    assert.equal(data.provenance.find((entry) => entry.entity === 'Port Alder' && entry.parameter === 'Containers handed inland').value, 150);
    assert.ok(parameterIndex.every((entry) => Number.isSafeInteger(entry.sharedParameterId) && entry.name && entry.entity));
    assert.ok(parameterIndex.some((entry) => entry.key === 'fleetSize'));
    assert.match(result.report.summary, /^2 ports, \d+ road lanes?, 3 towns served$/);
});

test('moving a kept site in the window moves its lanes', async () => {
    const { candidates } = (await importRegion({ files: regionFiles(), helpers })).data;
    const selectionWith = (zone) => ({ ports: candidates.ports.map(({ id }) => ({ id })), zones: [zone, { id: candidates.zones[1].id }], towns: candidates.towns.map(({ id }) => ({ id })) });
    const park = candidates.zones[0];
    const before = await importRegion({ files: regionFiles(), helpers, options: { step: 'build', selection: selectionWith({ id: park.id }) } });
    const after = await importRegion({ files: regionFiles(), helpers, options: { step: 'build', selection: selectionWith({ id: park.id, lat: park.lat + 0.01 }) } });
    const lane = (result) => result.data.lanes.find((item) => item.to === park.name && item.from === 'Port Alder');
    assert.ok(lane(before) && lane(after));
    assert.notEqual(lane(after).kilometres, lane(before).kilometres);
});

test('the importer says plainly what is missing or wrong', async () => {
    assert.match((await importRegion({ files: [], helpers })).report.errors[0], /Fetch a region/);
    const broken = regionFiles().map((file) => (file.role === 'roads' ? { ...file, text: JSON.stringify({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 91 seconds.' }) } : file));
    assert.match((await importRegion({ files: broken, helpers })).report.errors[0], /^The roads data could not be read: OpenStreetMap's server stopped before it finished .* Choose a smaller area/);
    const badSites = [...regionFiles(), { role: 'sites', name: 'sites.csv', text: 'name,kind,latitude,longitude\nDepot,warehouse,95,1\n' }];
    assert.match((await importRegion({ files: badSites, helpers })).report.errors[0], /^Your sites file: Line 2: Depot needs a latitude/);
    const { candidates } = (await importRegion({ files: regionFiles(), helpers })).data;
    const noTowns = await importRegion({ files: regionFiles(), helpers, options: { step: 'build', selection: { ports: [{ id: candidates.ports[0].id }], zones: [{ id: candidates.zones[0].id }], towns: [] } } });
    assert.equal(noTowns.ok, false);
    assert.match(noTowns.report.errors[0], /at least one town/);
    const gone = await importRegion({ files: regionFiles(), helpers, options: { step: 'build', selection: { ports: [{ id: 'port:way/1' }], zones: [], towns: [] } } });
    assert.match(gone.report.errors[0], /no longer in the data/);
});

test('a CSV of the user\'s own sites alone is enough to discover, and its sites can be built from', async () => {
    const csv = 'name,kind,latitude,longitude,teuPerDay\nQuay,port,-29.99,-19.9,80\nDepot,warehouse,-29.9,-19.8,\nTown,customer,-29.8,-19.7,\n';
    const discovered = await importRegion({ files: [{ role: 'sites', name: 'sites.csv', text: csv }], helpers });
    assert.equal(discovered.ok, true);
    const { sites } = discovered.data;
    assert.equal(sites.ports[0].name, 'Quay');
    const selection = { ports: sites.ports.map(({ id }) => ({ id })), zones: sites.zones.map(({ id }) => ({ id })), towns: sites.towns.map(({ id }) => ({ id })) };
    const built = await importRegion({ files: [{ role: 'sites', name: 'sites.csv', text: csv }], helpers, options: { step: 'build', selection } });
    assert.equal(built.ok, true, JSON.stringify(built.report));
    assert.equal(built.data.lanes[0].basis, 'straight-line', 'with no roads fetched, travel times are straight-line estimates');
    assert.equal(built.data.served[0].demand, 80);
});

test('the window’s history period and conversion reach the model, and values out of range are ignored', async () => {
    const pw = syntheticPortwatch();
    const files = [...regionFiles(), ...Object.entries(pw).map(([role, answer]) => ({ role, name: `${role}.json`, text: JSON.stringify(answer), encoding: 'utf-8' }))];
    const discovered = (await importRegion({ files, helpers, options: { bbox: syntheticBbox } })).data.candidates;
    const selection = { ports: discovered.ports.map((port) => ({ id: port.id })), zones: discovered.zones.slice(0, 2).map((zone) => ({ id: zone.id })), towns: discovered.towns.map((town) => ({ id: town.id })) };
    const volume = async (settings) => {
        const result = await importRegion({ files, helpers, options: { step: 'build', bbox: syntheticBbox, selection, settings } });
        assert.equal(result.ok, true, JSON.stringify(result.report));
        return result.data.provenance.find((item) => item.entity === 'Port Alder' && item.parameter === 'Containers handed inland').value;
    };
    const usual = await volume({});
    assert.ok(Math.abs(await volume({ tonnesPerTeu: 20, inlandShare: 0.5 }) - usual / 4) < 1e-9);
    assert.equal(await volume({ tonnesPerTeu: 0, inlandShare: 2, historyFrom: 'last week' }), usual, 'out of range or malformed: the defaults');
    const replayed = await importRegion({ files, helpers, options: { step: 'build', bbox: syntheticBbox, selection, settings: { arrivals: 'history', historyFrom: '2026-09-14' } } });
    assert.deepEqual(replayed.data.histories, [{ port: 'Port Alder', from: '2026-09-14', to: '2026-09-27', days: 14 }]);
});

test('every lane and town has its own live parameters for the scenarios, however the symbols are numbered', async () => {
    const discovered = (await importRegion({ files: regionFiles(), helpers })).data.candidates;
    const selection = { ports: discovered.ports.map((port) => ({ id: port.id })), zones: discovered.zones.map((zone) => ({ id: zone.id })), towns: discovered.towns.map((town) => ({ id: town.id })) };
    const result = await importRegion({ files: regionFiles(), helpers, options: { step: 'build', selection } });
    assert.ok(result.data.lanes.length >= 2, 'more than one lane, so symbols such as fleetSize2 are numbered');
    const scenarioKeys = addon.contributes.scenarios.flatMap((scenario) => scenario.interventions.map((item) => item.parameter));
    const portNames = result.data.ports.map((port) => port.name);
    // A supplier's are its own (this region has ports alone, so none).
    const supplierNames = result.data.ports.filter((port) => port.supplier).map((port) => port.name);
    const entitiesOf = { vesselArrivals: portNames, berthCapacity: portNames, outageCapacity: portNames, baseDemand: result.data.towns.map((town) => town.name), supplierCapacity: supplierNames, supplierLeadTime: supplierNames, share: result.data.deliveries.map((delivery) => delivery.name) };
    for (const key of new Set(scenarioKeys)) {
        for (const entity of entitiesOf[key] ?? result.data.lanes.map((lane) => lane.name)) {
            const entries = result.parameterIndex.filter((entry) => entry.key === key && entry.entity === entity);
            assert.equal(entries.length, 1, `${key} of ${entity} is indexed once`);
            assert.ok(entries[0].live, `${key} of ${entity} is live`);
            const shared = result.document.sharedParameters.find((item) => item.id === entries[0].sharedParameterId);
            assert.equal(shared.mode, 'live');
            assert.ok(shared.control.minimum <= shared.value && shared.value <= shared.control.maximum);
        }
    }
    // No two entries share a parameter: each lane's second size is its own, not another lane's first.
    const ids = result.parameterIndex.map((entry) => entry.sharedParameterId);
    assert.equal(new Set(ids).size, ids.length);
    for (const lane of result.data.lanes) {
        const value = (key) => result.document.sharedParameters.find((item) => item.id === result.parameterIndex.find((entry) => entry.key === key && entry.entity === lane.name).sharedParameterId).value;
        assert.deepEqual([value('fleetSize'), value('fleetSize2'), value('laneOpen')], [lane.fleet, lane.fleet2, 1], lane.name);
    }
});

test('the window can ask for an invented operator, or read the user\'s own from a file', async () => {
    const discovered = (await importRegion({ files: regionFiles(), helpers })).data.candidates;
    const selection = { ports: discovered.ports.map((port) => ({ id: port.id })), zones: discovered.zones.map((zone) => ({ id: zone.id })), towns: discovered.towns.map((town) => ({ id: town.id })) };
    const build = (settings, extra = []) => importRegion({ files: [...regionFiles(), ...extra], helpers, options: { step: 'build', selection, settings } });
    const invented = await build({ operator: 'synthetic' });
    assert.equal(invented.ok, true, JSON.stringify(invented.report));
    assert.equal(invented.data.operator.synthetic, true);
    assert.ok(invented.data.lanes.some((lane) => lane.operator) && invented.data.operator.lanes.length >= 2);
    assert.ok(invented.data.provenance.some((entry) => entry.basis === 'synthetic'));
    assert.ok(!invented.data.warnings.some((text) => /fall behind/.test(text)), 'an invented operator keeps up with its lanes');
    // Every input says where it comes from: sourced (or routed over sourced roads), assumed, synthetic or yours, and
    // the model-wide constants are listed too.
    assert.ok(invented.data.provenance.every((entry) => ['sourced', 'routed', 'assumed', 'synthetic', 'user'].includes(entry.basis)), [...new Set(invented.data.provenance.map((entry) => entry.basis))].join(', '));
    const modelWide = invented.document.sharedParameters.filter((shared) => !invented.parameterIndex.some((entry) => entry.sharedParameterId === shared.id) && shared.symbol !== 'secondsPerDay');
    assert.ok(modelWide.length > 10);
    for (const shared of modelWide) assert.ok(invented.data.provenance.some((entry) => (entry.entity === 'Every component' || entry.entity === invented.data.operator.name) && entry.value === shared.value), `${shared.name} is labelled`);
    // Asked for the user's own without a file.
    assert.match((await build({ operator: 'file' })).report.errors[0], /Choose a file of your fleet operator/);
    const lane = invented.data.lanes.find((item) => item.operator);
    const own = {
        name: 'Our trucks', trucks: [{ id: 'big', label: '40 ft', teu: 2, costPerKm: 2, costPerDay: 300 }],
        depots: [{ name: 'Yard', lat: discovered.ports[0].lat, lon: discovered.ports[0].lon, trucks: { big: 100 } }],
        contracts: [{ from: lane.from, to: lane.to }, { from: 'Nowhere', to: 'Else' }]
    };
    const file = (value) => [{ role: 'operator', name: 'operator.json', text: JSON.stringify(value), encoding: 'utf-8' }];
    const yours = await build({ operator: 'file' }, file(own));
    assert.equal(yours.ok, true, JSON.stringify(yours.report));
    assert.equal(yours.data.operator.synthetic, false);
    assert.equal(yours.data.lanes.find((item) => item.name === lane.name).fleet, 100);
    assert.equal(yours.data.provenance.find((entry) => entry.entity === lane.name && entry.parameter === 'Fleet').basis, 'user');
    assert.ok(yours.data.warnings.some((text) => /Nowhere → Else match/.test(text)), 'a contract with no lane is reported');
    // A saved invented operator stays labelled invented; a broken file is refused plainly.
    assert.equal((await build({ operator: 'file' }, file({ ...own, synthetic: true }))).data.operator.synthetic, true);
    assert.match((await build({ operator: 'file' }, file({ ...own, depots: [] }))).report.errors[0], /^Your fleet operator file: The operator: it needs at least one depot/);
});

test('every value a scenario supplies, at the window\'s limits, fits its parameter\'s range, so the host never holds it back', async () => {
    const { diversionPlan } = await import('../../packages/toolbox/lib/scenarios.mjs');
    const discovered = (await importRegion({ files: regionFiles(), helpers })).data.candidates;
    const selection = { ports: discovered.ports.map((port) => ({ id: port.id })), zones: discovered.zones.map((zone) => ({ id: zone.id })), towns: discovered.towns.map((town) => ({ id: town.id })) };
    const result = await importRegion({ files: regionFiles(), helpers, options: { step: 'build', selection } });
    const [big, small] = [...result.data.ports].sort((a, b) => b.arrivals - a.arrivals);
    // The busiest port's ships all cut, and all of its cargo diverted to the smallest: the most a diversion can supply.
    const plan = diversionPlan({ lanes: result.data.lanes, ports: result.data.ports, affected: [{ port: big.name, share: 1 }], to: small.name, cut: 1, diverted: 1, berths: big.arrivals + small.arrivals,
        start: 0, duration: 10 * 86400, forkAt: 0, runTime: 30 * 86400, ...result.data.trucking });
    const { closurePlan, fleetPlan, demandPlan } = await import('../../packages/toolbox/lib/scenarios.mjs');
    const window = { start: 0, duration: 10 * 86400, forkAt: 0, runTime: 30 * 86400 };
    // And the other scenarios at the window's own limits: the longest detour, the most trucks, the biggest surge.
    const plans = [plan,
        ...result.data.lanes.map((lane) => closurePlan({ lanes: result.data.lanes, closed: lane.name, mode: 'detour', detourHours: 72, ...window })),
        ...result.data.lanes.map((lane) => closurePlan({ lanes: result.data.lanes, closed: lane.name, mode: 'otherPorts', ...window })),
        fleetPlan({ lanes: result.data.lanes, change: 2, ...window }),
        demandPlan({ towns: result.data.towns, change: 3, ...window })];
    for (const { supplied } of plans) {
        for (const [key, { entities, samples }] of Object.entries(supplied)) {
            for (const entity of entities) {
                const entry = result.parameterIndex.find((item) => item.key === key && item.entity === entity);
                for (const [, value] of samples[entity]) assert.ok(value >= entry.minimum && value <= entry.maximum, `${key} of ${entity}: ${value} lies outside ${entry.minimum} to ${entry.maximum}`);
            }
        }
    }
});

test('a fetched region gets land, coast and borders around it from the bundled Natural Earth tiles; the sample region none', async () => {
    // The synthetic answers with the box of Dubai and 25 km around it: the geography depends only on the box.
    const dubai = { south: 24.3985, west: 54.4675, north: 25.7496, east: 56.4532 };
    const fetched = await importRegion({ files: regionFiles(), helpers, options: { bbox: dubai } });
    const { geography, attribution } = fetched.data.map;
    assert.ok(geography.land.length > 0 && geography.coast.length > 0, 'land and coast');
    assert.ok(geography.borders.some((border) => border.settled), 'the UAE and Oman border, settled');
    assert.match(attribution, /Coast and borders: Natural Earth$/);
    // Land is cut to the region and a margin of half its span; lines keep one point beyond that, so they meet across tiles.
    const within = (margin) => (point) => point[0] > dubai.south - margin && point[0] < dubai.north + margin && point[1] > dubai.west - margin && point[1] < dubai.east + margin;
    assert.ok(geography.land.flat().every(within(1.01)), 'land cut to the region and its margin');
    assert.ok([...geography.coast.flat(), ...geography.borders.flatMap((border) => border.points)].every(within(2)), 'lines near it');
    const sample = await importRegion({ files: regionFiles(), helpers, options: {} });
    assert.equal(sample.data.map.geography, undefined, 'the made-up sample region has no place on Earth');
    assert.doesNotMatch(sample.data.map.attribution, /Natural Earth/);
});
