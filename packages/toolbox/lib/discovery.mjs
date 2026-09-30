/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Turns what OpenStreetMap holds for a region into candidates a user curates: ports, logistics
// zones (warehouses grouped by distance, or industrial land where warehouses are not mapped) and
// towns, each with a significance score, plus a coverage report that says plainly what the map data
// can't see. Nothing here knows about any particular place.

import { boundsArea, centroid, clusterByDistance, distance, lineLength, pointInRing, ringArea } from './geo.mjs';
import { readOverpass } from './overpass.mjs';
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
    assumedPopulation: { city: 100000, town: 20000 }
};

const marinaCategories = /^(marina|marina_no_facilities|yacht|fishing|leisure|ferry)$/;
const commercialHint = /container|cargo|commercial|bulk|ro-?ro|oil|lng|freight/i;

function featureArea(feature) {
    if (feature.ring) return { squareMetres: ringArea(feature.ring), approximate: false };
    if (feature.rings) return { squareMetres: feature.rings.reduce((total, ring) => total + ringArea(ring), 0), approximate: false };
    // A building read with only its bounds: a rectangle a little larger than the building.
    if (feature.bounds) return { squareMetres: boundsArea(feature.bounds) * 0.8, approximate: true };
    return { squareMetres: 0, approximate: false };
}

const nameOf = (tags) => tags.name ?? tags['name:en'] ?? tags['seamark:name'] ?? tags.operator ?? null;

function isMarina(tags) {
    if (tags.leisure === 'marina') return true;
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
    const read = (kind) => (answers[kind] ? readOverpass(answers[kind]) : []);
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
        else portParts.push(feature);
    }
    const ports = clusterByDistance(portParts, (feature) => feature.point, settings.portClusterMetres).map((parts, index) => {
        const areas = parts.map((part) => featureArea(part).squareMetres);
        const area = areas.reduce((total, value) => total + value, 0);
        const byArea = parts.map((part, partIndex) => ({ part, area: areas[partIndex] })).sort((a, b) => b.area - a.area);
        const named = byArea.find(({ part }) => nameOf(part.tags));
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
    for (const feature of logisticsFeatures) {
        if (feature.tags.landuse === 'industrial' && (feature.ring || feature.rings)) parcels.push({ feature, area: featureArea(feature).squareMetres, warehouses: 0 });
        else if (feature.tags.building === 'warehouse' || /^(warehouse|logistics|distribution)$/.test(feature.tags.industrial ?? '')) {
            warehouses.push({ feature, area: featureArea(feature) });
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

    // ---- towns
    const towns = placeFeatures.filter((feature) => feature.osmType === 'node' && /^(city|town)$/.test(feature.tags.place ?? '')).map((feature) => {
        const population = parsePopulation(feature.tags.population);
        return {
            id: `town:node/${feature.osmId}`, kind: 'town', name: nameOf(feature.tags) ?? `Unnamed ${feature.tags.place}`,
            lat: feature.point.lat, lon: feature.point.lon, place: feature.tags.place,
            population: population ?? settings.assumedPopulation[feature.tags.place],
            populationBasis: population ? 'OpenStreetMap' : 'assumed',
            significance: population ?? settings.assumedPopulation[feature.tags.place], source: 'OpenStreetMap'
        };
    }).sort((a, b) => b.significance - a.significance);

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
        return {
            id: `zone:${zone.firstId}`, kind: 'zone', lat: point.lat, lon: point.lon,
            name: zone.names[0] ?? null, near: nearestTownName(point),
            floorAreaSquareMetres: Math.round(zone.floorArea), floorAreaBasis: zone.floorAreaBasis, buildings: zone.buildings,
            roadKilometres: roadMetres === null ? null : round(roadMetres / 1000, 2),
            significance: round(zone.floorArea * access, 0), source: zone.floorAreaBasis === 'estimated' ? 'OpenStreetMap industrial land' : 'OpenStreetMap'
        };
    }).sort((a, b) => b.significance - a.significance).map((zone, index) => ({
        ...zone, name: zone.name ?? `Logistics zone ${index + 1}${zone.near ? ` (near ${zone.near})` : ''}`
    }));
    ports.sort((a, b) => b.significance - a.significance);

    // ---- rail
    const railLines = railFeatures.filter((feature) => feature.tags.railway === 'rail' && feature.line);
    const railKilometres = railLines.reduce((total, feature) => total + lineLength(feature.line), 0) / 1000;
    const railYards = railFeatures.filter((feature) => feature.tags.railway === 'yard' || feature.tags.landuse === 'railway' || feature.tags.usage === 'freight').length;

    // ---- coverage
    const roadKilometres = Object.values(roadGraph.kilometresByClass).reduce((total, value) => total + value, 0);
    const withPopulation = towns.filter((town) => town.populationBasis === 'OpenStreetMap').length;
    const coverage = {
        ports: { found: ports.length, commercial: ports.filter((port) => port.commercial).length, marinasExcluded: marinas.length, anchorages: anchorages.length, activityMatched: null },
        warehouses: {
            buildings: warehouses.length, floorAreaSquareKilometres: round(warehouses.reduce((total, item) => total + item.area.squareMetres, 0) / 1e6, 3),
            industrialLandSquareKilometres: round(industrialArea / 1e6, 2), largeParcels: largeParcels.length,
            largeParcelsWithWarehouse: largeParcels.filter((parcel) => parcel.warehouses > 0).length,
            coveredShare: coveredShare === null ? null : round(coveredShare, 3), level: warehouseLevel,
            estimatedZones: estimatedZones.length
        },
        roads: {
            kilometres: round(roadKilometres, 1), byClass: Object.fromEntries(Object.entries(roadGraph.kilometresByClass).map(([key, value]) => [key, round(value, 1)])),
            components: roadGraph.components, level: roadKilometres > 0 ? 'mapped' : 'none'
        },
        rail: { lineKilometres: round(railKilometres, 1), yards: railYards },
        towns: { found: towns.length, withPopulation, level: !towns.length ? 'none' : withPopulation === towns.length ? 'good' : 'partial' }
    };

    const notices = [];
    if (!ports.length) notices.push({ kind: 'ports', level: 'warning', text: 'No commercial ports are mapped in this region. Add a port yourself if the region has one.' });
    if (marinas.length) notices.push({ kind: 'ports', level: 'info', text: `${marinas.length} marina${marinas.length === 1 ? '' : 's'} and fishing harbour${marinas.length === 1 ? ' was' : 's were'} left out.` });
    notices.push({ kind: 'ports', level: 'info', text: 'Port activity has not been matched yet: every port starts with an assumed volume, which you can change.' });
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
    if (towns.length && withPopulation < towns.length) {
        notices.push({ kind: 'towns', level: 'info', text: `Population is missing for ${towns.length - withPopulation} of ${towns.length} towns and cities. Demand for those uses an assumed size (${settings.assumedPopulation.city.toLocaleString('en')} for a city, ${settings.assumedPopulation.town.toLocaleString('en')} for a town), an estimate you can change.` });
    }
    if (!towns.length) notices.push({ kind: 'towns', level: 'warning', text: 'No towns or cities are mapped here, so there is no demand to serve. Add customers yourself.' });

    return { candidates: { ports, zones, towns }, roadGraph, coverage, notices };
}

// A first selection a user then curates: the most significant few of each kind.
export function defaultSelection(candidates, { ports = 3, zones = 6, towns = 8 } = {}) {
    return {
        ports: candidates.ports.slice(0, ports),
        zones: candidates.zones.slice(0, zones),
        towns: candidates.towns.slice(0, towns)
    };
}
