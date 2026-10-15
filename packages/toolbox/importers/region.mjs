/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The region importer, in the steps the window drives. Every step reads the files again, so the importer holds
// no state between them.
//
//   roads: reads the roads and place names alone and returns the map to draw and the road graph, compacted,
//     for the window to route with; with railways and water fetched, those drawn too and the railways' and the
//     navigable waterways' graphs, for links by rail and by water. Nothing else is discovered: the user places the
//     network.
//   discover with `sources` (ports, warehouses, towns): the suggestions the user asked for, from the answers
//     fetched for them, with their coverage and notices and the map layers that show them.
//   sites: reads a CSV of the user's own sites, for the window to place as pins.
//   buildNetwork: takes the network placed on the map (pins by group, an adopted one by the candidate it came
//     from, and the links with the legs the window routed) and returns the model.
//
// And the steps of the earlier curation workflow, kept for the live region check and the engine tests:
//
//   discover (the default, with no `sources`): every candidate, the coverage report and a simplified map.
//   build: takes a curated selection ({ ports, zones, towns }, each an id of a candidate or of one of the user's
//     sites, with any changes the user made) and returns the model, linked by gravity.

import { discoverRegion, parsePopulation } from '../lib/discovery.mjs';
import { holidaysForModel } from '../lib/holidays.mjs';
import { portwatchAttribution } from '../lib/portwatch.mjs';
import { tilesFor } from '../lib/geography.mjs';
import { geographyAttribution, geographyLayers, linesLayers, mapLayers } from '../lib/mapData.mjs';
import { buildLineGraph, isRunningLine, waterOf } from '../lib/modes.mjs';
import { ModelBuilder } from '../lib/modelBuilder.mjs';
import { buildRegionModel, regionModelDefaults } from '../lib/regionModel.mjs';
import { generateOperator, parseOperator } from '../lib/operator.mjs';
import { parseTravelTimes } from '../lib/travelTimes.mjs';
import { maximumCityKilometres, readOverpass } from '../lib/overpass.mjs';
import { extractAnswers, extractBounds, extractHeader, extractPlaces, mergeReads, orderPlaces, readExtract } from '../lib/osmPbf.mjs';
import { mapsCovering, readMapIndex } from '../lib/mapServers.mjs';
import { listed } from '../lib/categories.mjs';
import { createRouter } from '../lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../lib/routing.mjs';
import { parseSites } from '../lib/sites.mjs';

export const osmRoles = ['ports', 'logistics', 'roads', 'rail', 'water', 'places'];
// IMF PortWatch: the ports around the region, and the history of each matched port.
export const portwatchRoles = ['portwatchPorts', 'portwatchActivity'];
export const templateIds = ['port', 'roadLane', 'railLane', 'warehouse', 'demandZone', 'roadShipment', 'railShipment', 'delivery', 'storeShipment', 'supplier', 'supplierShipment', 'maker', 'makerFeed'];
const kinds = { ports: 'port', zones: 'zone', towns: 'town' };
// The suggestions the user can ask for: the OpenStreetMap answers each reads (beside the roads and place names every
// step reads), and the group of candidates it shows.
export const suggestionSources = {
    ports: { kinds: ['ports', 'portwatchPorts', 'portwatchActivity'], group: 'ports' },
    warehouses: { kinds: ['logistics'], group: 'zones' },
    towns: { kinds: [], group: 'towns' }
};
const baseKinds = ['roads', 'places'];
// What the roads step may send the window (the host accepts up to 8 MB from an importer).
export const maximumRoadsBytes = 7 * 1024 * 1024;

const failure = (message) => ({ ok: false, report: { errors: [message], warnings: [] } });

// The region the answers cover: from the window's options, or else the extent of what they hold.
function regionBounds(options, discovered) {
    const bbox = options.bbox;
    if (bbox && ['south', 'west', 'north', 'east'].every((key) => Number.isFinite(bbox[key]))) return bbox;
    const points = [...discovered.candidates.ports, ...discovered.candidates.zones, ...discovered.candidates.towns];
    if (!points.length) return { south: -1, west: -1, north: 1, east: 1 };
    const south = Math.min(...points.map((point) => point.lat));
    const north = Math.max(...points.map((point) => point.lat));
    const west = Math.min(...points.map((point) => point.lon));
    const east = Math.max(...points.map((point) => point.lon));
    const pad = 0.15 * Math.max(north - south, east - west, 0.01);
    return { south: south - pad, north: north + pad, west: west - pad, east: east + pad };
}

