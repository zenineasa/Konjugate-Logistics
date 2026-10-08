/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The network the user places on the map: pins with roles, suggested and drawn links, what stops a build,
// and the CSV that saves and loads it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRoadGraph } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../../packages/toolbox/lib/routing.mjs';
import { completeSupplyUpTo, createPin, defaultName, linkId, linkProblem, networkFromSites, networkProblems, networkSelection, pinFromCandidate, roleIds, roles, routeLinks, setCandidate, setField, sourcesPerWarehouse, suggestLinks, warehousesPerSource } from '../../packages/toolbox/lib/network.mjs';
import { parseSites, writeSites } from '../../packages/toolbox/lib/sites.mjs';
import { defaultCategoryCatalogue, setLeadDays, setMix } from '../../packages/toolbox/lib/categories.mjs';
import { gridRoads, randomPoint, seeded } from '../fixtures/roadGrid.mjs';

const grid = gridRoads({ size: 30, spacing: 400 });
const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(grid.features)));
const at = (row, column) => grid.at(row, column);

// Three suppliers, two warehouses and twenty stores: the network milestone A asks a user to place.
function cityNetwork() {
    const pins = [];
    const add = (role, point, options = {}) => { const pin = createPin(role, point, { pins, ...options }); pins.push(pin); return pin; };
    add('supplier', at(1, 1));
    add('supplier', at(28, 2));
    add('supplier', at(15, 28));
    add('warehouse', at(8, 8));
    add('warehouse', at(20, 20));
    const random = seeded(21);
    for (let index = 0; index < 20; index += 1) add('store', randomPoint(random, grid.bounds));
    return pins;
}

test('a pin starts with its role\'s defaults, labelled assumed, and a field the user sets is theirs until cleared', () => {
    const store = createPin('store', { lat: 1, lon: 2 });
    assert.equal(store.name, 'Store 1');
    assert.deepEqual(store.fields.demand, { value: roles.store.fields[0].value, basis: 'assumed' });
    setField(store, 'demand', '12');
    assert.deepEqual(store.fields.demand, { value: 12, basis: 'user' });
    setField(store, 'demand', '');
    assert.equal(store.fields.demand.basis, 'assumed');
    // A port's volume is empty until set: PortWatch or the assumed volume a port decide it.
    assert.deepEqual(createPin('port', { lat: 0, lon: 0 }).fields.teuPerDay, { value: null, basis: null });
    assert.deepEqual(createPin('customerArea', { lat: 0, lon: 0 }, { fields: { population: 5000 } }).fields.population, { value: 5000, basis: 'user' });
    assert.throws(() => createPin('castle', { lat: 0, lon: 0 }), /not a role/);
    assert.deepEqual(roleIds, ['supplier', 'port', 'warehouse', 'store', 'darkStore', 'customerArea']);
});

test('new pins are named by role, with the next number not yet used', () => {
    const pins = [createPin('store', { lat: 0, lon: 0 }), createPin('store', { lat: 0, lon: 0 }, { name: 'Store 3' })];
    assert.equal(defaultName('store', pins), 'Store 2');
    assert.equal(defaultName('darkStore', pins), 'Dark store 1');
});

test('links run from a source to a warehouse and from a warehouse to demand; any other link says why not', () => {
    const pin = (role) => createPin(role, { lat: 0, lon: 0 });
    const [supplier, port, warehouse, other, store, darkStore, area] = ['supplier', 'port', 'warehouse', 'warehouse', 'store', 'darkStore', 'customerArea'].map(pin);
    for (const [from, to] of [[supplier, warehouse], [port, warehouse], [warehouse, store], [warehouse, darkStore], [warehouse, area]]) assert.equal(linkProblem(from, to), null);
    assert.match(linkProblem(supplier, store), /through a warehouse/);
    assert.match(linkProblem(store, warehouse), /at the end of the network/);
    assert.match(linkProblem(warehouse, supplier), /is a source/);
    assert.equal(linkProblem(warehouse, other), null, 'one warehouse may restock another');
    assert.match(linkProblem(supplier, port), /not each other/);
    assert.match(linkProblem(store, store), /two different sites/);
});

