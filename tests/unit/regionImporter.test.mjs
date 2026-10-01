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
    assert.deepEqual(importer.files.map((file) => file.role), [...osmRoles, ...portwatchRoles, 'sites']);
    const components = plugin.contributes.filter((entry) => entry.kind === 'component').map((entry) => entry.componentId);
    for (const id of templateIds) assert.ok(components.includes(id), `${id} is a component`);
    assert.deepEqual(addon.network.hosts.sort(), ['nominatim.openstreetmap.org', 'overpass-api.de', 'services9.arcgis.com']);
    // The chokepoint disruption: a scenario that follows a path the window supplies for each port's arrivals, forked when the window says.
    assert.ok(addon.permissions.includes('scenario.run'));
    assert.ok(addon.requires.includes('scenarioForkTime') && addon.requires.includes('parameterSchedules'));
    const [scenario] = addon.contributes.scenarios;
    assert.equal(scenario.scenarioId, 'chokepointDisruption');
    assert.deepEqual(scenario.interventions, [{ parameter: 'vesselArrivals', target: 'supplied', samples: true }]);
    assert.equal(scenario.runTime, 90 * 86400);
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