// A pin of the user's network: the candidate it was adopted from, by id, with the user's changes; or a site of the
// user's own, given in full. A figure is taken from the pin when the user set it, or when the site has none of its own.
function resolvePin(entry, known, kind) {
    const base = known.get(entry.id);
    const site = { ...(base ?? { id: entry.id, kind, user: true, source: 'placed on the map' }) };
    for (const key of ['name', 'lat', 'lon']) site[key] = entry[key];
    if (entry.role) site.role = entry.role;
    if (entry.supplier) site.supplier = true;
    // A maker: its making (a source, `maker: true`, with its making time) or its store of what it uses (a zone, with its
    // recipe: what it uses and makes, how much of it for each unit, what it is set to make, and its making's id).
    if (entry.maker === true) site.maker = true;
    else if (entry.maker && typeof entry.maker === 'object') {
        const given = entry.maker;
        site.maker = {
            input: String(given.input ?? ''), output: String(given.output ?? ''), outputName: String(given.outputName ?? ''), port: String(given.port ?? ''),
            perUnit: Number(given.perUnit) > 0 ? Number(given.perUnit) : 0, makes: Number(given.makes) > 0 ? Number(given.makes) : 0, basis: given.basis === 'assumed' ? 'assumed' : 'user'
        };
    }
    if (entry.maker === true && Number(entry.leadDays) > 0) Object.assign(site, { leadDays: Number(entry.leadDays), leadDaysBasis: entry.leadDaysBasis === 'assumed' ? 'assumed' : 'user' });
    // A supplier's: the most it can make a day, and its own lead times by category; and any site's own mix of categories.
    if (Number(entry.makes) > 0) Object.assign(site, { makes: Number(entry.makes), makesBasis: entry.makesBasis === 'assumed' ? 'assumed' : 'user' });
    // The hours it keeps: when it is open, receives and dispatches, each from an hour to a later one on some days.
    if (entry.hours && typeof entry.hours === 'object') {
        const hours = {};
        for (const kind of ['open', 'receive', 'dispatch']) {
            const given = entry.hours[kind];
            const [from, to] = [Number(given?.from), Number(given?.to)];
            // An hour to another (past midnight too: 22 to 6), on a day at least.
            if (given && from >= 0 && from <= 24 && to >= 0 && to <= 24 && to !== from && Array.isArray(given.days) && given.days.length === 7 && given.days.some(Boolean)) hours[kind] = { from, to, days: given.days.map(Boolean) };
        }
        if (Object.keys(hours).length) site.hours = hours;
    }
    if (entry.mix && typeof entry.mix === 'object') site.mix = Object.fromEntries(Object.entries(entry.mix).map(([id, weight]) => [id, Math.max(0, Number(weight) || 0)]));
    if (entry.leadDaysBy && typeof entry.leadDaysBy === 'object') {
        site.leadDaysBy = Object.fromEntries(Object.entries(entry.leadDaysBy).filter(([, lead]) => Number(lead?.value) > 0).map(([id, lead]) => [id, { value: Number(lead.value), basis: 'user' }]));
    }
    const ours = (basis) => basis === 'user' || !base;
    if (Number(entry.teuPerDay) > 0 && ours(entry.teuPerDayBasis)) {
        Object.assign(site, {
            teuPerDay: Number(entry.teuPerDay), teuPerDayBasis: entry.teuPerDayBasis === 'assumed' ? 'assumed' : 'user',
            teuPerDaySource: entry.teuPerDayBasis === 'assumed' ? 'Assumed: the default for a supplier, until you set what it supplies.' : 'Entered in the window.'
        });
    }
    if (Number(entry.population) > 0 && ours(entry.populationBasis)) Object.assign(site, { population: Number(entry.population), populationBasis: entry.populationBasis ?? 'user' });
    if (Number(entry.floorAreaSquareMetres) > 0 && ours(entry.floorAreaBasis)) Object.assign(site, { floorAreaSquareMetres: Number(entry.floorAreaSquareMetres), floorAreaBasis: entry.floorAreaBasis === 'user' ? 'user' : entry.floorAreaBasis, ...(entry.floorAreaBasis === 'user' ? { significance: null } : {}) });
    // A warehouse's, store's or dark store's stock: its room, its cover and what holding a pallet costs, with where each
    // came from.
    for (const key of ['capacity', 'coverDays', 'holdingCost']) {
        if (Number(entry[key]) > 0) Object.assign(site, { [key]: Number(entry[key]), [`${key}Basis`]: entry[`${key}Basis`] === 'assumed' ? 'assumed' : 'user' });
    }
    // A store's: the share of the sales it cannot make that are lost (0 to 1, 0 a figure too), and what a pallet sold is worth.
    const lost = Number(entry.lostShare);
    if (entry.lostShare !== undefined && entry.lostShare !== null && lost >= 0 && lost <= 1) Object.assign(site, { lostShare: lost, lostShareBasis: entry.lostShareBasis === 'assumed' ? 'assumed' : 'user' });
    if (Number(entry.saleValue) > 0) Object.assign(site, { saleValue: Number(entry.saleValue), saleValueBasis: entry.saleValueBasis === 'assumed' ? 'assumed' : 'user' });
    if (base && (entry.lat !== base.lat || entry.lon !== base.lon)) site.moved = true;
    return site;
}