test('links are suggested: each store from its nearest warehouse by road, and in a small network each warehouse from every source', () => {
    const pins = cityNetwork();
    const links = suggestLinks(pins, [], router);
    const stores = pins.filter((pin) => pin.role === 'store');
    const warehouses = pins.filter((pin) => pin.role === 'warehouse');
    const suppliers = pins.filter((pin) => pin.role === 'supplier');
    for (const store of stores) {
        const into = links.filter((link) => link.to === store.id);
        assert.equal(into.length, 1, `${store.name} has one warehouse`);
        const hours = warehouses.map((warehouse) => router.route(warehouse, store).hours);
        assert.equal(into[0].from, warehouses[hours.indexOf(Math.min(...hours))].id, `${store.name} from its nearest warehouse`);
    }
    // Three suppliers and two warehouses: six links, so whatever the suppliers ship has somewhere to go.
    for (const warehouse of warehouses) assert.deepEqual(links.filter((link) => link.to === warehouse.id).map((link) => link.from).sort(), suppliers.map((supplier) => supplier.id).sort());
    assert.ok(links.every((link) => link.basis === 'suggested'));
    assert.deepEqual(networkProblems(pins, links), []);
});

test('in a larger network each warehouse is suggested its nearest few sources, and each source its nearest few warehouses', () => {
    const pins = [];
    const random = seeded(31);
    for (let index = 0; index < 8; index += 1) pins.push(createPin('supplier', randomPoint(random, grid.bounds), { pins }));
    for (let index = 0; index < 4; index += 1) pins.push(createPin('warehouse', randomPoint(random, grid.bounds), { pins }));
    pins.push(createPin('store', randomPoint(random, grid.bounds), { pins }));
    assert.ok(8 * 4 > completeSupplyUpTo);
    const links = suggestLinks(pins, [], router);
    const suppliers = pins.filter((pin) => pin.role === 'supplier');
    for (const warehouse of pins.filter((pin) => pin.role === 'warehouse')) {
        const ranked = suppliers.map((supplier) => ({ id: supplier.id, hours: router.route(supplier, warehouse).hours })).sort((a, b) => a.hours - b.hours);
        const into = links.filter((link) => link.to === warehouse.id).map((link) => link.from);
        for (const { id } of ranked.slice(0, sourcesPerWarehouse)) assert.ok(into.includes(id), `${warehouse.name} from its nearest ${sourcesPerWarehouse}`);
    }
    for (const supplier of suppliers) assert.ok(links.filter((link) => link.from === supplier.id).length >= warehousesPerSource, `${supplier.name} to at least ${warehousesPerSource}`);
});

test('a link the user drew is kept, a suggested link the user deleted is not suggested again and a link suggested again keeps its leg', () => {
    const pins = cityNetwork();
    let links = suggestLinks(pins, [], router);
    routeLinks(pins, links, router);
    const store = pins.find((pin) => pin.role === 'store');
    const [first, second] = pins.filter((pin) => pin.role === 'warehouse');
    const current = links.find((link) => link.to === store.id);
    const other = current.from === first.id ? second : first;
    // The user serves this store from the other warehouse.
    links = links.filter((link) => link !== current);
    links.push({ id: linkId(other.id, store.id), from: other.id, to: store.id, basis: 'user' });
    const dismissed = new Set([current.id]);
    const kept = links.find((link) => link.basis === 'suggested' && link.to !== store.id);
    links = suggestLinks(pins, links, router, dismissed);
    assert.deepEqual(links.filter((link) => link.to === store.id).map((link) => [link.from, link.basis]), [[other.id, 'user']]);
    assert.ok(links.includes(kept), 'the same link object, so it is not routed again');
    // Deleting the user's link too leaves the store with no link: it is not suggested from the warehouse dismissed.
    links = suggestLinks(pins, links.filter((link) => link.basis !== 'user'), router, dismissed);
    assert.ok(!links.some((link) => link.to === store.id));
    assert.deepEqual(networkProblems(pins, links).map((problem) => problem.text), [`${store.name} has no warehouse linked to it. Drag a link from a warehouse to it.`]);
});

