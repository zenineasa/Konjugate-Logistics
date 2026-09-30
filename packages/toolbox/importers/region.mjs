/* Copyright © 2026 Zenin Easa Panthakkalakath */

// The region importer, in two steps the window drives:
//
//   discover (the default): reads the OpenStreetMap answers the window fetched for a region, and any CSV
//     of the user's own sites, and returns the candidates, the coverage report and its notices, and a
//     simplified map. No model yet: the user curates first.
//   build: takes the curated selection ({ ports, zones, towns }, each an id of a candidate or of one of
//     the user's sites, with any changes the user made: a moved position, a new name, a port's volume,
//     or a whole new site added on the map) and returns the model.
//
// Both steps read the same files again, so the importer holds no state between them.

import { discoverRegion } from '../lib/discovery.mjs';
import { mapLayers } from '../lib/mapData.mjs';
import { ModelBuilder } from '../lib/modelBuilder.mjs';
import { buildRegionModel, regionModelDefaults } from '../lib/regionModel.mjs';
import { createRouter } from '../lib/roadGraph.mjs';
import { parseSites } from '../lib/sites.mjs';

export const osmRoles = ['ports', 'logistics', 'roads', 'rail', 'places'];
export const templateIds = ['port', 'roadLane', 'railLane', 'warehouse', 'demandZone', 'roadShipment', 'railShipment', 'delivery'];
const kinds = { ports: 'port', zones: 'zone', towns: 'town' };

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

async function loadTemplates(helpers) {
    const templates = new Map();
    for (const id of templateIds) templates.set(id, await helpers.readPackageJson(`templates/${id}.json`));
    return templates;
}

export default async function importRegion({ files, helpers, options = {} }) {
    const answers = {};
    let sitesText = null;
    for (const file of files) {
        // A tiled kind arrives as several files, one per tile.
        if (osmRoles.includes(file.role)) (answers[file.role] ??= []).push(file.text);
        if (file.role === 'sites') sitesText = file.text;
    }
    if (!Object.keys(answers).length && !sitesText) return failure('Fetch a region, use the sample region, or choose a file of your own sites first.');

    let discovered;
    try {
        discovered = discoverRegion(answers);
    } catch (error) {
        return failure(error.message);
    }
    const sites = sitesText === null ? null : parseSites(sitesText);
    if (sites?.errors.length) return { ok: false, report: { errors: sites.errors.map((message) => `Your sites file: ${message}`), warnings: sites.warnings } };

    if (options.step !== 'build') {
        const bbox = regionBounds(options, discovered);
        return {
            ok: true,
            data: {
                step: 'discover', candidates: discovered.candidates, coverage: discovered.coverage, notices: discovered.notices,
                sites: sites?.sites ?? { ports: [], zones: [], towns: [] }, map: mapLayers(discovered.layers, bbox),
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
        const builder = new ModelBuilder(await loadTemplates(helpers), helpers);
        const settings = {};
        if (Number(options.settings?.portTeuPerDay) > 0) settings.portTeuPerDay = Number(options.settings.portTeuPerDay);
        const built = buildRegionModel({ builder, selection, route: createRouter(discovered.roadGraph).route, options: settings });
        const lanesByBasis = built.lanes.reduce((counts, lane) => ({ ...counts, [lane.basis]: (counts[lane.basis] ?? 0) + 1 }), {});
        return {
            ok: true,
            document: built.document,
            parameterIndex: built.parameterIndex,
            data: {
                step: 'build', lanes: built.lanes, served: built.served, provenance: built.provenance, warnings: built.warnings,
                unusedZones: built.unusedZones, nodes: built.document.nodes.length, edges: built.document.edges.length, lanesByBasis
            },
            report: {
                errors: [], warnings: built.warnings,
                summary: `${selection.ports.length} port${selection.ports.length === 1 ? '' : 's'}, ${built.lanes.length} road lane${built.lanes.length === 1 ? '' : 's'}, ${built.served.length} town${built.served.length === 1 ? '' : 's'} served`
            }
        };
    } catch (error) {
        return failure(error.message);
    }
}