// A network's vehicle types as the window sends them, checked: each with a name and figures above nothing.
const vehicleKeys = ['capacity', 'costPerKm', 'costPerDay', 'speed', 'loadingHours'];
function checkedVehicles(types) {
    if (!Array.isArray(types) || !types.length) return null;
    return types.map((type) => {
        if (!type?.id || !String(type.name ?? '').trim()) throw new Error('A vehicle type has no name. Name it in the Vehicles list.');
        for (const key of vehicleKeys) if (!(Number(type[key]) > 0)) throw new Error(`${type.name}: its ${key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)} must be more than nothing.`);
        return {
            id: String(type.id), name: String(type.name).trim(), toStores: type.toStores !== false, refrigerated: type.refrigerated === true,
            // What it runs by: a train or a barge goes only on a link of its own mode.
            ...(type.mode === 'rail' || type.mode === 'water' ? { mode: type.mode } : {}),
            // The hours it runs, where it keeps any.
            ...(type.hours && Number(type.hours.from) >= 0 && Number(type.hours.to) <= 24 && Number(type.hours.to) !== Number(type.hours.from) && Array.isArray(type.hours.days) && type.hours.days.length === 7 && type.hours.days.some(Boolean)
                ? { hours: { from: Number(type.hours.from), to: Number(type.hours.to), days: type.hours.days.map(Boolean) } } : {}),
            ...Object.fromEntries(vehicleKeys.map((key) => [key, Number(type[key])])),
            basis: Object.fromEntries(vehicleKeys.map((key) => [key, type.basis?.[key] === 'user' ? 'user' : 'assumed']))
        };
    });
}

// A network's product categories as the window sends them, checked: each with a name, a share and a lead time.
function checkedCategories(categories) {
    if (!Array.isArray(categories) || !categories.length) return null;
    return categories.map((category) => {
        if (!category?.id || !String(category.name ?? '').trim()) throw new Error('A category has no name. Name it in the Categories list.');
        if (!(Number(category.share) > 0)) throw new Error(`${category.name}: its usual share must be more than nothing.`);
        if (!(Number(category.leadDays) > 0)) throw new Error(`${category.name}: its supplier lead time must be more than nothing.`);
        return {
            id: String(category.id), name: String(category.name).trim(), chilled: category.chilled === true, share: Number(category.share), leadDays: Number(category.leadDays),
            // How long its goods keep, when they keep only so long.
            shelfDays: Number(category.shelfDays) > 0 ? Number(category.shelfDays) : null,
            // And what a pallet of it sold is worth, when it has a value of its own.
            saleValue: Number(category.saleValue) > 0 ? Number(category.saleValue) : null,
            basis: { share: category.basis?.share === 'user' ? 'user' : 'assumed', leadDays: category.basis?.leadDays === 'user' ? 'user' : 'assumed', shelfDays: category.basis?.shelfDays === 'user' ? 'user' : 'assumed', saleValue: category.basis?.saleValue === 'user' ? 'user' : 'assumed' }
        };
    });
}

// The settings the window sends with a build, checked.
function buildSettings(options) {
    const settings = {};
    if (Number(options.settings?.portTeuPerDay) > 0) settings.portTeuPerDay = Number(options.settings.portTeuPerDay);
    if (['average', 'history'].includes(options.settings?.arrivals)) settings.arrivals = options.settings.arrivals;
    if (/^\d{4}-\d{2}-\d{2}$/.test(options.settings?.historyFrom ?? '')) settings.historyFrom = options.settings.historyFrom;
    const tonnes = Number(options.settings?.tonnesPerTeu);
    if (tonnes >= 1 && tonnes <= 40) settings.tonnesPerTeu = tonnes;
    const inland = Number(options.settings?.inlandShare);
    if (inland > 0 && inland <= 1) settings.inlandShare = inland;
    // Standby lanes from these ports (by name), for a scenario that diverts cargo to them.
    if (Array.isArray(options.settings?.standbyPorts)) settings.standbyPorts = options.settings.standbyPorts.map(String);
    // A network placed on the map runs on its own vehicle types, and counts pallets.
    const vehicles = checkedVehicles(options.network?.vehicles);
    if (vehicles) settings.vehicles = vehicles;
    if (options.network?.unit === 'pallets') settings.unit = 'pallets';
    const categories = checkedCategories(options.network?.categories);
    if (categories) settings.categories = categories;
    // The network's holidays and peaks, checked as the window checks them.
    const holidays = holidaysForModel(Array.isArray(options.network?.holidays) ? options.network.holidays : []);
    if (holidays.length) settings.holidays = holidays;
    // The user's times on some links, scaling the estimates on the rest (travelTimes.mjs): a factor within reason.
    const factor = Number(options.settings?.timeFactor?.factor);
    if (factor >= 0.1 && factor <= 10) settings.timeFactor = { factor, count: Math.max(0, Math.round(Number(options.settings.timeFactor.count) || 0)) };
    return settings;
}

// One kept site: a candidate or a site from the CSV, by id, with the user's changes; or a site the user
// added on the map, given in full.
function resolveSite(entry, known, kind) {
    const base = known.get(entry.id);
    if (!base && !(Number.isFinite(entry.lat) && Number.isFinite(entry.lon) && entry.name)) {
        throw new Error(`The site "${entry.name ?? entry.id}" is no longer in the data. Discover the region again.`);
    }
    const site = { ...(base ?? { id: entry.id, kind, user: true, source: 'added on the map' }) };
    for (const key of ['name', 'lat', 'lon']) if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') site[key] = entry[key];
    if (Number(entry.teuPerDay) > 0) Object.assign(site, { teuPerDay: Number(entry.teuPerDay), teuPerDayBasis: 'user', teuPerDaySource: 'Entered in the window.' });
    if (Number(entry.population) > 0) Object.assign(site, { population: Number(entry.population), populationBasis: 'user' });
    if (base && (entry.lat !== undefined && entry.lat !== base.lat || entry.lon !== undefined && entry.lon !== base.lon)) site.moved = true;
    return site;
}