test('moving one pin re-routes only its own links, and moving a warehouse can hand its stores to another', () => {
    const pins = cityNetwork();
    let links = suggestLinks(pins, [], router);
    assert.equal(routeLinks(pins, links, router), links.length, 'all routed once');
    assert.equal(routeLinks(pins, links, router), 0, 'nothing moved, nothing routed');
    const store = pins.find((pin) => pin.role === 'store');
    Object.assign(store, at(5, 5));
    links = suggestLinks(pins, links, router);
    const started = performance.now();
    const routed = routeLinks(pins, links, router);
    assert.ok(performance.now() - started < 1000, 'well under a second');
    assert.equal(routed, links.filter((link) => link.to === store.id || link.from === store.id).length);
    // The first warehouse moved to the far corner: the stores near its old place now come from the other one.
    const [first, second] = pins.filter((pin) => pin.role === 'warehouse');
    Object.assign(first, at(29, 29));
    links = suggestLinks(pins, links, router);
    assert.ok(links.some((link) => link.to === store.id && link.from === second.id), 'the store at (5, 5) is now served from the warehouse at (20, 20)');
    for (const link of links) assert.ok(link.basis === 'suggested');
    routeLinks(pins, links, router);
    assert.ok(links.every((link) => link.leg && link.leg.hours > 0));
});

test('placing a network of three suppliers, two warehouses and twenty stores is suggested and routed in well under a second', () => {
    const started = performance.now();
    const pins = cityNetwork();
    const links = suggestLinks(pins, [], router);
    routeLinks(pins, links, router);
    const elapsed = performance.now() - started;
    assert.equal(links.length, 20 + 3 * 2);
    assert.ok(elapsed < 1000, `${elapsed.toFixed(0)} ms`);
});

test('what stops a build is named, with the pins it concerns', () => {
    const texts = (pins, links = []) => networkProblems(pins, links).map((problem) => `${problem.level}: ${problem.text}`);
    assert.deepEqual(texts([]), [
        'error: Place a supplier or a port: it is where goods enter the network.',
        'error: Place a warehouse: stores and customers are served from warehouses.',
        'error: Place a store, a dark store or a customer area: it is where the demand is.'
    ]);
    const supplier = createPin('supplier', at(1, 1), { name: 'Mill' });
    const port = createPin('port', at(1, 2), { name: 'Quay' });
    const warehouse = createPin('warehouse', at(5, 5), { name: 'Depot' });
    const idle = createPin('warehouse', at(9, 9), { name: 'Spare depot' });
    const store = createPin('store', at(6, 6), { name: 'Corner shop' });
    const pins = [supplier, port, warehouse, idle, store];
    const problems = networkProblems(pins, [{ id: 'a', from: warehouse.id, to: store.id }, { id: 'b', from: store.id, to: idle.id }]);
    assert.deepEqual(problems.map((problem) => problem.text), [
        'Corner shop supplies nothing: a store is at the end of the network. Draw links from warehouses to it.',
        'Depot has no supplier, port or warehouse that restocks it. Drag a link from one to it.',
        'Spare depot serves no store or customer area, so it is left out of the model.',
        'Mill supplies no warehouse that serves anyone. Link it to a warehouse, or delete it.',
        'Quay supplies no warehouse that serves anyone: it is kept as a port cargo can be diverted to, with no lanes.'
    ]);
    assert.deepEqual(problems.map((problem) => problem.level), ['error', 'error', 'warning', 'error', 'warning']);
    assert.deepEqual(problems[1].pins, [warehouse.id]);
    const twin = createPin('store', at(7, 7), { name: 'Corner shop' });
    assert.deepEqual(networkProblems([...pins, twin], []).filter((problem) => /Two sites/.test(problem.text)).map((problem) => [problem.text, problem.pins]), [['Two sites are named Corner shop: give each its own name.', [store.id, twin.id]]]);
});

