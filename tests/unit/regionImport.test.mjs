/* Copyright © 2026 Zenin Easa Panthakkalakath */

import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSelection, discoverRegion, parsePopulation } from '../../packages/toolbox/lib/discovery.mjs';
import { distance, ringArea } from '../../packages/toolbox/lib/geo.mjs';
import { maximumSplitDepth, overpassQueries, overpassRequests, overpassUrl, readOverpass, retryableStatus, splitBbox, splitRequest } from '../../packages/toolbox/lib/overpass.mjs';
import { nominatimSearchUrl, rankPlaces } from '../../packages/toolbox/lib/places.mjs';
import { buildRegionModel } from '../../packages/toolbox/lib/regionModel.mjs';
import { createRouter } from '../../packages/toolbox/lib/roadGraph.mjs';
import { parseSites } from '../../packages/toolbox/lib/sites.mjs';
import { loadTemplates, ModelBuilder } from '../../scripts/templatePlacement.mjs';
import { syntheticBbox, syntheticRegion } from '../fixtures/syntheticRegion.mjs';

const templates = await loadTemplates();
const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);

test('distances and areas on the sphere are accurate enough for a region', () => {
    close(distance({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 111195, 10, 'one degree of latitude');
    const square = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.008993 }, { lat: 0.008993, lon: 0.008993 }, { lat: 0.008993, lon: 0 }, { lat: 0, lon: 0 }];
    close(ringArea(square), 1e6, 2000, 'a 1 km square');
});

test('each kind of infrastructure is its own query, sent as a GET address to Overpass', () => {
    const queries = overpassQueries(syntheticBbox);
    assert.deepEqual(Object.keys(queries).sort(), ['logistics', 'places', 'ports', 'rail', 'roads']);
    for (const query of Object.values(queries)) {
        assert.match(query, /^\[out:json\]/);
        assert.ok(query.includes(`(${syntheticBbox.south},${syntheticBbox.west},${syntheticBbox.north},${syntheticBbox.east})`));
        const url = new URL(overpassUrl(query));
        assert.equal(url.hostname, 'overpass-api.de');
        assert.equal(url.searchParams.get('data'), query);
    }
});

test('an Overpass answer is read into features with a point, and outlines where given', () => {
    const features = readOverpass({ elements: [
        { type: 'node', id: 1, lat: 1, lon: 2, tags: { place: 'town' } },
        { type: 'way', id: 2, tags: { building: 'warehouse' }, bounds: { minlat: 0, minlon: 0, maxlat: 0.002, maxlon: 0.004 } },
        { type: 'way', id: 3, tags: {}, nodes: [7, 8, 9, 7], geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 0, lon: 0 }] },
        { type: 'relation', id: 4, tags: { landuse: 'industrial' }, members: [{ type: 'way', ref: 5, role: 'outer', geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 1, lon: 0 }, { lat: 0, lon: 0 }] }] },
        { type: 'way', id: 6, tags: {} }
    ] });
    assert.deepEqual(features.map((feature) => feature.osmId), [1, 2, 3, 4]);
    assert.deepEqual(features[1].point, { lat: 0.001, lon: 0.002 });
    assert.ok(features[2].ring && !features[2].line);
    assert.equal(features[3].rings.length, 1);
    assert.throws(() => readOverpass('{"remark":"runtime error"}'), /not an Overpass answer/);
});

test('populations are read as OpenStreetMap writes them, or not at all', () => {
    assert.equal(parsePopulation('40 000'), 40000);
    assert.equal(parsePopulation('1,250,000'), 1250000);
    assert.equal(parsePopulation('about 5000'), null);
    assert.equal(parsePopulation(undefined), null);
});

test('discovery finds the commercial ports, leaves out marinas, and counts anchorages', () => {
    const { candidates, coverage } = discoverRegion(syntheticRegion());
    assert.deepEqual(candidates.ports.map((port) => port.name), ['Port Alder', 'Birch Harbour']);
    const alder = candidates.ports[0];
    assert.equal(alder.parts, 3, 'the two terminals and the harbour mark are one port');
    assert.equal(alder.anchorages, 1);
    assert.ok(alder.commercial);
    assert.equal(coverage.ports.marinasExcluded, 2);
});