// The bundled Natural Earth tiles the region touches; none where it is all sea, and nothing if the package has none.
async function loadGeography(helpers, bbox) {
    let index;
    try {
        index = await helpers.readPackageJson('geography/index.json');
    } catch {
        return null;
    }
    const present = new Set(index.tiles);
    const tiles = [];
    for (const name of tilesFor(bbox)) if (present.has(name)) tiles.push(await helpers.readPackageJson(`geography/${name}.json`));
    return geographyLayers(tiles, bbox);
}

async function loadTemplates(helpers) {
    const templates = new Map();
    for (const id of templateIds) templates.set(id, await helpers.readPackageJson(`templates/${id}.json`));
    return templates;
}

export default async function importRegion({ files, helpers, options = {} }) {
    const answers = {};
    let sitesText = null;
    let operatorText = null;
    let timesText = null;
    for (const file of files) {
        // A tiled kind arrives as several files, one per tile.
        if (osmRoles.includes(file.role) || portwatchRoles.includes(file.role)) (answers[file.role] ??= []).push(file.text);
        if (file.role === 'sites') sitesText = file.text;
        if (file.role === 'operator') operatorText = file.text;
        if (file.role === 'times') timesText = file.text;
    }
    // A file of the user's own travel times, read for the window to match to its links by site name.
    if (options.step === 'times') {
        if (timesText === null) return failure('Choose a file of your travel times first.');
        const parsed = parseTravelTimes(timesText);
        if (!parsed.rows.length) return { ok: false, report: { errors: parsed.errors.map((message) => `Your travel times file: ${message}`), warnings: [] } };
        return { ok: true, data: { step: 'times', rows: parsed.rows }, report: { errors: [], warnings: parsed.errors.map((message) => `Your travel times file: ${message}`) } };
    }
    if (options.step === 'sites') {
        if (sitesText === null) return failure('Choose a file of your own sites first.');
        const parsed = parseSites(sitesText);
        if (parsed.errors.length) return { ok: false, report: { errors: parsed.errors.map((message) => `Your sites file: ${message}`), warnings: parsed.warnings } };
        return { ok: true, data: { step: 'sites', sites: parsed.sites }, report: { errors: [], warnings: parsed.warnings } };
    }
    const extracts = files.filter((file) => file.role === 'extract' && file.data);
    if (options.step === 'extract') return extractStep(extracts, options, helpers);
    if (options.step === 'extractPlaces') return extractPlacesStep(extracts, helpers);
    // What the files kept say of themselves (their area and the date of their data), to show them by.
    if (options.step === 'describeExtracts') return describeExtractsStep(extracts);
    // Which of a server's extracts cover the area, from its index (fetched into the mapIndex role).
    if (options.step === 'mapsCovering') return mapsCoveringStep(files.find((file) => file.role === 'mapIndex'), options);
    if (options.step === 'roads') return roadsStep(answers, options, helpers);
    if (options.step === 'discover' && Array.isArray(options.sources)) return suggestionsStep(answers, options, helpers);
    if (options.step === 'buildNetwork') return buildNetworkStep(answers, options, helpers, operatorText);
    if (!Object.keys(answers).length && !sitesText) return failure('Fetch a region, use the sample region, or choose a file of your own sites first.');

    let discovered;
    try {
        discovered = discoverRegion(answers, options.bbox ? { bbox: options.bbox } : {});
    } catch (error) {
        return failure(error.message);
    }
    const sites = sitesText === null ? null : parseSites(sitesText);
    if (sites?.errors.length) return { ok: false, report: { errors: sites.errors.map((message) => `Your sites file: ${message}`), warnings: sites.warnings } };

    if (options.step !== 'build') {
        const bbox = regionBounds(options, discovered);
        const map = mapLayers(discovered.layers, bbox);
        if (answers.portwatchPorts) map.attribution = `${map.attribution} · ${portwatchAttribution}`;
        // Land, coast and borders under a real region (one the window fetched, with its box): the sample region and a
        // file of sites alone have no place on Earth to draw them around.
        if (options.bbox) {
            const geography = await loadGeography(helpers, bbox);
            if (geography) {
                map.geography = geography;
                map.attribution = `${map.attribution} · ${geographyAttribution}`;
            }
        }
        return {
            ok: true,
            data: {
                step: 'discover', candidates: discovered.candidates, coverage: discovered.coverage, notices: discovered.notices,
                sites: sites?.sites ?? { ports: [], zones: [], towns: [] }, map,
                defaults: { portTeuPerDay: regionModelDefaults.portTeuPerDay }
            },
            report: { errors: [], warnings: sites?.warnings ?? [] }
        };
    }

    const selection = {};
    try {
        for (const [group, kind] of Object.entries(kinds)) {
            const known = new Map([...discovered.candidates[group], ...(sites?.sites[group] ?? [])].map((site) => [site.id, site]));
            selection[group] = (options.selection?.[group] ?? []).map((entry) => resolveSite(entry, known, kind));
        }
        const templates = await loadTemplates(helpers);
        const route = createRouter(discovered.roadGraph).route;
        return await finishBuild({ templates, helpers, selection, route, links: null, options, operatorText, step: 'build' });
    } catch (error) {
        return failure(error.message);
    }
}