test('the importer gets the pins by group, adopted ones by the candidate they came from and the links with their legs', () => {
    const port = pinFromCandidate({ id: 'port:way/7', name: 'Port Alder', lat: -29.99, lon: -19.9, areaSquareKilometres: 2 }, 'ports', []);
    const warehouse = pinFromCandidate({ id: 'zone:3', name: 'Alder Park', lat: -29.9, lon: -19.9, floorAreaSquareMetres: 52000.4 }, 'zones', []);
    const town = pinFromCandidate({ id: 'town:node/5', name: 'Cedarton', lat: -29.8, lon: -19.7, population: 80000, populationBasis: 'OpenStreetMap' }, 'towns', []);
    assert.deepEqual([port.role, warehouse.role, town.role], ['port', 'warehouse', 'customerArea']);
    assert.deepEqual(warehouse.fields.floorArea, { value: 52000, basis: 'sourced' });
    assert.deepEqual(town.fields.population, { value: 80000, basis: 'sourced' });
    const supplier = createPin('supplier', at(1, 1), { name: 'Mill', fields: { supply: 40 } });
    const store = createPin('store', at(2, 2), { name: 'Shop' });
    const pins = [port, warehouse, town, supplier, store];
    const links = [
        { id: '1', from: port.id, to: warehouse.id, basis: 'user', leg: { kilometres: 12, hours: 0.3, basis: 'routed', path: { points: [] } } },
        { id: '6', from: warehouse.id, to: town.id, basis: 'user', leg: { kilometres: 3, hours: 0.1, basis: 'routed', path: { points: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.1 }] } } },
        { id: '2', from: supplier.id, to: warehouse.id, basis: 'suggested' },
        { id: '3', from: warehouse.id, to: town.id, basis: 'suggested' },
        { id: '4', from: warehouse.id, to: store.id, basis: 'suggested' },
        { id: '5', from: supplier.id, to: store.id, basis: 'user' }
    ];
    const { selection, links: given } = networkSelection(pins, links);
    assert.deepEqual(selection.ports.map((entry) => [entry.id, entry.role, entry.supplier ?? false, entry.teuPerDay ?? null, entry.teuPerDayBasis ?? null]), [['port:way/7', 'port', false, null, null], [supplier.id, 'supplier', true, 40, 'user']]);
    assert.deepEqual(selection.zones.map((entry) => [entry.id, entry.floorAreaSquareMetres, entry.floorAreaBasis]), [['zone:3', 52000, 'sourced']]);
    assert.deepEqual(selection.towns.map((entry) => [entry.id, entry.teuPerDay ?? null, entry.teuPerDayBasis ?? null, entry.population ?? null, entry.populationBasis ?? null]), [
        ['town:node/5', null, null, 80000, 'OpenStreetMap'], [store.id, roles.store.fields[0].value, 'assumed', null, null]
    ]);
    // The link a store cannot have yet (straight from a supplier) is left out.
    assert.deepEqual(given.supply, [{ port: 'port:way/7', zone: 'zone:3', leg: { kilometres: 12, hours: 0.3, basis: 'routed', path: null }, user: true }, { port: supplier.id, zone: 'zone:3', leg: null }]);
    assert.deepEqual(given.serve.map((link) => [link.zone, link.town, link.leg?.path ?? null]), [['zone:3', 'town:node/5', null], ['zone:3', 'town:node/5', null], ['zone:3', store.id, null]], 'a store\'s link needs no road drawn');
});

