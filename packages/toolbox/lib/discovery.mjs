/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Turns what OpenStreetMap holds for a region into candidates a user curates: ports, logistics
// zones (warehouses grouped by distance, or industrial land where warehouses are not mapped) and
// towns, each with a significance score, plus a coverage report that says plainly what the map data
// can't see. Nothing here knows about any particular place.

import { boundsArea, centroid, clusterByDistance, distance, lineLength, pointInRing, ringArea, splitToSpan } from './geo.mjs';
import { readOverpass } from './overpass.mjs';
import { chokepointDependence } from './chokepoints.mjs';
import { matchPorts, readPortwatchActivity, readPortwatchPorts, summariseActivity, tonnesPerTeu } from './portwatch.mjs';

const tonnesPerTeuText = String(tonnesPerTeu);
import { buildRoadGraph } from './roadGraph.mjs';

export const discoveryDefaults = {
    // Port features closer than this are terminals of one port.
    portClusterMetres: 3000,
    // Warehouses closer than this form one logistics zone.
    zoneClusterMetres: 1500,
    // Industrial land at least this large, with no warehouse mapped on it, becomes an estimated zone.
    estimatedZoneMinimumSquareMetres: 200000,
    // Floor area assumed on industrial land with no mapped warehouses: a share of the land.
    estimatedFloorShare: 0.3,
    // Industrial parcels at least this large count towards warehouse coverage.
    coverageParcelMinimumSquareMetres: 50000,
    // Settlement sizes assumed where OpenStreetMap has no population.
    assumedPopulation: { city: 100000, town: 20000 },
    // A city or town with at least this many mapped suburbs is split into demand areas, so its people are
    // spread across it rather than placed at its centre. A suburb belongs to the nearest settlement that
    // reaches it: these distances, grown with the square root of a mapped population over a million (a city
    // of four million reaches twice as far), and a town's for a city with no population mapped (which may be
    // a small place tagged as a city). Suburbs closer than areaClusterMetres
    // form one area, and an area wider than areaMaximumSpanMetres is split.
    suburbsForAreas: 3,
    suburbReachMetres: { city: 25000, town: 10000 },
    areaClusterMetres: 4000,
    areaMaximumSpanMetres: 10000,
    // A city or town with no population mapped this close to one with a population is a district of it
    // (Deira in Dubai), and counts as one of its suburbs.
    districtMetres: 5000
};

const marinaCategories = /^(marina|marina_no_facilities|yacht|fishing|leisure|ferry|passenger)$/;
const commercialHint = /container|cargo|commercial|bulk|ro-?ro|oil|lng|freight/i;

function featureArea(feature) {
    if (feature.ring) return { squareMetres: ringArea(feature.ring), approximate: false };
    if (feature.rings) return { squareMetres: feature.rings.reduce((total, ring) => total + ringArea(ring), 0), approximate: false };
    // A building read with only its bounds: a rectangle a little larger than the building.
    if (feature.bounds) return { squareMetres: boundsArea(feature.bounds) * 0.8, approximate: true };
    return { squareMetres: 0, approximate: false };
}

// English first where OpenStreetMap has it (in many regions `name` is in the local script), then the local name.
const nameOf = (tags) => tags['name:en'] ?? tags.name ?? tags['seamark:name'] ?? tags['name:ar'] ?? tags.operator ?? null;

// Industrial land that is not logistics: power, utilities, gas and chemical works, masts, mines, shipyards.
// Plants mapped only as industrial land, recognisable by the words in their (English) name.
const plantName = /\b(power|desalination|compressor|substation|refinery|smelter|aluminium|aluminum|gas plant|gas processing|water treatment|sewage|cement)\b/i;
const notLogistics = (tags) => Boolean(plantName.test(tags['name:en'] ?? tags.name ?? '') || tags.power || /^(works|water_works|wastewater_plant|pumping_station|mineshaft)$/.test(tags.man_made ?? '')
    || /^(power|gas|oil|refinery|chemical|communication|telecommunication|water|wastewater|mine|quarry|mineral_processing|shipyard|slaughterhouse|sugar_refinery|scrap_yard|aluminium_smelter|smelter|steelmaker|brickyard|sawmill)$/.test(tags.industrial ?? ''));