// The model from a selection with the fleet operator the window chose, and what the window shows of it.
async function finishBuild({ templates, helpers, selection, route, links, options, operatorText, step }) {
    const settings = buildSettings(options);
    const buildWith = (options) => buildRegionModel({ builder: new ModelBuilder(templates, helpers), selection, route, links, options });
    // A fleet operator: the user's own, from a file, or an invented one made for this model's lanes.
    if (options.settings?.operator === 'file') {
        if (operatorText === null) return failure('Choose a file of your fleet operator first.');
        try {
            settings.operator = parseOperator(operatorText);
        } catch (error) {
            return failure(`Your fleet operator file: ${error.message}`);
        }
        // Yours, unless the file itself says it is invented (as a saved synthetic operator does).
        settings.operator.synthetic = JSON.parse(operatorText).synthetic === true;
    } else if (options.settings?.operator === 'synthetic') {
        settings.operator = generateOperator(buildWith(settings), new Map(selection.ports.map((port) => [port.name, port])));
    }
    const built = buildWith(settings);
    const townsServed = new Set(built.served.map((item) => item.town)).size;
    const sources = selection.ports.filter((port) => port.supplier).length;
    // A link is one lane to the user, however many categories it carries: by road, or by rail or water, counted apart.
    const linksBy = (mode) => new Set(built.lanes.filter((lane) => (lane.mode ?? 'road') === mode).map((lane) => lane.link ?? lane.name)).size;
    const roadLanes = linksBy('road');
    const otherLanes = ['rail', 'water'].map((mode) => [linksBy(mode), mode]).filter(([count]) => count).map(([count, mode]) => `${count} lane${count === 1 ? '' : 's'} by ${mode}`).map((text) => `${text}, `).join('');
    const kinds = built.categories?.length > 1 ? `, each in ${built.categories.length} categories (${built.categories.map((category) => category.name).join(', ')})` : '';
    const what = step === 'buildNetwork'
        ? `${sources ? `${sources} supplier${sources === 1 ? '' : 's'}, ` : ''}${selection.ports.length - sources ? `${selection.ports.length - sources} port${selection.ports.length - sources === 1 ? '' : 's'}, ` : ''}${roadLanes} road lane${roadLanes === 1 ? '' : 's'}, ${otherLanes}${townsServed} store${townsServed === 1 ? '' : 's'} and customer area${townsServed === 1 ? '' : 's'} served${kinds}`
        : `${selection.ports.length} port${selection.ports.length === 1 ? '' : 's'}, ${roadLanes} road lane${roadLanes === 1 ? '' : 's'}, ${townsServed} town${townsServed === 1 ? '' : 's'} served`;
    const lanesByBasis = built.lanes.reduce((counts, lane) => ({ ...counts, [lane.basis]: (counts[lane.basis] ?? 0) + 1 }), {});
    return {
        ok: true,
        document: built.document,
        parameterIndex: built.parameterIndex,
        data: {
            step, lanes: built.lanes, served: built.served, provenance: built.provenance, warnings: built.warnings, histories: built.histories, ports: built.ports, days: built.days,
            operator: built.operator, towns: built.towns, stores: built.stores, deliveries: built.deliveries, unit: built.unit, perTeu: built.perTeu, vehicles: built.vehicles, categories: built.categories, trucking: built.trucking, standbyPorts: built.standbyPorts, corridors: built.corridors,
            unusedZones: built.unusedZones, unusedLinks: built.unusedLinks, nodes: built.document.nodes.length, edges: built.document.edges.length, lanesByBasis
        },
        report: {
            errors: [], warnings: built.warnings,
            summary: what
        }
    };
}

// Answers restricted to some kinds.
const only = (answers, kinds) => Object.fromEntries(Object.entries(answers).filter(([kind]) => kinds.includes(kind)));

// The box the map shows: the window's, or else the extent of the roads (the sample region).
function boundsOf(options, roadGraph, discovered) {
    if (options.bbox) return regionBounds(options, discovered);
    const points = roadGraph.mainVertices;
    if (!points.length) return regionBounds(options, discovered);
    const lats = points.map((point) => point.lat);
    const lons = points.map((point) => point.lon);
    const [south, north, west, east] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
    const pad = 0.1 * Math.max(north - south, east - west, 0.01);
    return { south: south - pad, north: north + pad, west: west - pad, east: east + pad };
}

// The widest area read from an extract: as for a fetch, 250 km for major roads and 40 km for a city's streets.
// What a file may be read for: city streets a hundred kilometres across, major roads a thousand (500 km around a place);
// the window then refuses roads beyond what it can take. Far more than a public server is asked for: the user's own
// computer reads the file. Kept in step with the window's (toolbox.mjs, maximumFileKilometres).
const maximumExtractKilometres = { major: 1000, city: 100 };
const maximumWholeKilometres = 250;
const spanKilometres = (bbox) => Math.max((bbox.north - bbox.south) * 111.32, (bbox.east - bbox.west) * 111.32 * Math.cos((bbox.north + bbox.south) / 2 * Math.PI / 180));