test('the network saved as a CSV reads back as the same pins and links, with only the figures the user set', () => {
    const supplier = createPin('supplier', { lat: 25.1, lon: 55.1 }, { name: 'Mill, north', fields: { supply: 40 } });
    const warehouse = createPin('warehouse', { lat: 25.2, lon: 55.2 }, { name: 'Depot "A"', fields: { capacity: 4000 } });
    const store = createPin('store', { lat: 25.3, lon: 55.3 }, { name: 'Shop', fields: { cover: 1.5 } });
    const dark = createPin('darkStore', { lat: 25.31, lon: 55.31 }, { name: 'Night hub', fields: { demand: 7 } });
    const area = createPin('customerArea', { lat: 25.4, lon: 55.4 }, { name: 'Suburbs', fields: { population: 12000 } });
    const pins = [supplier, warehouse, store, dark, area];
    const links = [[supplier, warehouse], [warehouse, store], [warehouse, dark], [warehouse, area]].map(([from, to]) => ({ id: linkId(from.id, to.id), from: from.id, to: to.id, basis: 'suggested' }));
    const text = writeSites(pins, links);
    assert.equal(text.split('\n')[0], 'name,kind,latitude,longitude,teuPerDay,floorArea,population,capacity,cover,from,mix,leadDays,makes');
    assert.match(text, /^"Mill, north",supplier,25\.1,55\.1,40,,,,,,,,$/m);
    assert.match(text, /^Shop,store,25\.3,55\.3,,,,,1\.5,"Depot ""A""",,,$/m, 'the assumed demand is left out; the cover set is kept');
    assert.match(text, /^"Depot ""A""",warehouse,25\.2,55\.2,,,,4000,,"Mill, north",,,$/m, 'the capacity set is kept, the assumed cover is not');
    const parsed = parseSites(text);
    assert.deepEqual(parsed.errors, []);
    const loaded = networkFromSites(parsed.sites);
    assert.deepEqual(loaded.problems, []);
    assert.deepEqual(loaded.pins.map((pin) => [pin.name, pin.role, pin.lat, pin.lon]), pins.map((pin) => [pin.name, pin.role, pin.lat, pin.lon]).sort((a, b) => ['supplier', 'port', 'warehouse', 'store', 'darkStore', 'customerArea'].indexOf(a[1]) - ['supplier', 'port', 'warehouse', 'store', 'darkStore', 'customerArea'].indexOf(b[1])));
    const byName = new Map(loaded.pins.map((pin) => [pin.name, pin]));
    assert.deepEqual(byName.get('Mill, north').fields.supply, { value: 40, basis: 'user' });
    assert.equal(byName.get('Shop').fields.demand.basis, 'assumed');
    assert.deepEqual(byName.get('Shop').fields.cover, { value: 1.5, basis: 'user' });
    assert.deepEqual(byName.get('Depot "A"').fields.capacity, { value: 4000, basis: 'user' });
    assert.deepEqual(byName.get('Depot "A"').fields.cover, { value: 3, basis: 'assumed' });
    assert.deepEqual(byName.get('Night hub').fields.demand, { value: 7, basis: 'user' });
    assert.deepEqual(byName.get('Suburbs').fields.population, { value: 12000, basis: 'user' });
    assert.deepEqual(loaded.links.map((link) => [byName.get('Mill, north').id === link.from ? 'Mill, north' : 'Depot "A"', [...byName.values()].find((pin) => pin.id === link.to).name]).sort(), [['Depot "A"', 'Night hub'], ['Depot "A"', 'Shop'], ['Depot "A"', 'Suburbs'], ['Mill, north', 'Depot "A"']]);
    assert.ok(loaded.links.every((link) => link.basis === 'user'), 'links from a file are the user\'s');
});

test('a file\'s links to sites that are not there, or that cannot be linked, are reported', () => {
    const parsed = parseSites('name,kind,latitude,longitude,from\nMill,supplier,1,1,\nShop,store,1.1,1.1,Mill|Nowhere\n');
    assert.deepEqual(parsed.errors, []);
    const loaded = networkFromSites(parsed.sites);
    assert.deepEqual(loaded.links, []);
    assert.deepEqual(loaded.problems, ['Shop is supplied through a warehouse in this version: link Mill to a warehouse, and the warehouse to Shop.', 'Shop is supplied from "Nowhere", which is not a site in the file or on the map.']);
});