test('warehouses are grouped into logistics zones named after their estate, ranked by floor area and road access', () => {
    const { candidates, coverage } = discoverRegion(syntheticRegion());
    assert.equal(coverage.warehouses.level, 'good');
    assert.equal(coverage.warehouses.largeParcelsWithWarehouse, 2);
    assert.equal(candidates.zones.length, 2, 'with warehouses well mapped, bare industrial land is not a zone');
    assert.equal(candidates.zones[0].name, 'Alder Industrial Park');
    assert.equal(candidates.zones[0].buildings, 5);
    assert.match(candidates.zones[1].name, /^Logistics zone 2 \(near /);
    assert.ok(candidates.zones[0].significance > candidates.zones[1].significance);
});

test('where no warehouses are mapped, industrial land stands in for them and the user is told', () => {
    const { candidates, coverage, notices } = discoverRegion(syntheticRegion({ warehouses: false }));
    assert.equal(coverage.warehouses.level, 'none');
    assert.equal(candidates.zones.length, 3, 'the three industrial estates, not the small parcel');
    assert.ok(candidates.zones.every((zone) => zone.floorAreaBasis === 'estimated'));
    assert.equal(candidates.zones[0].name, 'Alder Industrial Park');
    const notice = notices.find((item) => item.kind === 'warehouses');
    assert.equal(notice.level, 'warning');
    assert.match(notice.text, /No warehouses are mapped in this region, across 5\.4 km² of industrial land\. The model groups industrial areas into logistics zones instead/);
});

test('towns rank by population, and a missing population is assumed and said so', () => {
    const { candidates, notices } = discoverRegion(syntheticRegion());
    assert.deepEqual(candidates.towns.map((town) => town.name), ['Cedarton', 'Dunmore', 'Elmwick']);
    assert.equal(candidates.towns[1].population, 40000);
    assert.equal(candidates.towns[2].populationBasis, 'assumed');
    assert.ok(notices.some((notice) => notice.kind === 'towns' && /missing for 1 of 3/.test(notice.text)));
    assert.ok(notices.some((notice) => notice.kind === 'roads' && /2 separate networks/.test(notice.text)));
});

test('routes follow the major roads, and a site far from them gets a straight-line estimate', () => {
    const { roadGraph, candidates } = discoverRegion(syntheticRegion());
    const router = createRouter(roadGraph);
    const [alder, birch] = candidates.ports;
    const park = candidates.zones[0];
    const nearby = router.route(alder, park);
    assert.equal(nearby.basis, 'routed');
    assert.ok(nearby.kilometres < 12);
    const across = router.route(alder, birch);
    assert.equal(across.basis, 'routed');
    close(across.kilometres, 40, 5, 'Port Alder to Birch Harbour along the coast motorway');
    const remote = router.route(alder, { lat: -29.6, lon: -19.27 });
    const neighbour = router.route(park, { lat: park.lat + 0.01, lon: park.lon });
    assert.equal(neighbour.basis, 'local', 'a site a kilometre away is reached by local streets');
    assert.equal(remote.basis, 'straight-line', 'the road fragment there joins nothing');
    assert.equal(createRouter(null).route(alder, birch).basis, 'straight-line');
});

function regionModel(selectionChange = (selection) => selection, options) {
    const { candidates, roadGraph } = discoverRegion(syntheticRegion());
    const selection = selectionChange(defaultSelection(candidates));
    return { selection, ...buildRegionModel({ builder: new ModelBuilder(templates), selection, route: createRouter(roadGraph).route, options }) };
}

const townDemand = (served, town) => served.filter((item) => item.town === town).reduce((total, item) => total + item.demand, 0);

test('a curated region becomes a model in which every port ships what arrives and every town gets its share', () => {
    const { selection, document, lanes, served, provenance, parameterIndex } = regionModel();
    const supply = selection.ports.length * 100;
    close(served.reduce((total, item) => total + item.demand, 0), supply, 1e-9, 'demand equals what the ports hand inland');
    close(townDemand(served, 'Cedarton') / townDemand(served, 'Dunmore'), 250 / 40, 1e-9, 'demand follows population');
    for (const town of selection.towns) close(served.filter((item) => item.town === town.name).reduce((total, item) => total + item.share, 0), 1, 1e-12, `${town.name}'s shares add up to all of it`);
    for (const port of selection.ports) {
        const arrivals = provenance.find((entry) => entry.entity === port.name && entry.parameter === 'Containers handed inland').value;
        close(lanes.filter((lane) => lane.from === port.name).reduce((total, lane) => total + lane.rate, 0), arrivals, 1e-6, `${port.name} ships its arrivals`);
    }
    for (const zone of new Set(served.map((item) => item.zone))) {
        close(lanes.filter((lane) => lane.to === zone).reduce((total, lane) => total + lane.rate, 0), served.filter((item) => item.zone === zone).reduce((total, item) => total + item.demand, 0), 1e-6, `${zone} receives its towns' demand`);
    }
    const zones = new Set(served.map((item) => item.zone)).size;
    assert.equal(document.nodes.length, selection.ports.length + zones + lanes.length + selection.towns.length);
    assert.equal(document.edges.length, 6 * lanes.length + 3 * served.length, 'six edges a lane, three a delivery');
    assert.equal(document.runConfigurations[0].globalTimeStep, 900, '15-minute steps');
    assert.equal(document.runConfigurations[0].outputInterval, 3600, 'hourly outputs');
    for (const lane of lanes) {
        assert.equal(lane.basis, 'routed');
        const travel = provenance.find((entry) => entry.entity === lane.name && entry.parameter === 'Travel time');
        assert.equal(travel.basis, 'routed');
        assert.ok(parameterIndex.some((entry) => entry.key === 'fleetSize' && entry.entity === lane.name));
    }
    assert.ok(provenance.filter((entry) => entry.parameter === 'Containers handed inland').every((entry) => entry.basis === 'assumed'));
    assert.ok(parameterIndex.some((entry) => entry.key === 'berthCapacity' && entry.entity === 'Port Alder'));
});

test('until port activity is matched, the assumed volume is shared by port land, with a floor for small harbours', () => {
    const { provenance } = regionModel();
    const volume = (port) => provenance.find((entry) => entry.entity === port && entry.parameter === 'Containers handed inland');
    // Port Alder has 1.975 km² of port land, Birch Harbour 0.399 km²: 200 TEU/day shared 1.975 : 0.399.
    close(volume('Port Alder').value, 200 * 1.975 / (1.975 + 0.399), 0.5, 'Port Alder');
    close(volume('Birch Harbour').value + volume('Port Alder').value, 200, 1e-9, 'the total');
    assert.match(volume('Birch Harbour').detail, /shared by port land \(0\.4 km²\)/);
    // A harbour mapped as a point counts as a tenth of the largest.
    const pointHarbour = regionModel((selection) => ({ ...selection, ports: [...selection.ports, { id: 'added:quay', name: 'Small Quay', lat: -29.99, lon: -19.7 }] }));
    const quay = pointHarbour.provenance.find((entry) => entry.entity === 'Small Quay' && entry.parameter === 'Containers handed inland');
    close(quay.value, 300 * 0.1975 / (1.975 + 0.399 + 0.1975), 0.5, 'a point harbour');
    assert.match(quay.detail, /counted as a tenth of the largest/);
});

test('a town draws on several nearby zones, each taking a share of its demand, and small shares go to its main zone', () => {
    const { served, document, lanes } = regionModel();
    const towns = new Set(served.map((item) => item.town));
    assert.ok([...towns].some((town) => served.filter((item) => item.town === town).length > 1), 'at least one town is served by more than one zone');
    for (const item of served) assert.ok(item.demand >= 1 || served.filter((other) => other.town === item.town).length === 1, `${item.town} from ${item.zone}: ${item.demand} TEU/day is worth its own deliveries`);
    // Each delivery carries its share of the town's demand; for each town they add up to 1.
    const shares = document.sharedParameters.filter((shared) => shared.symbol.startsWith('demandShare'));
    assert.equal(shares.length, served.length);
    close(shares.reduce((total, shared) => total + shared.value, 0), towns.size, 1e-12, 'one whole town per town');
    for (const lane of lanes) assert.ok(lane.rate >= 2 || lanes.filter((other) => other.to === lane.to).length === 1 || lanes.filter((other) => other.from === lane.from).length === 1, `${lane.name} carries ${lane.rate} TEU/day`);
});

test('moving a site changes its lanes\' travel times and distances', () => {
    const before = regionModel();
    const zone = before.selection.zones[1].name;
    const after = regionModel((selection) => ({ ...selection, zones: selection.zones.map((item, index) => (index === 1 ? { ...item, lat: item.lat - 0.05 } : item)) }));
    const laneBefore = before.lanes.find((lane) => lane.to === zone && lane.from === 'Port Alder');
    const laneAfter = after.lanes.find((lane) => lane.to === zone && lane.from === 'Port Alder');
    assert.ok(laneBefore && laneAfter, 'the zone is supplied from Port Alder before and after');
    assert.ok(laneAfter.kilometres < laneBefore.kilometres - 3, `${laneAfter.kilometres} km after, ${laneBefore.kilometres} km before`);
    assert.ok(laneAfter.leadTime < laneBefore.leadTime);
});

test('a port with the user\'s own volume keeps it, and demand grows to match', () => {
    const { served, provenance } = regionModel((selection) => ({ ...selection, ports: selection.ports.map((port, index) => (index === 0 ? { ...port, teuPerDay: 300 } : port)) }));
    close(served.reduce((total, item) => total + item.demand, 0), 400, 1e-9, 'total demand');
    assert.equal(provenance.find((entry) => entry.entity === 'Port Alder' && entry.parameter === 'Containers handed inland').basis, 'user');
});

test('a zone that serves none of the kept towns is left out, and the user is told', () => {
    const { warnings, served } = regionModel((selection) => ({ ...selection, zones: [...selection.zones, { id: 'added:far', name: 'Far Depot', lat: -29.2, lon: -18.9 }] }));
    assert.ok(!served.some((item) => item.zone === 'Far Depot'));
    assert.ok(warnings.some((warning) => /^Far Depot serves none of the kept towns/.test(warning)));
});

test('a model cannot be built without a port, a zone and a town', () => {
    assert.throws(() => regionModel((selection) => ({ ...selection, ports: [] })), /at least one port/);
    assert.throws(() => regionModel((selection) => ({ ...selection, zones: [] })), /at least one logistics zone/);
    assert.throws(() => regionModel((selection) => ({ ...selection, towns: [] })), /at least one town/);
});

test('a CSV of the user\'s own sites is read with loose headers, and bad lines are named', () => {
    const good = parseSites('Name;Type;Lat;Lng;TEU/day;Floor area\nHarbour terminal;port;-29.99;-19.8;420;\n"Depot, north";depot;-29.8;-19.7;;18 000\nShops;customer;-29.75;-19.6;35;\n');
    assert.deepEqual(good.errors, []);
    assert.equal(good.sites.ports[0].teuPerDay, 420);
    assert.equal(good.sites.zones[0].name, 'Depot, north');
    assert.equal(good.sites.zones[0].floorAreaSquareMetres, 18000);
    assert.equal(good.sites.towns[0].teuPerDay, 35);
    const bad = parseSites('name,kind,latitude,longitude\n,port,1,2\nA,shipyard,1,2\nB,port,95,2\n');
    assert.deepEqual(bad.errors, [
        'Line 2: the site has no name.',
        'Line 3: "shipyard" is not a kind of site. Use port, warehouse or customer.',
        'Line 4: B needs a latitude between -90 and 90 and a longitude between -180 and 180.'
    ]);
    assert.deepEqual(parseSites('name,latitude\nA,1').errors, ['The header has no kind column.', 'The header has no longitude column.']);
});

test('the user\'s own sites join the curated region and are used as given', () => {
    const { sites } = parseSites('name,kind,latitude,longitude,teuPerDay\nOur depot,warehouse,-29.9,-19.6,\nBig customer,customer,-29.88,-19.62,50\n');
    const { served, provenance } = regionModel((selection) => ({ ...selection, zones: [...selection.zones, ...sites.zones], towns: [...selection.towns, ...sites.towns] }));
    close(townDemand(served, 'Big customer'), 50, 1e-9, 'the customer\'s own demand');
    const main = served.filter((item) => item.town === 'Big customer').sort((a, b) => b.demand - a.demand)[0];
    assert.equal(main.zone, 'Our depot', 'mostly from the depot next door');
    assert.equal(provenance.find((entry) => entry.entity === 'Big customer' && entry.parameter === 'Demand').basis, 'user');
});

// ---- lessons from real data: what the first real region (a stretch of the Gulf coast) showed ------------

const answer = (elements) => ({ elements });
const square = (lat, lon, size = 0.01) => [
    { lat, lon }, { lat, lon: lon + size }, { lat: lat + size, lon: lon + size }, { lat: lat + size, lon }, { lat, lon }
];
let nextId = 90000;
const areaWay = (lat, lon, tags, size) => ({ type: 'way', id: nextId++, tags, geometry: square(lat, lon, size) });
const node = (lat, lon, tags) => ({ type: 'node', id: nextId++, lat, lon, tags });

test('names are English where OpenStreetMap has them, and a port takes its name from its Wikipedia article', () => {
    const { candidates } = discoverRegion({
        ports: answer([
            areaWay(10, 10, { landuse: 'industrial', industrial: 'port', name: 'ميناء ١', 'name:en': 'Container Terminal 1', wikipedia: 'en:Port of Example' }, 0.02),
            areaWay(10, 10.021, { landuse: 'industrial', industrial: 'port', name: 'ميناء ٢', 'name:en': 'Container Terminal 2' }, 0.03)
        ]),
        places: answer([node(10.2, 10.2, { place: 'town', name: 'مدينة', 'name:en': 'Example Town', population: '5000' })])
    });
    assert.equal(candidates.ports[0].name, 'Port of Example');
    assert.equal(candidates.towns[0].name, 'Example Town');
});

test('passenger harbours and administrative areas are not ports, and unnamed scraps of port land are dropped', () => {
    const { candidates, coverage } = discoverRegion({ ports: answer([
        areaWay(10, 10, { industrial: 'port', name: 'Real Port' }, 0.02),
        node(10.3, 10.3, { amenity: 'ferry_terminal', harbour: 'yes', public_transport: 'station', name: 'Water Bus Stop' }),
        node(10.35, 10.3, { harbour: 'yes', 'seamark:harbour:category': 'passenger', name: 'Ferry Pier' }),
        { type: 'relation', id: nextId++, tags: { boundary: 'administrative', industrial: 'port', name: 'Free Zone' }, members: [{ type: 'way', ref: 1, role: 'outer', geometry: square(9.9, 9.9, 0.3) }] },
        areaWay(10.6, 10.6, { landuse: 'port' }, 0.001),
        node(10.8, 10.8, { harbour: 'yes', name: 'Small Named Port' })
    ]) });
    assert.deepEqual(candidates.ports.map((port) => port.name), ['Real Port', 'Small Named Port']);
    assert.equal(coverage.ports.marinasExcluded, 2);
    assert.ok(candidates.ports[0].areaSquareKilometres < 5, 'the free zone does not inflate the port');
});

test('industrial land that is not logistics is left out, by its tags or its name, and port land is not a zone', () => {
    const { candidates, coverage, notices } = discoverRegion({ logistics: answer([
        areaWay(10, 10, { landuse: 'industrial', name: 'Example Industrial Area 1' }, 0.02),
        areaWay(10.1, 10.1, { landuse: 'industrial', man_made: 'water_works', 'name:en': 'Example Water Works' }, 0.02),
        areaWay(10.2, 10.2, { landuse: 'industrial', industrial: 'gas' }, 0.02),
        areaWay(10.3, 10.3, { landuse: 'industrial', 'name:en': 'Example Power and Desalination Plant' }, 0.02),
        areaWay(10.4, 10.4, { landuse: 'industrial', 'name:en': 'Example Aluminium Smelter' }, 0.02),
        areaWay(10.5, 10.5, { landuse: 'industrial', industrial: 'port', name: 'Port Logistics Terminal' }, 0.02)
    ]) });
    assert.deepEqual(candidates.zones.map((zone) => zone.name), ['Example Industrial Area 1']);
    assert.equal(coverage.warehouses.otherIndustryExcluded, 4);
    assert.ok(notices.some((item) => /4 industrial sites that are not logistics/.test(item.text)));
});

test('a warehouse district mapped as land counts a share of its land as floor area, not all of it', () => {
    const { candidates } = discoverRegion({ logistics: answer([
        areaWay(10, 10, { landuse: 'industrial', industrial: 'warehouse', name: 'Warehouse District' }, 0.01)
    ]) });
    const zone = candidates.zones[0];
    const land = ringArea(square(10, 10, 0.01));
    close(zone.floorAreaSquareMetres, land * 0.3, land * 0.01, 'floor area');
});

test('mapped warehouses rank ahead of industrial land standing in for them', () => {
    const { candidates } = discoverRegion({ logistics: answer([
        areaWay(10, 10, { landuse: 'industrial', name: 'Big Estate' }, 0.02),
        areaWay(10.02, 10.02, { landuse: 'industrial', name: 'Big Estate B' }, 0.02),
        areaWay(10.04, 10.04, { landuse: 'industrial', name: 'Big Estate C' }, 0.02),
        areaWay(10.5, 10.5, { landuse: 'industrial', name: 'Depot Park' }, 0.012),
        ...[0, 1, 2].map((index) => ({ type: 'way', id: nextId++, tags: { building: 'warehouse' }, bounds: { minlat: 10.501 + index * 0.002, minlon: 10.501, maxlat: 10.502 + index * 0.002, maxlon: 10.504 } }))
    ]) });
    // Coverage is partial (one of four estates has warehouses), so the bare estate stands in, at lower confidence.
    const estimated = candidates.zones.find((zone) => zone.floorAreaBasis === 'estimated');
    const mapped = candidates.zones.find((zone) => zone.floorAreaBasis !== 'estimated');
    assert.ok(estimated && mapped);
    assert.ok(estimated.floorAreaSquareMetres * 0.5 === estimated.significance || estimated.significance < estimated.floorAreaSquareMetres, 'estimated zones are discounted');
});

test('heavy kinds are fetched in tiles no wider than 40 km, and tiles are merged without double counting', () => {
    const bbox = { south: 24.6, west: 54.7, north: 25.34, east: 55.49 };
    const requests = overpassRequests(bbox);
    const count = (kind) => requests.filter((request) => request.kind === kind).length;
    assert.equal(count('roads'), 6, '82 km tall and 80 km wide at 25 degrees north: three rows of two tiles');
    assert.equal(count('logistics'), 6);
    for (const kind of ['ports', 'rail', 'places']) assert.equal(count(kind), 1);
    for (const tile of splitBbox(bbox)) {
        assert.ok((tile.north - tile.south) * 111.32 <= 40.01);
        assert.ok((tile.east - tile.west) * 111.32 * Math.cos(25 * Math.PI / 180) <= 40.01);
    }
    const shared = { type: 'way', id: 7, tags: { highway: 'primary' }, nodes: [1, 2], geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }] };
    const features = readOverpass([answer([shared, node(1, 1, { place: 'town' })]), answer([shared])]);
    assert.equal(features.length, 2);
});