// Reads the roads and place names of an area out of an OpenStreetMap extract (a .osm.pbf file of the user's), and
// hands them back as the files a fetch from OpenStreetMap's server would have left: the host keeps those in the
// extract's place, and the roads step then reads them as it reads fetched ones. The area is the window's (a place
// searched), or else the whole of what the file says it covers, when that is small enough to load.
// How far a reading of several files has got, as the host is told it: each file its share by its size.
function readingProgress(helpers, files, what) {
    const total = files.reduce((sum, file) => sum + file.data.length, 0);
    let before = 0;
    return (file) => {
        const start = before;
        before += file.data.length;
        return (share) => helpers?.progress?.({ done: Math.round((start + share * file.data.length) / total * 1000), total: 1000, message: `${what} ${file.name}${files.length > 1 ? ` (${files.indexOf(file) + 1} of ${files.length})` : ''}` });
    };
}

async function extractStep(files, options, helpers) {
    if (!files.length) return failure('Choose an OpenStreetMap extract (a .osm.pbf file) first.');
    const { inflateSync } = await import('node:zlib');
    // Several extracts read as one map: a city on a border, its map in one extract for each country.
    const named = listed(files.map((file) => file.name));
    const one = files.length === 1;
    // 'auto' (no place searched, so no road level chosen either): a file of a city has its streets read, a file of a
    // region its major roads.
    let roadLevel = options.roadLevel === 'city' ? 'city' : 'major';
    let bbox = options.bbox && ['south', 'west', 'north', 'east'].every((key) => Number.isFinite(options.bbox[key])) ? options.bbox : null;
    let read;
    let skipped = [];
    let readFrom = named;
    try {
        const covers = files.map((file) => ({ file, covered: extractBounds(file.data, inflateSync) }));
        if (!bbox) {
            if (covers.some((item) => !item.covered)) return failure(`${covers.find((item) => !item.covered).file.name} does not say what area it covers: search a place first, and the roads around it are read from ${one ? 'the file' : 'the files'}.`);
            bbox = covers.reduce((area, { covered }) => ({ south: Math.min(area.south, covered.south), west: Math.min(area.west, covered.west), north: Math.max(area.north, covered.north), east: Math.max(area.east, covered.east) }), { south: 90, west: 180, north: -90, east: -180 });
        }
        const span = spanKilometres(bbox);
        if (options.roadLevel === 'auto') roadLevel = span <= maximumCityKilometres ? 'city' : 'major';
        // With no place chosen, a file is read whole only when it is a region's (as far as the public server would be
        // asked for): a country's would be a long read of more roads than the window can take, so its places are
        // offered instead, and the place chosen with as much around it as is wanted.
        if (!options.bbox && span > maximumWholeKilometres) {
            return failure(`${named} ${one ? 'covers an area that' : 'cover an area that together'} is ${Math.round(span).toLocaleString('en')} km across: more than is read whole (${maximumWholeKilometres} km). Search a place first, and the roads around it are read from ${one ? 'the file' : 'the files'}.`);
        }
        if (span > maximumExtractKilometres[roadLevel]) {
            return failure(`${options.bbox ? 'This area' : `${named} ${one ? 'covers an area that' : 'cover an area that together'}`} is ${Math.round(span).toLocaleString('en')} km across: ${roadLevel === 'city' ? `city streets are loaded for areas up to ${maximumExtractKilometres.city} km across` : `roads are loaded for areas up to ${maximumExtractKilometres.major} km across`}. ${options.bbox ? 'Choose a smaller area.' : `Search a place first, and the roads around it are read from ${one ? 'the file' : 'the files'}.`}`);
        }
        // A file that does not reach the area is not read; none reaching it is said, with what each covers.
        const meets = (covered) => !covered || !(bbox.north < covered.south || bbox.south > covered.north || bbox.east < covered.west || bbox.west > covered.east);
        const reaching = covers.filter((item) => meets(item.covered));
        if (!reaching.length) {
            return failure(`${one ? `${named} does not cover this area: it runs` : `None of ${named} covers this area: they run`} from ${covers.map(({ covered }) => `${covered.south.toFixed(2)}, ${covered.west.toFixed(2)} to ${covered.north.toFixed(2)}, ${covered.east.toFixed(2)}`).join('; and from ')}.`);
        }
        // Those left out are said: chosen with the others, and not read.
        skipped = covers.filter((item) => !meets(item.covered)).map(({ file, covered }) => `${file.name} does not reach this area (it runs from ${covered.south.toFixed(2)}, ${covered.west.toFixed(2)} to ${covered.north.toFixed(2)}, ${covered.east.toFixed(2)}), so it was not read.`);
        readFrom = listed(reaching.map(({ file }) => file.name));
        const progressOf = readingProgress(helpers, reaching.map(({ file }) => file), 'Reading the roads of');
        // Railways and water with the roads, as the server is asked for them: for links by rail and by water, and the
        // lakes and rivers drawn.
        read = mergeReads(reaching.map(({ file }) => {
            try { return readExtract(file.data, { bbox, roadLevel, inflate: inflateSync, onProgress: progressOf(file), layers: ['rail', 'water'] }); } catch (error) { throw new Error(`${file.name} could not be read: ${error.message}`); }
        }));
    } catch (error) {
        return failure(/could not be read/.test(error.message) ? error.message : `${named} could not be read: ${error.message}`);
    }
    if (!read.roads.length) return failure(`${named} ${one ? 'has' : 'have'} no ${roadLevel === 'city' ? 'roads' : 'major roads'} in this area.`);
    const answers = extractAnswers(read, { source: readFrom });
    return {
        ok: true,
        data: { step: 'extract', bbox, roadLevel, file: readFrom, files: files.map((file) => file.name), coverage: { roads: read.roads.length, places: read.places.length, rail: read.rail.length, water: read.water.length }, counts: read.counts },
        derived: [
            ...answers.roads.map((text, index) => ({ role: 'roads', name: `roads-extract-${index + 1}.json`, text, source: readFrom })),
            ...answers.rail.map((text, index) => ({ role: 'rail', name: `rail-extract-${index + 1}.json`, text, source: readFrom })),
            ...answers.water.map((text, index) => ({ role: 'water', name: `water-extract-${index + 1}.json`, text, source: readFrom })),
            { role: 'places', name: 'places-extract.json', text: answers.places, source: readFrom }
        ],
        report: { errors: [], warnings: skipped }
    };
}