test('every role reads from a file, old kinds too', () => {
    const { sites, errors } = parseSites('name,kind,lat,lon\nA,factory,1,1\nB,terminal,1,1\nC,DC,1,1\nD,shop,1,1\nE,dark store,1,1\nF,customer,1,1\nG,town,1,1\nH,customer area,1,1\n');
    assert.deepEqual(errors, []);
    assert.deepEqual([...sites.ports, ...sites.zones, ...sites.towns].map((site) => [site.name, site.role]), [['A', 'supplier'], ['B', 'port'], ['C', 'warehouse'], ['D', 'store'], ['E', 'darkStore'], ['F', 'customerArea'], ['G', 'customerArea'], ['H', 'customerArea']]);
    assert.equal(sites.ports[0].supplier, true);
});

test('a site\'s own mix of categories, a supplier\'s own lead times and the most it can make are saved with the network and read back', () => {
    const categories = defaultCategoryCatalogue();
    const dairy = createPin('supplier', { lat: 25.1, lon: 55.1 }, { name: 'Dairy', fields: { supply: 30, makes: 45 } });
    setMix(dairy, 'ambient', 0, categories);
    setMix(dairy, 'frozen', 0, categories);
    setLeadDays(dairy, 'chilled', '0.5');
    const mill = createPin('supplier', { lat: 25.15, lon: 55.15 }, { name: 'Mill' });
    const warehouse = createPin('warehouse', { lat: 25.2, lon: 55.2 }, { name: 'Depot' });
    const shop = createPin('store', { lat: 25.3, lon: 55.3 }, { name: 'Shop' });
    setMix(shop, 'frozen', 0, categories);
    const pins = [dairy, mill, warehouse, shop];
    const links = [[dairy, warehouse], [mill, warehouse], [warehouse, shop]].map(([from, to]) => ({ id: linkId(from.id, to.id), from: from.id, to: to.id, basis: 'user' }));
    const text = writeSites(pins, links, categories);
    assert.match(text, /^Dairy,supplier,25\.1,55\.1,30,,,,,,"Ambient:0\|Chilled:25\|Frozen:0",Chilled:0\.5,45$/m);
    assert.match(text, /^Mill,supplier,25\.15,55\.15,,,,,,,,,$/m, 'the usual shares are not written: they are the network\'s to give');
    assert.match(text, /^Shop,store,25\.3,55\.3,,,,,,Depot,"Ambient:60\|Chilled:25\|Frozen:0",,$/m);
    const parsed = parseSites(text);
    assert.deepEqual([parsed.errors, parsed.warnings], [[], []]);
    const loaded = networkFromSites(parsed.sites, [], categories);
    assert.deepEqual(loaded.problems, []);
    const byName = new Map(loaded.pins.map((pin) => [pin.name, pin]));
    assert.deepEqual(byName.get('Dairy').mix, { ambient: 0, chilled: 25, frozen: 0 });
    assert.deepEqual(byName.get('Dairy').leadDays, { chilled: 0.5 });
    assert.deepEqual(byName.get('Dairy').fields.makes, { value: 45, basis: 'user' });
    assert.deepEqual(byName.get('Shop').mix, { ambient: 60, chilled: 25, frozen: 0 });
    assert.equal(byName.get('Mill').mix, undefined);
    assert.equal(byName.get('Mill').leadDays, undefined);
    // Written by hand: a category left out is not carried, names are matched whatever their case, and one the network
    // does not have is said and left out; a part that is no category and number, or a warehouse's mix, is said too.
    const hand = parseSites('name,kind,lat,lon,mix,lead days,makes\nFarm,supplier,25,55,chilled:1;Fresh:3,CHILLED:2,12\nHub,warehouse,25.1,55.1,Ambient:1,,\nStall,store,25.2,55.2,Ambient,,5\n');
    assert.deepEqual(hand.errors, ['Line 4: "Ambient" for Stall is not a category and a number, as in Chilled:30.']);
    assert.deepEqual(hand.warnings, ['Line 3: a warehouse carries what passes through it, so its mix is not used.', 'Line 4: only a supplier has lead times and a most it can make, so Stall\'s are not used.']);
    const farm = networkFromSites({ ports: hand.sites.ports, zones: [], towns: [] }, [], categories);
    assert.deepEqual(farm.pins[0].mix, { ambient: 0, chilled: 1, frozen: 0 });
    assert.deepEqual(farm.pins[0].leadDays, { chilled: 2 });
    assert.deepEqual(farm.problems, ['Farm names the category "Fresh", which this network does not have: add it under Categories and load the file again, or it is left out.']);
});