test('a busy public server is retried, anything else is not', () => {
    for (const status of [429, 502, 503, 504]) assert.ok(retryableStatus(status), `${status}`);
    for (const status of [400, 403, 404, 500]) assert.ok(!retryableStatus(status), `${status}`);
});

test('a place search puts places and areas ahead of shops that share the name, and asks for English names', () => {
    const ranked = rankPlaces([
        { display_name: 'Life Pharmacy, Jebel Ali', category: 'amenity', type: 'pharmacy', importance: 0.2, boundingbox: ['1', '2', '3', '4'] },
        { display_name: 'Jebel Ali Industrial Area', category: 'landuse', type: 'industrial', importance: 0.3, boundingbox: ['1', '2', '3', '4'] },
        { display_name: 'Jebel Ali', category: 'place', type: 'suburb', importance: 0.4, boundingbox: ['1', '2', '3', '4'] },
        { display_name: 'Jabal Ali (peak)', category: 'natural', type: 'peak', importance: 0.5, boundingbox: ['1', '2', '3', '4'] },
        { display_name: 'No box', category: 'place', type: 'town', importance: 0.9 }
    ]);
    assert.deepEqual(ranked.map((place) => place.display_name), ['Jebel Ali', 'Jebel Ali Industrial Area', 'Jabal Ali (peak)', 'Life Pharmacy, Jebel Ali']);
    assert.match(nominatimSearchUrl('Jebel Ali'), /accept-language=en/);
});