// The cities and towns of the extracts, for choosing the place to load from files that cover too much to load whole:
// with no map server to search, the files' own places are the search.
async function extractPlacesStep(files, helpers) {
    if (!files.length) return failure('Choose an OpenStreetMap extract (a .osm.pbf file) first.');
    const { inflateSync } = await import('node:zlib');
    const named = listed(files.map((file) => file.name));
    const lists = [];
    const progressOf = readingProgress(helpers, files, 'Finding the cities and towns in');
    for (const file of files) {
        try { lists.push(...extractPlaces(file.data, { inflate: inflateSync, onProgress: progressOf(file) })); } catch (error) { return failure(`${file.name} could not be read: ${error.message}`); }
    }
    const places = orderPlaces(lists).slice(0, 4000);
    if (!places.length) return failure(`${named} ${files.length === 1 ? 'names' : 'name'} no city or town: search a place first, and the roads around it are read from ${files.length === 1 ? 'the file' : 'the files'}.`);
    return { ok: true, data: { step: 'extractPlaces', file: named, places }, report: { errors: [], warnings: [] } };
}

async function describeExtractsStep(files) {
    const { inflateSync } = await import('node:zlib');
    return {
        ok: true,
        data: { step: 'describeExtracts', files: files.map((file) => {
            try { return { name: file.name, ...extractHeader(file.data, inflateSync) }; } catch (error) { return { name: file.name, error: error.message }; }
        }) },
        report: { errors: [], warnings: [] }
    };
}

function mapsCoveringStep(file, options) {
    if (!file?.text) return failure('The index of map extracts has not been fetched.');
    const bbox = options.bbox && ['south', 'west', 'north', 'east'].every((key) => Number.isFinite(options.bbox[key])) ? options.bbox : null;
    if (!bbox) return failure('Search a place first: the maps covering it are then found.');
    let index;
    try { index = readMapIndex(file.text); } catch (error) { return failure(error.message); }
    const { maps, uncovered } = mapsCovering(index, bbox);
    return { ok: true, data: { step: 'mapsCovering', maps: maps.map(({ id, name, parent, url, checksumUrl, bounds, area }) => ({ id, name, parent, url, checksumUrl, bounds, area: Math.round(area) })), uncovered }, report: { errors: [], warnings: [] } };
}

async function roadsStep(answers, options, helpers) {
    if (!answers.roads && !answers.places) return failure('Load the roads of a region, or use the sample region, first.');
    let discovered;
    try {
        discovered = discoverRegion(only(answers, baseKinds), options.bbox ? { bbox: options.bbox } : {});
    } catch (error) {
        return failure(error.message);
    }
    const bbox = boundsOf(options, discovered.roadGraph, discovered);
    const layers = mapLayers(discovered.layers, bbox);
    const map = { bbox, roads: layers.roads, rail: [], industrial: [], ports: [], anchorages: [], attribution: layers.attribution };
    // Place names, as labels: cities and towns, and the suburbs of a city.
    map.places = answers.places ? readOverpass(answers.places).filter((feature) => feature.tags.place && (feature.tags['name:en'] ?? feature.tags.name)).map((feature) => ({
        name: feature.tags['name:en'] ?? feature.tags.name, place: feature.tags.place, lat: Number(feature.point.lat.toFixed(5)), lon: Number(feature.point.lon.toFixed(5)),
        ...(parsePopulation(feature.tags.population) ? { population: parsePopulation(feature.tags.population) } : {})
    })) : [];
    if (options.bbox) {
        const geography = await loadGeography(helpers, bbox);
        if (geography) {
            map.geography = geography;
            map.attribution = `${map.attribution} · ${geographyAttribution}`;
        }
    }
    const graph = compactRoadGraph(discovered.roadGraph);
    // Railways and water, where they were fetched or read from a file: drawn, and graphs for links by rail and by water
    // (their geometry coarser than a road's, as a site is at the line within a kilometre or two).
    const lines = {};
    try {
        lines.rail = answers.rail ? readOverpass(answers.rail) : null;
        lines.water = answers.water ? readOverpass(answers.water) : null;
    } catch (error) {
        return failure(`The railways and water could not be read: ${error.message}`);
    }
    const water = lines.water ? waterOf(lines.water) : null;
    // Drawn: the running lines; routed over (buildLineGraph): every track, sidings and yards too.
    const railLines = (lines.rail ?? []).filter((feature) => isRunningLine(feature.tags) && feature.line);
    const drawn = linesLayers({ water, rail: railLines.map((feature) => feature.line) }, bbox);
    map.rail = drawn.rail;
    if (drawn.water) map.water = drawn.water;
    const graphs = {};
    const lineCoverage = {};
    for (const mode of ['rail', 'water']) {
        if (!lines[mode]) continue;
        const built = buildLineGraph(lines[mode], mode);
        lineCoverage[mode] = Math.round(built.kilometres);
        // Of the railways, the running lines the map draws, and the sidings and yards routed over besides.
        if (mode === 'rail') {
            const running = Math.round(buildLineGraph(lines.rail.filter((feature) => isRunningLine(feature.tags)), 'rail').kilometres);
            lineCoverage.rail = running;
            lineCoverage.railService = Math.max(0, Math.round(built.kilometres) - running);
        }
        if (built.mainVertices.length) graphs[mode] = compactRoadGraph(built, { tolerance: 25 });
    }
    // The window may receive 8 MB from an importer: roads beyond that are too many to place a network on in one go.
    const size = JSON.stringify(graph).length + JSON.stringify(map).length + JSON.stringify(graphs).length;
    if (size > maximumRoadsBytes) {
        return failure(`The roads of this area are more than the window can take (${Math.round(size / 1048576)} MB). Choose a smaller area${options.roadLevel === 'city' ? ', or major roads only' : ''}.`);
    }
    return {
        ok: true,
        data: {
            step: 'roads', map, graph, graphs,
            // Kilometres of railway (its running lines, and `railService` of sidings and yards besides) and of waterway a
            // barge may take, where they were loaded (absent where not).
            lineKilometres: lineCoverage,
            coverage: { roads: discovered.coverage.roads, places: map.places.length },
            notices: discovered.notices.filter((notice) => notice.kind === 'roads'),
            defaults: { portTeuPerDay: regionModelDefaults.portTeuPerDay }
        },
        report: { errors: [], warnings: [] }
    };
}