test('a candidate warehouse is left out of the network, with its links, until it is opened for a comparison', async () => {
    const { isCandidate, openNetwork } = await import('../../packages/toolbox/lib/network.mjs');
    const supplier = createPin('supplier', { lat: 25.1, lon: 55.1 }, { name: 'Mill' });
    const depot = createPin('warehouse', { lat: 25.2, lon: 55.2 }, { name: 'Depot' });
    const site = createPin('warehouse', { lat: 25.25, lon: 55.25 }, { name: 'New site', fields: { fixedCost: 9000, openingCost: 120000 } });
    setCandidate(site, true);
    const shop = createPin('store', { lat: 25.3, lon: 55.3 }, { name: 'Shop' });
    const pins = [supplier, depot, site, shop];
    const link = (from, to) => ({ id: linkId(from.id, to.id), from: from.id, to: to.id, basis: 'user' });
    const links = [link(supplier, depot), link(depot, shop), link(supplier, site), link(site, shop)];
    assert.deepEqual([isCandidate(site), isCandidate(depot), isCandidate({ role: 'store', candidate: true })], [true, false, false]);
    // The mark is its own: a site placed by hand gains no record of having been adopted, and a warehouse adopted from
    // OpenStreetMap keeps its record through being made a candidate and opened again.
    assert.deepEqual([site.proposed, 'candidate' in site], [true, false]);
    const record = { id: 'way/7', name: 'Shed', lat: 25.4, lon: 55.4, floorAreaSquareMetres: 4000 };
    const adopted = pinFromCandidate(record, 'zones', pins);
    assert.equal(isCandidate(adopted), false, 'adopted is not proposed');
    setCandidate(adopted, true);
    assert.deepEqual([isCandidate(adopted), adopted.candidate], [true, record]);
    setCandidate(adopted, false);
    assert.deepEqual([isCandidate(adopted), adopted.candidate, 'proposed' in adopted], [false, record, false]);
    // A session kept before the mark had its own field: read as it was meant, and put right when next changed.
    const old = { ...createPin('warehouse', { lat: 25.5, lon: 55.5 }), candidate: true };
    assert.equal(isCandidate(old), true);
    setCandidate(old, true);
    assert.deepEqual([old.proposed, 'candidate' in old], [true, false]);
    assert.deepEqual(site.fields.fixedCost, { value: 9000, basis: 'user' });
    assert.deepEqual(depot.fields.fixedCost, { value: null, basis: null }, 'no fixed cost until one is given');
    // As it is: the candidate and both its links are not there.
    const asIs = openNetwork(pins, links);
    assert.deepEqual([asIs.pins.map((pin) => pin.name), asIs.links.length], [['Mill', 'Depot', 'Shop'], 2]);
    assert.deepEqual(networkSelection(pins, links).selection.zones.map((zone) => zone.name), ['Depot']);
    assert.deepEqual(networkSelection(pins, links).links.serve.length, 1);
    assert.deepEqual(networkProblems(pins, links), [], 'the network as it is has nothing wrong, and neither has the candidate');
    // Opened: it is a warehouse like the other, the shop restocked from both.
    const opened = networkSelection(pins, links, { open: [site.id] });
    assert.deepEqual(opened.selection.zones.map((zone) => zone.name), ['Depot', 'New site']);
    assert.deepEqual([opened.links.supply.length, opened.links.serve.length], [2, 2]);
    // A candidate with nothing to supply, or nothing to restock it, says so, and stops nothing.
    assert.deepEqual(networkProblems(pins, links.slice(0, 3)), [{ level: 'warning', text: 'New site is a candidate with no store or warehouse to supply: link it to those it would take, to compare it.', pins: [site.id] }]);
    assert.deepEqual(networkProblems(pins, [links[0], links[1], links[3]]).map((problem) => problem.text), ['New site is a candidate with no supplier, port or warehouse to restock it: link one to it, to compare it.']);
    // A store is suggested its nearest open warehouse, never a candidate; a candidate is suggested suppliers as any warehouse is.
    const near = { nearestSources: (sources) => () => sources.at(-1), route: () => ({ hours: 1 }) };
    const suggested = suggestLinks(pins, [], near);
    assert.ok(suggested.some((item) => item.from === depot.id && item.to === shop.id) && !suggested.some((item) => item.from === site.id));
    assert.ok(suggested.some((item) => item.from === supplier.id && item.to === site.id));
});

