/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The importer's steps for the map-first workflow, as the host runs them: the roads alone, suggestions only
// when asked for, a file of sites and a model built from the pins and links placed on the map.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import importRegion from '../../packages/toolbox/importers/region.mjs';
import { createPin, linkId, networkProblems, networkSelection, pinFromCandidate, routeLinks, suggestLinks } from '../../packages/toolbox/lib/network.mjs';
import { defaultCatalogue, setVehicleField } from '../../packages/toolbox/lib/vehicles.mjs';
import { defaultSelection, discoverRegion } from '../../packages/toolbox/lib/discovery.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { createRouter } from '../../packages/toolbox/lib/roadGraph.mjs';
import { createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { logisticsRoot } from '../../scripts/konjugatePaths.mjs';
import { equationHelpers, loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { syntheticBbox, syntheticPortwatch, syntheticRegion } from '../fixtures/syntheticRegion.mjs';

const plugin = JSON.parse(await readFile(join(logisticsRoot, 'packages', 'engine', 'plugin.json'), 'utf8'));
const helpers = {
    reconcileEquationBindings: equationHelpers.reconcileEquationBindings,
    validateEquationLatex: equationHelpers.validateEquationLatex,
    async readPackageJson(relativePath) {
        if (/^geography\/[\w.]+\.json$/.test(relativePath)) return JSON.parse(await readFile(join(logisticsRoot, 'packages', 'toolbox', relativePath), 'utf8'));
        const id = relativePath.match(/^templates\/(\w+)\.json$/)?.[1];
        const contribution = plugin.contributes.find((entry) => entry.kind === 'component' && entry.componentId === id);
        if (!contribution) throw new Error(`No ${relativePath} in the package.`);
        return JSON.parse(await readFile(join(logisticsRoot, 'packages', 'engine', contribution.entry), 'utf8'));
    }
};
const templates = await loadTemplates();
const files = (answers) => Object.entries(answers).map(([role, answer]) => ({ role, name: `${role}.json`, text: JSON.stringify(answer), encoding: 'utf-8' }));
const allFiles = () => files({ ...syntheticRegion(), ...syntheticPortwatch() });
const roadsOnly = () => { const { roads, places } = syntheticRegion(); return files({ roads, places }); };
const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);

// The roads step's graph, as the window routes with it.
async function windowRouter(fileList = roadsOnly()) {
    const roads = await importRegion({ files: fileList, helpers, options: { step: 'roads' } });
    assert.equal(roads.ok, true, JSON.stringify(roads.report));
    return createNetworkRouter(roads.data.graph);
}

// A small network on the synthetic coast: a supplier inland, two warehouses, four stores and a customer area.
function placed() {
    const pins = [];
    const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
    add('supplier', { lat: -29.72, lon: -19.88 }, { name: 'Inland mill', fields: { supply: 60 } });
    add('supplier', { lat: -29.72, lon: -19.52 }, { name: 'East mill' });
    add('warehouse', { lat: -29.9, lon: -19.7 }, { name: 'Central depot' });
    add('warehouse', { lat: -29.76, lon: -19.5 }, { name: 'Hill depot' });
    add('store', { lat: -29.95, lon: -19.72 }, { name: 'Harbour shop', fields: { demand: 20 } });
    add('store', { lat: -29.85, lon: -19.69 }, { name: 'High street' });
    add('darkStore', { lat: -29.8, lon: -19.55 }, { name: 'Night hub', fields: { demand: 10 } });
    add('customerArea', { lat: -29.75, lon: -19.6 }, { name: 'Hill suburbs', fields: { population: 30000 } });
    return pins;
}

test('loading roads returns the map, place names and the compacted graph, and discovers nothing else', async () => {
    const result = await importRegion({ files: roadsOnly(), helpers, options: { step: 'roads', bbox: syntheticBbox } });
    assert.equal(result.ok, true, JSON.stringify(result.report));
    const { data } = result;
    assert.equal(data.step, 'roads');
    assert.equal(data.candidates, undefined, 'no suggestions unless asked for');
    assert.ok(data.map.roads.length >= 7);
    assert.deepEqual([data.map.ports, data.map.industrial, data.map.anchorages], [[], [], []]);
    assert.deepEqual(data.map.places.map((place) => place.name).sort(), ['Cedarton', 'Dunmore', 'Elmwick']);
    assert.ok(data.map.geography, 'land, coast and borders around a fetched region');
    assert.ok(data.graph.vertices.length > 5 && data.graph.edges.length > 5);
    assert.ok(data.notices.every((notice) => notice.kind === 'roads'));
    assert.ok(data.coverage.roads.kilometres > 50);
    // Even with every kind fetched (the sample region), the roads step reads only the roads and place names.
    const sample = await importRegion({ files: allFiles(), helpers, options: { step: 'roads' } });
    assert.equal(sample.data.candidates, undefined);
    assert.deepEqual(sample.data.map.ports, []);
    assert.ok(sample.data.map.bbox.south < -29.98 && sample.data.map.bbox.north > -29.7, 'with no box given, the map covers the roads');
    assert.match((await importRegion({ files: [], helpers, options: { step: 'roads' } })).report.errors[0], /Load the roads/);
});

test('suggestions come only from the sources asked for', async () => {
    const ask = async (sources) => (await importRegion({ files: allFiles(), helpers, options: { step: 'discover', sources, bbox: syntheticBbox } })).data;
    const ports = await ask(['ports']);
    assert.deepEqual(Object.keys(ports.candidates), ['ports']);
    assert.deepEqual(ports.candidates.ports.map((port) => port.name), ['Port Alder', 'Birch Harbour']);
    assert.ok(ports.candidates.ports[0].activity, 'matched to IMF PortWatch');
    assert.match(ports.attribution, /IMF PortWatch/);
    assert.ok(ports.overlay.ports.length > 0 && ports.overlay.industrial.length === 0);
    assert.ok(ports.notices.every((notice) => notice.kind === 'ports'));
    const warehouses = await ask(['warehouses']);
    assert.deepEqual(Object.keys(warehouses.candidates), ['zones']);
    assert.ok(warehouses.candidates.zones.length >= 2 && warehouses.overlay.industrial.length > 0 && warehouses.overlay.ports.length === 0);
    assert.equal(warehouses.coverage.warehouses.level, 'good');
    const towns = await ask(['towns']);
    assert.deepEqual(towns.candidates.towns.map((town) => town.name).sort(), ['Cedarton', 'Dunmore', 'Elmwick']);
    // With the ports' answers not fetched, asking for ports finds none (and fetches nothing: the importer never does).
    const none = await importRegion({ files: roadsOnly(), helpers, options: { step: 'discover', sources: ['ports'] } });
    assert.deepEqual(none.data.candidates.ports, []);
});

test('a file of sites is read for the window to place', async () => {
    const csv = 'name,kind,latitude,longitude,teuPerDay,from\nMill,supplier,-29.72,-19.88,40,\nDepot,warehouse,-29.9,-19.7,,Mill\n';
    const result = await importRegion({ files: [...roadsOnly(), { role: 'sites', name: 'sites.csv', text: csv }], helpers, options: { step: 'sites' } });
    assert.equal(result.ok, true);
    assert.deepEqual([...result.data.sites.ports, ...result.data.sites.zones].map((site) => [site.name, site.role, site.from ?? null]), [['Mill', 'supplier', null], ['Depot', 'warehouse', ['Mill']]]);
    assert.match((await importRegion({ files: roadsOnly(), helpers, options: { step: 'sites' } })).report.errors[0], /Choose a file/);
});

test('a network placed on the map builds a model whose lanes are its links, routed as the window routed them', async () => {
    const router = await windowRouter();
    const pins = placed();
    const links = suggestLinks(pins, [], router);
    routeLinks(pins, links, router);
    const result = await importRegion({ files: roadsOnly(), helpers, options: { step: 'buildNetwork', network: networkSelection(pins, links) } });
    assert.equal(result.ok, true, JSON.stringify(result.report));
    const { data } = result;
    assert.equal(data.step, 'buildNetwork');
    const name = (id) => pins.find((pin) => pin.id === id).name;
    const supplyLinks = links.filter((link) => pins.find((pin) => pin.id === link.from).role === 'supplier');
    assert.deepEqual(data.lanes.map((lane) => `${lane.from} > ${lane.to}`).sort(), supplyLinks.map((link) => `${name(link.from)} > ${name(link.to)}`).sort(), 'one lane per supply link, none dropped or added');
    for (const lane of data.lanes) {
        const link = supplyLinks.find((item) => name(item.from) === lane.from && name(item.to) === lane.to);
        close(lane.kilometres, Number(link.leg.kilometres.toFixed(1)), 1e-9, `${lane.name} as the window routed it`);
    }
    const serveLinks = links.filter((link) => pins.find((pin) => pin.id === link.from).role === 'warehouse');
    assert.deepEqual(data.served.map((item) => `${item.zone} > ${item.town}`).sort(), serveLinks.map((link) => `${name(link.from)} > ${name(link.to)}`).sort());
    // Every source ships what it supplies: 60 from the inland mill (the user's), 50 assumed from the other.
    const supplied = (entity) => data.provenance.find((entry) => entry.entity === entity && entry.parameter === 'Supplied');
    assert.deepEqual([supplied('Inland mill').value, supplied('Inland mill').basis], [60, 'user']);
    assert.deepEqual([supplied('East mill').value, supplied('East mill').basis], [50, 'assumed']);
    assert.match(supplied('East mill').detail, /default for a supplier/);
    assert.ok(data.ports.every((port) => port.supplier));
    const total = data.lanes.reduce((sum, lane) => sum + lane.rate, 0);
    close(total, 110, 1e-6, 'every unit supplied is carried');
    // Demand: the stores' own figures and the assumed one, scaled together to what is supplied; the customer area takes
    // the rest by its population.
    const demand = (entity) => data.provenance.find((entry) => entry.entity === entity && entry.parameter === 'Demand');
    assert.equal(demand('High street').basis, 'assumed');
    assert.match(demand('High street').detail, /default for a store/);
    assert.equal(demand('Harbour shop').basis, 'user');
    close(data.towns.reduce((sum, town) => sum + town.demand, 0), 110, 1e-6, 'demand matches supply');
    assert.match(result.report.summary, /^2 suppliers, \d road lanes?, 4 stores and customer areas served$/);
    // The lanes are drawn along the roads the window routed them over, a road several lanes share once.
    assert.ok(data.corridors.length && data.corridors.every((corridor) => corridor.basis === 'routed'), JSON.stringify(data.corridors.map((corridor) => corridor.basis)));
    assert.ok(data.corridors.some((corridor) => corridor.lanes.length > 1), 'a stretch of road shared by two lanes');
    // Without the roads (a network too large to send them), the lanes are straight.
    const straight = await importRegion({ files: roadsOnly(), helpers, options: { step: 'buildNetwork', network: networkSelection(pins, links, { paths: false }) } });
    assert.ok(straight.data.corridors.every((corridor) => corridor.points.length === 2));
});

test('a network with vehicles builds stores that hold stock, restocked over lanes of the vehicles each link names, in pallets', async () => {
    const router = await windowRouter();
    const pins = placed();
    const byName = (name) => pins.find((pin) => pin.name === name);
    byName('Central depot').fields.capacity = { value: 40, basis: 'user' };
    byName('Harbour shop').fields.cover = { value: 1.5, basis: 'user' };
    byName('Harbour shop').fields.lostSales = { value: 0, basis: 'user' };
    byName('High street').fields.saleValue = { value: 2500, basis: 'user' };
    const links = suggestLinks(pins, [], router);
    routeLinks(pins, links, router);
    const catalogue = defaultCatalogue();
    setVehicleField(catalogue.find((type) => type.id === 'miniVan'), 'capacity', '2.5');
    const toHarbour = links.find((link) => link.to === byName('Harbour shop').id);
    toHarbour.vehicles = [{ type: 'smallTruck', fleet: 3 }, { type: 'miniVan', fleet: null }];
    const build = (network) => importRegion({ files: roadsOnly(), helpers, options: { step: 'buildNetwork', network } });
    const result = await build(networkSelection(pins, links, { catalogue }));
    assert.equal(result.ok, true, JSON.stringify(result.report));
    const { data, document } = result;
    assert.equal(data.unit, 'pallets');
    assert.deepEqual(data.stores.map((item) => item.name).sort(), ['Harbour shop', 'High street', 'Night hub']);
    assert.deepEqual(data.vehicles.map((type) => type.id), ['heavyTruck', 'mediumTruck', 'smallTruck', 'miniVan', 'refrigeratedTruck']);
    assert.equal(data.categories, null, 'no categories asked for: goods of one kind');
    // A supplier is made to order: a Supplier node, its lanes Supplier shipments.
    assert.ok(document.nodes.some((node) => node.type === 'Supplier') && !document.nodes.some((node) => node.type === 'Port'));
    // Supply links on heavy trucks; each store restocked over a lane of its own, the dark store's on mini-vans.
    const supply = data.lanes.filter((lane) => lane.kind === 'supply');
    assert.ok(supply.length && supply.every((lane) => lane.vehicles.map((item) => item.type).join() === 'heavyTruck'));
    const harbour = data.lanes.find((lane) => lane.kind === 'store' && lane.site === 'Harbour shop');
    assert.equal(harbour.to, 'Harbour shop stock');
    assert.deepEqual(harbour.vehicles.map((item) => [item.type, item.user]), [['smallTruck', true], ['miniVan', false]]);
    assert.equal(harbour.fleet, 3, 'the fleet the user set');
    assert.ok(harbour.fleet2 >= 1, 'the fleet the toolbox sized');
    assert.equal(harbour.truckCapacity2, 2.5, 'the van\'s capacity as the user set it');
    assert.equal(data.lanes.find((lane) => lane.site === 'Night hub').vehicles[0].type, 'miniVan');
    // A type is one shared parameter for every lane and shipment it runs on, in pallets a vehicle.
    const shared = (symbol) => document.sharedParameters.filter((item) => item.symbol === symbol);
    assert.equal(shared('heavyTruckCapacity').length, 1);
    assert.deepEqual([shared('miniVanCapacity')[0].value, shared('miniVanCapacity')[0].unit], [2.5, 'pallets/vehicle']);
    assert.equal(shared('truckCapacity').length, 0, 'no two-size truck capacity');
    // Said in pallets and vehicles, in names and units alike.
    assert.deepEqual([shared('holdingCostPerDay')[0].name, shared('holdingCostPerDay')[0].unit], ['Holding cost per pallet-day', 'cost/pallet/day']);
    assert.ok(document.nodes.find((item) => item.type === 'Road lane').states.some((state) => state.name === 'Idle vehicles at origin' && state.unit === 'vehicles'));
    assert.ok(!data.provenance.some((entry) => entry.entity === 'Every store') || data.stores.length, 'the sale time is noted only where there are stores');
    const node = (name) => document.nodes.find((item) => item.name === name);
    assert.equal(node('Central depot').states.find((state) => state.symbol === 'stock').unit, 'pallets');
    assert.equal(node('Harbour shop stock').type, 'Warehouse');
    assert.equal(node('Harbour shop').type, 'Demand zone');
    // The figures the user set, with where they came from; the room that binds, said.
    const provenance = (entity, parameter) => data.provenance.find((entry) => entry.entity === entity && entry.parameter === parameter);
    assert.deepEqual([provenance('Harbour shop', 'Stock cover target').value, provenance('Harbour shop', 'Stock cover target').basis], [1.5, 'user']);
    assert.equal(provenance('High street', 'Stock cover target').basis, 'assumed');
    // Every shopper at the harbour shop waits, as the user said; the other stores lose the default, one figure for all.
    const lostShare = (store) => document.edges.find((edge) => edge.name === `Sales lost: ${store} stock → ${store}`)
        .parameters.find((parameter) => parameter.symbol === 'lostShare');
    assert.equal(lostShare('Harbour shop').value, 0);
    assert.equal(shared('storeLostShare')[0].value, 0.8);
    assert.equal(lostShare('High street').sharedParameterId, shared('storeLostShare')[0].id);
    assert.deepEqual([provenance('Harbour shop', 'Sales lost when out of stock').basis, provenance('Night hub', 'Orders lost when out of stock').value], ['user', 50]);
    assert.deepEqual(data.stores.map((item) => [item.name, item.lostShare, item.saleValue]).sort(), [['Harbour shop', 0, 1000], ['High street', 0.8, 2500], ['Night hub', 0.5, 1000]]);
    assert.equal(provenance('Mini-van', 'Capacity').basis, 'user');
    assert.equal(provenance('Heavy truck', 'Capacity').basis, 'assumed');
    assert.ok(data.warnings.some((text) => text.startsWith('Central depot has room for 40 pallets')), data.warnings.join(' / '));
    // Stock rooms and warehouses start full to their targets, within their room.
    const initial = (name, symbol) => node(name).states.find((state) => state.symbol === symbol).initialValue;
    assert.equal(initial('Central depot', 'stock'), 40);
    close(initial('Central depot', 'spaceUsed'), 1, 1e-12, 'a full warehouse');
    const harbourDemand = data.towns.find((town) => town.name === 'Harbour shop').demand;
    close(initial('Harbour shop stock', 'stock'), 1.5 * harbourDemand, 1e-9, 'a day and a half of sales');

    // Heavy trucks may not deliver to stores; a type with no capacity cannot run; a store with no room cannot sell.
    toHarbour.vehicles = [{ type: 'heavyTruck', fleet: null }];
    assert.match(networkProblems(pins, links, catalogue).find((problem) => problem.level === 'error').text, /^Heavy truck may not deliver to stores: choose another vehicle for Central depot → Harbour shop\.$/);
    const barred = await build(networkSelection(pins, links, { catalogue }));
    assert.match(barred.report.errors[0], /Heavy truck may not deliver to stores/);
    toHarbour.vehicles = [{ type: 'smallTruck', fleet: null }];
    const broken = defaultCatalogue();
    broken[0].fields.capacity = { value: 0, basis: 'user' };
    assert.match((await build(networkSelection(pins, links, { catalogue: broken }))).report.errors[0], /Heavy truck: its capacity must be more than nothing/);
    byName('High street').fields.capacity = { value: 0.1, basis: 'user' };
    assert.match((await build(networkSelection(pins, links, { catalogue }))).report.errors[0], /^High street can hold 0\.1 pallets, less than the [\d.]+ it sells in 2\.4 hours/);
});

test('a port in a network of pallets counts each container as ten pallets', async () => {
    const router = await windowRouter();
    const pins = placed().filter((pin) => pin.role !== 'supplier');
    pins.unshift(createPin('port', { lat: -29.72, lon: -19.88 }, { name: 'River port', pins, fields: { teuPerDay: 12 } }));
    const links = suggestLinks(pins, [], router);
    routeLinks(pins, links, router);
    const result = await importRegion({ files: roadsOnly(), helpers, options: { step: 'buildNetwork', network: networkSelection(pins, links, { catalogue: defaultCatalogue() }) } });
    assert.equal(result.ok, true, JSON.stringify(result.report));
    const handed = result.data.provenance.find((entry) => entry.entity === 'River port' && entry.parameter === 'Containers handed inland');
    assert.deepEqual([handed.value, handed.unit, handed.basis], [120, 'pallets/day', 'user']);
    assert.match(handed.detail, /Each TEU counted as an assumed 10 pallets/);
});

test('a port adopted from a suggestion keeps its IMF PortWatch volume; one of the user\'s own takes theirs', async () => {
    const router = await windowRouter(allFiles());
    const discovered = (await importRegion({ files: allFiles(), helpers, options: { step: 'discover', sources: ['ports', 'warehouses'], bbox: syntheticBbox } })).data.candidates;
    const pins = [];
    const port = pinFromCandidate(discovered.ports[0], 'ports', pins);
    pins.push(port);
    pins.push(pinFromCandidate(discovered.zones[0], 'zones', pins));
    pins.push(createPin('port', { lat: -29.99, lon: -19.5 }, { pins, name: 'Our quay', fields: { teuPerDay: 30 } }));
    pins.push(createPin('store', { lat: -29.85, lon: -19.69 }, { pins, name: 'High street' }));
    pins.push(createPin('customerArea', { lat: -29.75, lon: -19.6 }, { pins, name: 'Hill suburbs' }));
    const links = suggestLinks(pins, [], router);
    routeLinks(pins, links, router);
    // Moved a little from where it was found: still Port Alder, with its history.
    port.lat += 0.002;
    routeLinks(pins, links, router);
    const result = await importRegion({ files: allFiles(), helpers, options: { step: 'buildNetwork', bbox: syntheticBbox, network: networkSelection(pins, links) } });
    assert.equal(result.ok, true, JSON.stringify(result.report));
    const inland = (entity) => result.data.provenance.find((entry) => entry.entity === entity && entry.parameter === 'Containers handed inland');
    assert.equal(inland('Port Alder').basis, 'sourced');
    assert.deepEqual([inland('Our quay').value, inland('Our quay').basis], [30, 'user']);
    // Built again without the ports' answers (the suggestions no longer loaded): built as the user's own site, and said so.
    const bare = await importRegion({ files: roadsOnly(), helpers, options: { step: 'buildNetwork', network: networkSelection(pins, links) } });
    assert.equal(bare.ok, true, JSON.stringify(bare.report));
    assert.ok(bare.data.warnings.some((text) => /Port Alder, Alder Industrial Park were adopted from map data that is no longer loaded/.test(text)), bare.data.warnings.join('\n'));
});

test('links the user drew are kept as drawn, however small their flow', async () => {
    const router = await windowRouter();
    const pins = placed();
    const [inland, east] = pins.filter((pin) => pin.role === 'supplier');
    const [central, hill] = pins.filter((pin) => pin.role === 'warehouse');
    // A tiny mill supplying a unit a day.
    pins.push(createPin('supplier', { lat: -29.74, lon: -19.7 }, { pins, name: 'Tiny mill', fields: { supply: 1 } }));
    const tiny = pins.at(-1);
    const suggested = suggestLinks(pins, [], router);
    routeLinks(pins, suggested, router);
    const asSuggested = await importRegion({ files: roadsOnly(), helpers, options: { step: 'buildNetwork', network: networkSelection(pins, suggested) } });
    assert.equal(asSuggested.ok, true, JSON.stringify(asSuggested.report));
    // Suggested to both depots, it carries half a unit to one of them: that suggestion is left out, and said so.
    assert.equal(asSuggested.data.lanes.filter((lane) => lane.from === 'Tiny mill').length, 1);
    assert.deepEqual(asSuggested.data.unusedLinks.map((link) => [link.from, link.why]), [['Tiny mill', 'carries too little']]);
    // Drawn by the user, every link is a lane, however little it carries.
    const drawn = [[inland, central], [inland, hill], [east, central], [east, hill], [tiny, central], [tiny, hill]].map(([from, to]) => ({ id: linkId(from.id, to.id), from: from.id, to: to.id, basis: 'user' }));
    const links = suggestLinks(pins, drawn, router);
    routeLinks(pins, links, router);
    const result = await importRegion({ files: roadsOnly(), helpers, options: { step: 'buildNetwork', network: networkSelection(pins, links) } });
    assert.equal(result.ok, true, JSON.stringify(result.report));
    assert.equal(result.data.lanes.length, 6, 'six lanes, the small ones too');
    assert.deepEqual(result.data.unusedLinks, []);
});

test('a network that cannot be built says why, naming the site', async () => {
    const router = await windowRouter();
    const build = async (pins, links) => {
        routeLinks(pins, links, router);
        return importRegion({ files: roadsOnly(), helpers, options: { step: 'buildNetwork', network: networkSelection(pins, links) } });
    };
    const pins = placed();
    const links = suggestLinks(pins, [], router);
    const shop = pins.find((pin) => pin.name === 'Harbour shop');
    const unserved = await build(pins, links.filter((link) => link.to !== shop.id));
    assert.match(unserved.report.errors[0], /^Harbour shop has no warehouse linked to it/);
    // Two sites of one name.
    const twins = placed();
    twins.find((pin) => pin.name === 'High street').name = 'Harbour shop';
    assert.match((await build(twins, suggestLinks(twins, [], router))).report.errors[0], /^Two sites are named Harbour shop/);
    // A depot left with nothing to serve: its only mill then supplies no one.
    const strict = placed();
    const byName = (name) => strict.find((pin) => pin.name === name);
    const user = (from, to) => ({ id: linkId(byName(from).id, byName(to).id), from: byName(from).id, to: byName(to).id, basis: 'user' });
    const idle = await build(strict, [user('Inland mill', 'Central depot'), user('East mill', 'Hill depot'), ...['Harbour shop', 'High street', 'Night hub', 'Hill suburbs'].map((name) => user('Central depot', name))]);
    assert.match(idle.report.errors[0], /^East mill supplies 50 TEU a day, but no warehouse that serves anyone is linked to it/);
    // The inland mill ships 60 a day to the central depot alone, which passes on only the harbour shop's 20: no balance.
    const lopsided = await build(strict, [user('Inland mill', 'Central depot'), user('East mill', 'Hill depot'), user('Central depot', 'Harbour shop'), ...['High street', 'Night hub', 'Hill suburbs'].map((name) => user('Hill depot', name))]);
    assert.match(lopsided.report.errors[0], /^The links cannot carry what every source supplies to the warehouses that need it/);
});

test('a network linked as gravity would link it builds the same model as the curated region', () => {
    const { candidates, roadGraph } = discoverRegion(syntheticRegion());
    const route = createRouter(roadGraph).route;
    const selection = defaultSelection(candidates);
    const gravity = buildRegionModel({ builder: new ModelBuilder(templates), selection, route });
    const id = (group, name) => selection[group].find((site) => site.name === name).id;
    const links = {
        supply: gravity.lanes.map((lane) => ({ port: id('ports', lane.from), zone: id('zones', lane.to), leg: null })),
        serve: gravity.served.map((item) => ({ zone: id('zones', item.zone), town: id('towns', item.town), leg: null }))
    };
    const linked = buildRegionModel({ builder: new ModelBuilder(templates), selection, route, links });
    assert.deepEqual(linked.lanes.map((lane) => [lane.name, lane.fleet]), gravity.lanes.map((lane) => [lane.name, lane.fleet]));
    for (const [index, lane] of linked.lanes.entries()) close(lane.rate, gravity.lanes[index].rate, 1e-6, lane.name);
    for (const [index, item] of linked.served.entries()) close(item.share, gravity.served[index].share, 1e-9, `${item.town} from ${item.zone}`);
    assert.equal(linked.document.nodes.length, gravity.document.nodes.length);
    assert.equal(linked.document.edges.length, gravity.document.edges.length);
});