test('a tile too large for the host is fetched again as four quarters, at most twice over', () => {
    const [roads] = overpassRequests({ south: 25.0, west: 55.0, north: 25.3, east: 55.3 }).filter((request) => request.kind === 'roads');
    const quarters = splitRequest(roads);
    assert.deepEqual(quarters.map((request) => request.part), ['1.1', '1.2', '1.3', '1.4']);
    assert.ok(quarters.every((request) => request.depth === 1 && request.kind === 'roads' && request.query.includes('"highway"')));
    const area = (box) => (box.north - box.south) * (box.east - box.west);
    close(quarters.reduce((total, request) => total + area(request.bbox), 0), area(roads.bbox), 1e-12, 'the quarters cover the tile');
    assert.equal(splitRequest(quarters[0])[3].part, '1.1.4');
    assert.equal(maximumSplitDepth, 2);
});

test('a city with mapped suburbs becomes demand areas across it, and its population is spread without counting twice', () => {
    const city = node(20, 20, { place: 'city', name: 'Bigport', population: '1000000' });
    // West side: three suburbs close together, one with its own population. East side: two more, 15 km away.
    const west = [node(20.01, 19.95, { place: 'suburb', name: 'Westbank', population: '300000' }), node(20.02, 19.96, { place: 'suburb', name: 'Old Quarter' }), node(20.0, 19.965, { place: 'quarter', name: 'Harbourside' })];
    const east = [node(20.0, 20.12, { place: 'suburb', name: 'Eastfield' }), node(20.01, 20.13, { place: 'suburb', name: 'Newtown' })];
    const far = node(21.5, 21.5, { place: 'suburb', name: 'Far Suburb', population: '30000' });
    const lonely = node(21.6, 21.6, { place: 'suburb', name: 'Unpopulated Suburb' });
    const town = node(20.5, 20.5, { place: 'town', name: 'Smalltown', population: '40000' });
    const { candidates, notices, coverage } = discoverRegion({ places: answer([city, ...west, ...east, far, lonely, town]) });
    const areas = candidates.towns.filter((item) => item.city === 'Bigport');
    assert.equal(areas.length, 2, 'two areas: west and east');
    // 1,000,000 people: Westbank's own 300,000, and the other 700,000 shared evenly by the four suburbs without a figure.
    const westArea = areas.find((item) => item.suburbs.includes('Westbank'));
    const eastArea = areas.find((item) => item.suburbs.includes('Eastfield'));
    assert.equal(westArea.population, 300000 + 2 * 175000);
    assert.equal(eastArea.population, 2 * 175000);
    assert.equal(westArea.name, 'Bigport: Westbank, Harbourside and 1 more');
    assert.equal(westArea.populationBasis, 'shared', '350,000 of its 650,000 are an even share of the city');
    assert.equal(eastArea.populationBasis, 'shared', 'an even share of the city');
    assert.ok(!candidates.towns.some((item) => item.name === 'Bigport'), 'the city itself is not counted again');
    assert.ok(candidates.towns.some((item) => item.name === 'Far Suburb' && item.population === 30000), 'a populated suburb far from any settlement is a place of its own');
    assert.ok(!candidates.towns.some((item) => item.name === 'Unpopulated Suburb'));
    assert.ok(candidates.towns.some((item) => item.name === 'Smalltown'), 'a town with no mapped suburbs stays one point');
    assert.deepEqual(coverage.towns.spread, [{ name: 'Bigport', suburbs: 5, areas: 2 }]);
    assert.ok(notices.some((item) => /^Bigport's 1,000,000 people are spread over 2 areas of its 5 mapped suburbs; for 4 suburbs without a population, how many live in each is assumed/.test(item.text)));
});

test('demand areas take their share of demand in the model, labelled as an even share of the city', () => {
    const builder = new ModelBuilder(templates);
    const discovered = discoverRegion({
        ...syntheticRegion(),
        places: answer([
            node(-29.74, -19.7, { place: 'city', name: 'Cedarton', population: '250000' }),
            node(-29.745, -19.71, { place: 'suburb', name: 'North End' }), node(-29.75, -19.72, { place: 'suburb', name: 'Mill Lane' }),
            node(-29.80, -19.60, { place: 'suburb', name: 'River Side' })
        ])
    });
    const built = buildRegionModel({ builder, selection: defaultSelection(discovered.candidates), route: createRouter(discovered.roadGraph).route });
    const areas = [...new Set(built.served.map((item) => item.town))];
    assert.equal(areas.length, 2);
    const note = built.provenance.find((entry) => entry.parameter === 'Demand' && entry.entity.startsWith('Cedarton: '));
    assert.match(note.detail, /an even share of Cedarton's population among its suburbs, an assumption/);
});