function isMarina(tags) {
    if (tags.leisure === 'marina') return true;
    // Passenger harbours: ferry and water-bus stops.
    if (tags.amenity === 'ferry_terminal' || tags.public_transport || tags.cargo === 'passengers') return true;
    const category = tags['harbour:category'] ?? tags['seamark:harbour:category'] ?? '';
    return category.split(';').some((value) => marinaCategories.test(value.trim()));
}

export function parsePopulation(value) {
    if (value === undefined || value === null) return null;
    const digits = String(value).replace(/[\s,.'  ]/g, '').match(/^\d+/);
    const number = digits ? Number(digits[0]) : NaN;
    return Number.isFinite(number) && number > 0 ? number : null;
}

const round = (value, digits = 0) => Number(value.toFixed(digits));

// `answers` holds the Overpass answers by kind (ports, logistics, roads, rail, places), as text or
// parsed JSON; any may be missing. Returns { candidates, roadGraph, coverage, notices }.
export function discoverRegion(answers, options = {}) {
    const settings = { ...discoveryDefaults, ...options };
    const read = (kind) => {
        if (!answers[kind]) return [];
        try {
            return readOverpass(answers[kind]);
        } catch (error) {
            throw new Error(`The ${kind} data could not be read: ${error.message}`);
        }
    };
    const portFeatures = read('ports');
    const logisticsFeatures = read('logistics');
    const roadFeatures = read('roads');
    const railFeatures = read('rail');
    const placeFeatures = read('places');

    const roadGraph = buildRoadGraph(roadFeatures);
    const roadVertices = roadGraph.mainVertices;
    const nearestRoadMetres = (point) => {
        let best = Infinity;
        for (const vertex of roadVertices) best = Math.min(best, distance(point, vertex));
        return best;
    };

    // ---- ports and anchorages
    const anchorages = [];
    const marinas = [];
    const portParts = [];
    for (const feature of portFeatures) {
        const tags = feature.tags;
        if (tags['seamark:type'] === 'anchorage' || tags['seamark:type'] === 'anchor_berth') anchorages.push(feature);
        else if (isMarina(tags)) marinas.push(feature);
        // An administrative area tagged as port land (a free zone, say) is not the port: it belongs with the logistics land.
        else if (tags.boundary || tags.type === 'boundary') continue;
        else portParts.push(feature);
    }
    const ports = clusterByDistance(portParts, (feature) => feature.point, settings.portClusterMetres).map((parts, index) => {
        const areas = parts.map((part) => featureArea(part).squareMetres);
        const area = areas.reduce((total, value) => total + value, 0);
        const byArea = parts.map((part, partIndex) => ({ part, area: areas[partIndex] })).sort((a, b) => b.area - a.area);
        // The port's own name: from a part's Wikipedia article (as "Port of X"), else a part named like a port, else the largest named part.
        const article = parts.map((part) => /^en:(.+)$/.exec(part.tags.wikipedia ?? '')?.[1]).find((title) => title && /port|harbou?r|terminal/i.test(title));
        const named = article ? { part: { tags: { name: article } } }
            : byArea.find(({ part }) => /port|harbou?r|terminal|quay|ميناء/i.test(nameOf(part.tags) ?? '')) ?? byArea.find(({ part }) => nameOf(part.tags));
        const commercial = parts.some((part) => Object.values(part.tags).some((value) => commercialHint.test(value)));
        const point = area > 0 ? centroid(parts.map((part) => part.point), areas.map((value) => value || 1)) : centroid(parts.map((part) => part.point));
        return {
            id: `port:${byArea[0].part.osmType}/${byArea[0].part.osmId}`, kind: 'port',
            name: named ? nameOf(named.part.tags) : `Port ${index + 1}`, named: Boolean(named),
            lat: point.lat, lon: point.lon, areaSquareKilometres: round(area / 1e6, 3), commercial,
            parts: parts.length, anchorages: 0,
            // Until port activity is matched (PortWatch), ports rank by the land they cover, commercial ones first.
            significance: round(area / 1e6 * (commercial ? 2 : 1) + (commercial ? 0.5 : 0), 4),
            source: 'OpenStreetMap'
        };
    });
    // Unnamed scraps of port land with no commercial tag are mapping fragments, not ports.
    for (let index = ports.length - 1; index >= 0; index -= 1) {
        if (!ports[index].named && !ports[index].commercial && ports[index].areaSquareKilometres < 0.05) ports.splice(index, 1);
    }
    for (const anchorage of anchorages) {
        let nearest = null;
        let nearestMetres = Infinity;
        for (const port of ports) {
            const metres = distance(anchorage.point, port);
            if (metres < nearestMetres) { nearest = port; nearestMetres = metres; }
        }
        if (nearest && nearestMetres <= 30000) nearest.anchorages += 1;
    }

    // ---- logistics zones
    const warehouses = [];
    const parcels = [];
    let otherIndustry = 0;
    for (const feature of logisticsFeatures) {
        if (notLogistics(feature.tags)) { otherIndustry += 1; continue; }
        if (feature.tags.building === 'warehouse' || /^(warehouse|logistics|distribution|depot)$/.test(feature.tags.industrial ?? '')) {
            const area = featureArea(feature);
            // A warehouse building's footprint is its floor area; a warehouse district mapped as land holds less.
            warehouses.push({ feature, area: feature.tags.building ? area : { squareMetres: area.squareMetres * settings.estimatedFloorShare, approximate: true } });
        } else if (feature.tags.industrial === 'port') {
            // Port land is a port (see the ports query), not a logistics zone.
            continue;
        } else if (feature.tags.landuse === 'industrial' && (feature.ring || feature.rings)) {
            parcels.push({ feature, area: featureArea(feature).squareMetres, warehouses: 0 });
        }
    }
    const rings = (feature) => feature.ring ? [feature.ring] : feature.rings;
    for (const warehouse of warehouses) {
        for (const parcel of parcels) {
            if (rings(parcel.feature).some((ring) => pointInRing(warehouse.feature.point, ring))) { parcel.warehouses += 1; warehouse.parcel = parcel; break; }
        }
    }
    const mappedZones = clusterByDistance(warehouses, (item) => item.feature.point, settings.zoneClusterMetres).map((group) => {
        const floorArea = group.reduce((total, item) => total + item.area.squareMetres, 0);
        return {
            points: group.map((item) => item.feature.point), weights: group.map((item) => item.area.squareMetres || 1),
            names: [...group.map((item) => nameOf(item.feature.tags)), ...group.map((item) => item.parcel && nameOf(item.parcel.feature.tags))].filter(Boolean),
            floorArea, floorAreaBasis: group.some((item) => item.area.approximate) ? 'approximate' : 'mapped', buildings: group.length,
            firstId: `${group[0].feature.osmType}/${group[0].feature.osmId}`
        };
    });
    // Warehouse coverage: the share of larger industrial parcels with any warehouse mapped on them.
    const industrialArea = parcels.reduce((total, parcel) => total + parcel.area, 0);
    const largeParcels = parcels.filter((parcel) => parcel.area >= settings.coverageParcelMinimumSquareMetres);
    const coveredShare = largeParcels.length ? largeParcels.filter((parcel) => parcel.warehouses > 0).length / largeParcels.length : null;
    const warehouseLevel = !warehouses.length ? 'none'
        : coveredShare === null ? 'unknown' : coveredShare >= 0.5 ? 'good' : coveredShare >= 0.2 ? 'partial' : 'thin';
    // Where warehouses are well mapped, industrial land without any is taken to be something else
    // (factories, utilities). Elsewhere it stands in for the warehouses the map is missing.
    const bareParcels = warehouseLevel === 'good' ? [] : parcels.filter((parcel) => parcel.warehouses === 0 && parcel.area >= settings.estimatedZoneMinimumSquareMetres);
    const estimatedZones = clusterByDistance(bareParcels, (parcel) => parcel.feature.point, settings.zoneClusterMetres).map((group) => {
        const land = group.reduce((total, parcel) => total + parcel.area, 0);
        return {
            points: group.map((parcel) => parcel.feature.point), weights: group.map((parcel) => parcel.area),
            names: group.map((parcel) => nameOf(parcel.feature.tags)).filter(Boolean),
            floorArea: land * settings.estimatedFloorShare, floorAreaBasis: 'estimated', buildings: 0, industrialLand: land,
            firstId: `${group[0].feature.osmType}/${group[0].feature.osmId}`
        };
    });

    // ---- towns: cities and towns, and, where a settlement's suburbs are mapped, demand areas across it
    const settlements = [];
    const suburbs = [];
    for (const feature of placeFeatures) {
        if (feature.osmType !== 'node') continue;
        if (/^(city|town)$/.test(feature.tags.place ?? '')) settlements.push(feature);
        else if (/^(suburb|quarter)$/.test(feature.tags.place ?? '')) suburbs.push(feature);
    }
    const settlementTown = (feature) => {
        const population = parsePopulation(feature.tags.population);
        return {
            id: `town:node/${feature.osmId}`, kind: 'town', name: nameOf(feature.tags) ?? `Unnamed ${feature.tags.place}`,
            lat: feature.point.lat, lon: feature.point.lon, place: feature.tags.place,
            population: population ?? settings.assumedPopulation[feature.tags.place],
            populationBasis: population ? 'OpenStreetMap' : 'assumed',
            significance: population ?? settings.assumedPopulation[feature.tags.place], source: 'OpenStreetMap'
        };
    };
    // A settlement with no population close to one with a population is a district of it: one more suburb.
    const districts = []; // { name, of } for the notice
    for (const settlement of [...settlements]) {
        if (parsePopulation(settlement.tags.population)) continue;
        const city = settlements.find((other) => other !== settlement && parsePopulation(other.tags.population) && distance(settlement.point, other.point) <= settings.districtMetres);
        if (!city) continue;
        settlements.splice(settlements.indexOf(settlement), 1);
        suburbs.push(settlement);
        districts.push({ name: nameOf(settlement.tags) ?? 'An unnamed place', of: nameOf(city.tags) ?? 'a city' });
    }
    // Each suburb belongs to the nearest settlement that reaches it.
    const reachOf = (settlement) => {
        const population = parsePopulation(settlement.tags.population);
        if (!population) return settings.suburbReachMetres.town;
        return settings.suburbReachMetres[settlement.tags.place] * Math.sqrt(Math.max(1, population / 1e6));
    };
    const suburbsOf = new Map(settlements.map((settlement) => [settlement, []]));
    const unclaimed = [];
    for (const suburb of suburbs) {
        let owner = null;
        let ownerMetres = Infinity;
        for (const settlement of settlements) {
            const metres = distance(suburb.point, settlement.point);
            if (metres <= reachOf(settlement) && metres < ownerMetres) { owner = settlement; ownerMetres = metres; }
        }
        if (owner) suburbsOf.get(owner).push(suburb); else unclaimed.push(suburb);
    }
    const towns = [];
    const spread = []; // { name, suburbs, areas, assumed } for the notice
    for (const settlement of settlements) {
        const town = settlementTown(settlement);
        const itsSuburbs = suburbsOf.get(settlement);
        if (itsSuburbs.length < settings.suburbsForAreas) { towns.push(town); continue; }
        // The settlement's people, spread over its suburbs: a suburb's own population where mapped, and an even
        // share of the rest where not. A settlement whose suburbs between them hold more people than it is said
        // to keeps the suburbs' figures.
        const known = itsSuburbs.map((suburb) => parsePopulation(suburb.tags.population));
        const knownTotal = known.reduce((total, value) => total + (value ?? 0), 0);
        const unknownCount = known.filter((value) => value === null).length;
        const rest = Math.max(0, town.population - knownTotal);
        const evenShare = unknownCount ? rest / unknownCount : 0;
        const members = itsSuburbs.map((suburb, index) => ({ suburb, population: known[index] ?? evenShare, assumed: known[index] === null }));
        const areas = clusterByDistance(members, (member) => member.suburb.point, settings.areaClusterMetres)
            .flatMap((area) => splitToSpan(area, (member) => member.suburb.point, settings.areaMaximumSpanMetres));
        for (const area of areas) {
            const population = area.reduce((total, member) => total + member.population, 0);
            if (!(population > 0)) continue;
            const largest = [...area].sort((a, b) => b.population - a.population || (nameOf(a.suburb.tags) ?? '').localeCompare(nameOf(b.suburb.tags) ?? ''));
            const names = largest.map((member) => nameOf(member.suburb.tags)).filter(Boolean);
            const point = centroid(area.map((member) => member.suburb.point), area.map((member) => member.population || 1));
            const assumedShare = area.filter((member) => member.assumed).reduce((total, member) => total + member.population, 0) / population;
            towns.push({
                id: `town:area/${settlement.osmId}/${largest[0].suburb.osmId}`, kind: 'town',
                name: `${town.name}: ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` and ${names.length - 2} more` : ''}`,
                lat: point.lat, lon: point.lon, place: 'area', city: town.name, suburbs: names,
                population: Math.round(population),
                populationBasis: assumedShare > 0.5 ? (town.populationBasis === 'OpenStreetMap' ? 'shared' : 'assumed') : 'OpenStreetMap',
                significance: Math.round(population), source: 'OpenStreetMap'
            });
        }
        spread.push({ name: town.name, suburbs: itsSuburbs.length, areas: areas.length, assumed: unknownCount, population: town.population, populationBasis: town.populationBasis });
    }
    // A suburb with its own population and no settlement nearby is a place of its own.
    for (const suburb of unclaimed) {
        const population = parsePopulation(suburb.tags.population);
        if (!population) continue;
        towns.push({ ...settlementTown(suburb), place: suburb.tags.place, population, populationBasis: 'OpenStreetMap', significance: population });
    }
    towns.sort((a, b) => b.significance - a.significance);

    const nearestTownName = (point) => {
        let best = null;
        let bestMetres = Infinity;
        for (const town of towns) {
            const metres = distance(point, town);
            if (metres < bestMetres) { best = town; bestMetres = metres; }
        }
        return best?.name ?? null;
    };
    const zones = [...mappedZones, ...estimatedZones].map((zone) => {
        const point = centroid(zone.points, zone.weights);
        const roadMetres = roadVertices.length ? nearestRoadMetres(point) : null;
        // Road access: full weight next to a major road, half at 2 km, and so on.
        const access = roadMetres === null ? 1 : 1 / (1 + roadMetres / 2000);
        // Industrial land standing in for unmapped warehouses may be a factory or a plant: ranked below mapped warehouses.
        const confidence = zone.floorAreaBasis === 'estimated' ? 0.5 : 1;
        return {
            id: `zone:${zone.firstId}`, kind: 'zone', lat: point.lat, lon: point.lon,
            name: zone.names[0] ?? null, near: nearestTownName(point),
            floorAreaSquareMetres: Math.round(zone.floorArea), floorAreaBasis: zone.floorAreaBasis, buildings: zone.buildings,
            roadKilometres: roadMetres === null ? null : round(roadMetres / 1000, 2),
            significance: round(zone.floorArea * access * confidence, 0), source: zone.floorAreaBasis === 'estimated' ? 'OpenStreetMap industrial land' : 'OpenStreetMap'
        };
    }).sort((a, b) => b.significance - a.significance).map((zone, index) => ({
        ...zone, name: zone.name ?? `Logistics zone ${index + 1}${zone.near ? ` (near ${zone.near})` : ''}`
    }));
    // ---- port activity: IMF PortWatch ports matched by position, with their history where it was fetched
    const portwatchListed = (answers.portwatchPorts ?? []).flatMap((text) => {
        try {
            return readPortwatchPorts(text);
        } catch (error) {
            throw new Error(`The IMF PortWatch ports could not be read: ${error.message}`);
        }
    });
    const histories = new Map();
    for (const text of answers.portwatchActivity ?? []) {
        const activity = readPortwatchActivity(text);
        if (activity) histories.set(activity.portid, activity);
    }
    const matches = matchPorts(ports, portwatchListed);
    for (const port of ports) {
        const match = matches.get(port.id);
        if (!match) continue;
        port.portwatch = { portid: match.port.portid, name: match.port.name, kilometres: round(match.kilometres, 1), containerVessels: match.port.containerVessels };
        const history = histories.get(match.port.portid);
        if (history) port.activity = summariseActivity(history);
    }
    // Which chokepoints each port's ships pass, by the enclosed sea it lies in (an assumption; see chokepoints.mjs).
    for (const port of ports) port.chokepoints = chokepointDependence(port);
    // Ports with activity first, busiest first; then the rest by their land and tags.
    ports.sort((a, b) => (b.activity ? 1 : 0) - (a.activity ? 1 : 0) || (b.activity?.teuPerDay ?? 0) - (a.activity?.teuPerDay ?? 0) || b.significance - a.significance);
    // PortWatch ports are fetched with a margin around the region; only those inside it are worth a notice.
    const box = settings.bbox;
    const insideRegion = (point) => !box || (point.lat >= box.south && point.lat <= box.north && point.lon >= box.west && point.lon <= box.east);
    const matchedIds = new Set([...matches.values()].map((match) => match.port.portid));
    const unmatchedListed = portwatchListed.filter((listed) => !matchedIds.has(listed.portid) && listed.containerVessels > 0 && insideRegion(listed));

    // ---- rail
    const railLines = railFeatures.filter((feature) => feature.tags.railway === 'rail' && feature.line);
    const railKilometres = railLines.reduce((total, feature) => total + lineLength(feature.line), 0) / 1000;
    const railYards = railFeatures.filter((feature) => feature.tags.railway === 'yard' || feature.tags.landuse === 'railway' || feature.tags.usage === 'freight').length;

    // ---- coverage
    const roadKilometres = Object.values(roadGraph.kilometresByClass).reduce((total, value) => total + value, 0);
    const withPopulation = towns.filter((town) => town.populationBasis === 'OpenStreetMap' || town.populationBasis === 'shared').length;
    const coverage = {
        ports: { found: ports.length, commercial: ports.filter((port) => port.commercial).length, marinasExcluded: marinas.length, anchorages: anchorages.length, activityMatched: answers.portwatchPorts ? ports.filter((port) => port.activity).length : null, portwatchListed: answers.portwatchPorts ? portwatchListed.length : null },
        warehouses: {
            buildings: warehouses.length, floorAreaSquareKilometres: round(warehouses.reduce((total, item) => total + item.area.squareMetres, 0) / 1e6, 3),
            industrialLandSquareKilometres: round(industrialArea / 1e6, 2), largeParcels: largeParcels.length,
            largeParcelsWithWarehouse: largeParcels.filter((parcel) => parcel.warehouses > 0).length,
            coveredShare: coveredShare === null ? null : round(coveredShare, 3), level: warehouseLevel,
            estimatedZones: estimatedZones.length, otherIndustryExcluded: otherIndustry
        },
        roads: {
            kilometres: round(roadKilometres, 1), byClass: Object.fromEntries(Object.entries(roadGraph.kilometresByClass).map(([key, value]) => [key, round(value, 1)])),
            components: roadGraph.components, level: roadKilometres > 0 ? 'mapped' : 'none'
        },
        rail: { lineKilometres: round(railKilometres, 1), yards: railYards },
        towns: { found: towns.length, withPopulation, settlements: settlements.length, suburbs: suburbs.length, spread: spread.map(({ name, suburbs: count, areas }) => ({ name, suburbs: count, areas })), level: !towns.length ? 'none' : withPopulation === towns.length ? 'good' : 'partial' }
    };

    const notices = [];
    if (!ports.length) notices.push({ kind: 'ports', level: 'warning', text: 'No commercial ports are mapped in this region. Add a port yourself if the region has one.' });
    if (marinas.length) notices.push({ kind: 'ports', level: 'info', text: `${marinas.length} marina${marinas.length === 1 ? '' : 's'}, fishing and passenger harbour${marinas.length === 1 ? ' was' : 's were'} left out.` });
    if (otherIndustry) notices.push({ kind: 'warehouses', level: 'info', text: `${otherIndustry} industrial site${otherIndustry === 1 ? '' : 's'} that are not logistics (power, gas, water, communications and the like) ${otherIndustry === 1 ? 'was' : 'were'} left out.` });
    if (!answers.portwatchPorts) {
        notices.push({ kind: 'ports', level: 'info', text: 'Port activity has not been matched yet: every port starts with an assumed volume, which you can change.' });
    } else {
        const withActivity = ports.filter((port) => port.activity);
        const without = ports.filter((port) => !port.portwatch);
        const quiet = ports.filter((port) => port.portwatch && !port.activity);
        if (withActivity.length) notices.push({ kind: 'ports', level: 'info', text: `Port activity from IMF PortWatch: ${withActivity.map((port) => `${port.name} imports about ${Math.round(port.activity.teuPerDay).toLocaleString('en')} TEU a day`).join('; ')} (container tonnes over ${withActivity[0].activity.from} to ${withActivity[0].activity.to}, at an assumed ${tonnesPerTeuText} t a TEU, including containers that only change ships).` });
        if (without.length) notices.push({ kind: 'ports', level: 'info', text: `${without.map((port) => port.name).join(', ')} ${without.length === 1 ? 'is' : 'are'} not in IMF PortWatch, so ${without.length === 1 ? 'it starts' : 'they start'} with an assumed volume, which you can change.` });
        if (quiet.length) notices.push({ kind: 'ports', level: 'info', text: `IMF PortWatch has no recent activity for ${quiet.map((port) => `${port.name} (${port.portwatch.name})`).join(', ')}, so ${quiet.length === 1 ? 'it starts' : 'they start'} with an assumed volume, which you can change.` });
        if (unmatchedListed.length) notices.push({ kind: 'ports', level: 'info', text: `IMF PortWatch also lists ${unmatchedListed.slice(0, 4).map((listed) => listed.name).join(', ')}${unmatchedListed.length > 4 ? ` and ${unmatchedListed.length - 4} more` : ''} here, which OpenStreetMap does not map as a cargo port. Add ${unmatchedListed.length === 1 ? 'it' : 'one'} on the map if containers come through ${unmatchedListed.length === 1 ? 'it' : 'them'}.` });
    }
    if (warehouseLevel === 'none') {
        notices.push({ kind: 'warehouses', level: 'warning', text: industrialArea > 0
            ? `No warehouses are mapped in this region, across ${round(industrialArea / 1e6, 1)} km² of industrial land. The model groups industrial areas into logistics zones instead, with an estimated floor area. Add your own sites for a more accurate model.`
            : 'No warehouses or industrial land are mapped in this region. Add your own sites, or import a CSV of them, to build a model.' });
    } else if (warehouseLevel === 'thin' || warehouseLevel === 'partial') {
        const share = Math.round(coveredShare * 100);
        notices.push({ kind: 'warehouses', level: warehouseLevel === 'thin' ? 'warning' : 'info', text:
            `${warehouseLevel === 'thin' ? 'Few' : 'Some'} warehouses are mapped in this region: ${warehouses.length} across ${round(industrialArea / 1e6, 1)} km² of industrial land, and only ${share}% of the larger industrial areas have any warehouse mapped. `
            + `${estimatedZones.length ? 'The model groups the unmapped industrial areas into logistics zones with an estimated floor area. ' : ''}Add your own sites for a more accurate model.` });
    }
    if (!roadKilometres) notices.push({ kind: 'roads', level: 'warning', text: 'No major roads are mapped here, so travel times are straight-line estimates.' });
    else if (roadGraph.components > 1) notices.push({ kind: 'roads', level: 'info', text: `The major roads form ${roadGraph.components} separate networks; sites are routed on the largest, and straight-line estimates are used where a site is far from it.` });
    for (const district of districts) {
        notices.push({ kind: 'towns', level: 'info', text: `${district.name} has no population mapped and lies within ${district.of}, so it is counted as one of ${district.of}'s suburbs.` });
    }
    for (const city of spread) {
        notices.push({ kind: 'towns', level: 'info', text: `${city.name}'s ${city.populationBasis === 'OpenStreetMap' ? `${city.population.toLocaleString('en')} people are` : 'people are'} spread over ${city.areas} area${city.areas === 1 ? '' : 's'} of its ${city.suburbs} mapped suburbs${city.assumed ? `; ${city.assumed === city.suburbs ? 'how many live in each suburb is' : `for ${city.assumed} suburbs without a population, how many live in each is`} assumed (an even share)` : ''}.` });
    }
    if (towns.length && withPopulation < towns.length) {
        notices.push({ kind: 'towns', level: 'info', text: `Population is missing for ${towns.length - withPopulation} of ${towns.length} towns, cities and areas. Demand for those uses an assumed size (${settings.assumedPopulation.city.toLocaleString('en')} for a city, ${settings.assumedPopulation.town.toLocaleString('en')} for a town), an estimate you can change.` });
    }
    if (!towns.length) notices.push({ kind: 'towns', level: 'warning', text: 'No towns or cities are mapped here, so there is no demand to serve. Add customers yourself.' });

    // What a map of the region draws: the raw features behind the candidates (see mapData.mjs).
    const layers = { roads: roadFeatures, rail: railLines, industrial: parcels.map((parcel) => parcel.feature), ports: portParts, anchorages };
    return { candidates: { ports, zones, towns }, roadGraph, coverage, notices, layers };
}

// A first selection a user then curates: the most significant few of each kind.
export function defaultSelection(candidates, { ports = 3, zones = 6, towns = 12 } = {}) {
    return {
        ports: candidates.ports.slice(0, ports),
        zones: candidates.zones.slice(0, zones),
        towns: candidates.towns.slice(0, towns)
    };
}