test('candidate sites compared: what each changes a month against the network as it is, and whether it earns its keep', async () => {
    const { compareSites } = await import('../../packages/toolbox/lib/siteComparison.mjs');
    const asIs = { name: 'As it is', candidate: null, days: 60, running: 60000, fixedMonthly: 5000, lostNormal: 0, stress: { lostValue: 40000, storesOut: 4, longest: 6, running: 61000 } };
    const rows = compareSites([
        asIs,
        // Dearer to run (2,000 a month more in transport and 9,000 in rent), and a disruption costs 33,000 less with it.
        { name: 'With North', candidate: 'North', days: 60, running: 64000, fixedMonthly: 14000, openingCost: 120000, lostNormal: 0, stress: { lostValue: 7000, storesOut: 1, longest: 2, running: 66000 } },
        // Cheaper to run by 3,000 a month, rent included, with no cost to open given.
        { name: 'With South', candidate: 'South', days: 60, running: 50000, fixedMonthly: 7000, openingCost: null, lostNormal: 0, stress: { lostValue: 40000, storesOut: 4, longest: 6, running: 51000 } },
        { name: 'With East', candidate: 'East', error: 'East has no supplier linked to it.' }
    ]);
    assert.deepEqual(rows.map((row) => row.monthlyCost), [35000, 46000, 32000, undefined]);
    assert.deepEqual([rows[1].extraMonthly, rows[1].savedPerDisruption], [11000, 33000]);
    assert.equal(rows[0].verdict, 'The network as it is.');
    assert.equal(rows[1].verdict, 'Dearer to run by 11,000 a month, and one such disruption costs 33,000 less with it: it pays for its running if one comes more often than once every 3 months. Its cost to open, 120,000, is back after 3.6 such disruptions.');
    assert.equal(rows[2].verdict, 'Cheaper to run by 3,000 a month. Give its cost to open to see how long that takes to earn back.');
    assert.equal(rows[3].verdict, 'Could not be compared: East has no supplier linked to it.');
    // In normal weeks alone, a dearer site has nothing to show for itself yet; a cheaper one pays back in months.
    const calm = compareSites([{ ...asIs, stress: null }, { ...rows[1], stress: null }, { name: 'With South', candidate: 'South', days: 60, running: 50000, fixedMonthly: 7000, openingCost: 60000, lostNormal: 0, stress: null }]);
    assert.equal(calm[1].verdict, 'Dearer to run by 11,000 a month in normal weeks: choose a disruption to see what it saves then.');
    assert.equal(calm[2].verdict, 'Cheaper to run by 3,000 a month. Its cost to open, 60,000, is back after 20 months.');
    // A site that makes the disruption worse says so.
    const worse = compareSites([asIs, { name: 'With West', candidate: 'West', days: 60, running: 60000, fixedMonthly: 5000, stress: { lostValue: 46000, storesOut: 5, longest: 7, running: 61000 } }]);
    assert.equal(worse[1].verdict, 'As dear to run, but one such disruption costs 6,000 more with it.');
});