async function suggestionsStep(answers, options, helpers) {
    const sources = options.sources.filter((source) => suggestionSources[source]);
    const kinds = [...baseKinds, ...sources.flatMap((source) => suggestionSources[source].kinds)];
    let discovered;
    try {
        discovered = discoverRegion(only(answers, kinds), options.bbox ? { bbox: options.bbox } : {});
    } catch (error) {
        return failure(error.message);
    }
    const groups = sources.map((source) => suggestionSources[source].group);
    const bbox = boundsOf(options, discovered.roadGraph, discovered);
    const layers = mapLayers(discovered.layers, bbox);
    const noticeKinds = { ports: ['ports', 'portwatch'], warehouses: ['warehouses'], towns: ['towns'] };
    const wanted = new Set(sources.flatMap((source) => noticeKinds[source]));
    return {
        ok: true,
        data: {
            step: 'suggestions', sources,
            candidates: Object.fromEntries(groups.map((group) => [group, discovered.candidates[group]])),
            coverage: Object.fromEntries(sources.map((source) => [source, discovered.coverage[{ ports: 'ports', warehouses: 'warehouses', towns: 'towns' }[source]]])),
            notices: discovered.notices.filter((notice) => wanted.has(notice.kind)),
            // What shows the suggestions on the map: port land and anchorages, and industrial land.
            overlay: { ports: sources.includes('ports') ? layers.ports : [], anchorages: sources.includes('ports') ? layers.anchorages : [], industrial: sources.includes('warehouses') ? layers.industrial : [] },
            attribution: answers.portwatchPorts && sources.includes('ports') ? portwatchAttribution : null
        },
        report: { errors: [], warnings: [] }
    };
}

async function buildNetworkStep(answers, options, helpers, operatorText) {
    const network = options.network;
    if (!network?.selection || !network?.links) return failure('Place a network on the map first.');
    try {
        const discovered = discoverRegion(answers, options.bbox ? { bbox: options.bbox } : {});
        const selection = {};
        const unmatched = [];
        for (const [group, kind] of Object.entries(kinds)) {
            const known = new Map(discovered.candidates[group].map((site) => [site.id, site]));
            selection[group] = (network.selection[group] ?? []).map((entry) => {
                if (String(entry.id).startsWith(`${kind}:`) && !known.has(entry.id)) unmatched.push(entry.name);
                return resolvePin(entry, known, kind);
            });
        }
        const templates = await loadTemplates(helpers);
        // Legs the window did not route (none, usually) are routed the same way here.
        const route = createNetworkRouter(compactRoadGraph(discovered.roadGraph)).route;
        const answer = await finishBuild({ templates, helpers, selection, route, links: network.links, options, operatorText, step: 'buildNetwork' });
        if (answer.ok && unmatched.length) {
            const text = `${unmatched.join(', ')} ${unmatched.length === 1 ? 'was' : 'were'} adopted from map data that is no longer loaded, so ${unmatched.length === 1 ? 'it is' : 'they are'} built as your own site${unmatched.length === 1 ? '' : 's'}, without what was found there. Fetch the suggestions again to restore it.`;
            answer.data.warnings.push(text);
            answer.report.warnings.push(text);
        }
        return answer;
    } catch (error) {
        return failure(error.message);
    }
}
