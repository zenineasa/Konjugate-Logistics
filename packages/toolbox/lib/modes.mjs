/* Copyright © 2026 Zenin Easa Panthakkalakath */

// How a link carries goods: by road, by rail or by water. A link by rail or by water runs over OpenStreetMap's railways
// or navigable waterways between two sites at the line or the waterside, on its mode's vehicles (freight trains,
// barges); goods change mode at the sites the user places (an inland port, a rail terminal), each linked to the next.
// So a rail or water link does not reach a site far from its line: that would hide a truck leg the model does not
// have. A link from or to a store, a dark store or a customer area is by road.
//
// Also here: what is read of railways, waterways and water out of OpenStreetMap's answers (the window draws the water
// under the roads and routes rail and water links over the lines), and the graphs those links are routed over.

import { distance } from './geo.mjs';
import { maximumSnapKilometres } from './roadGraph.mjs';

export const modeIds = ['road', 'rail', 'water'];
// `noun` names the network a link of the mode runs on; `prefix` begins its lanes' names in the model; `reach` is how
// far, in kilometres, a site may be from the line and still be at it (its own siding or quay, taken as part of the
// link, at the link's speed).
export const modes = {
    road: { id: 'road', name: 'Road', noun: 'roads', prefix: 'Road', reach: null },
    rail: { id: 'rail', name: 'Rail', noun: 'railway', prefix: 'Rail', reach: 2 },
    water: { id: 'water', name: 'Water', noun: 'navigable waterway', prefix: 'Water', reach: 2 }
};
export const linkMode = (link) => (modes[link?.mode] ? link.mode : 'road');
// A lane's name in the model, by its link's mode: "Rail Basel → Duisburg".
export const laneName = (mode, from, to) => `${(modes[mode] ?? modes.road).prefix} ${from} → ${to}`;
// The ends of a lane's name, without its mode: "Basel → Duisburg".
export const laneEnds = (name) => String(name).replace(/^(Road|Rail|Water) /, '');

// Whether a link of this kind (vehicles.mjs, linkKind) may run by this mode, and why not: rail and water carry from a
// source to a warehouse or between warehouses; deliveries to stores, dark stores and customer areas go by road.
export function modeProblem(mode, kind) {
    if (mode === 'road' || !modes[mode]) return null;
    if (kind === 'supply' || kind === 'transfer') return null;
    return `A link to a ${kind === 'darkStore' ? 'dark store' : kind === 'store' ? 'store' : 'customer area'} goes by road: ${modes[mode].name.toLowerCase()} carries from suppliers and ports to warehouses, and between warehouses.`;
}

// Why a link by rail or by water could not be routed, as the router said (routing.mjs, routeAlong; or 'none' when no
// line of the mode was loaded), in words naming its sites.
export function modeLegProblem(leg, mode, from, to) {
    const { noun, reach } = modes[mode];
    if (leg.problem === 'none') return `No ${noun} is loaded for this area, so ${from} → ${to} cannot go by ${mode}: load the area again to fetch the ${noun === 'railway' ? 'railways' : 'waterways'}.`;
    if (leg.problem === 'apart') return `No ${noun} loaded joins ${from} and ${to}: the ${noun === 'railway' ? 'lines' : 'waterways'} at the two ends do not meet in the area loaded.`;
    const site = leg.end === 'from' ? from : to;
    if (leg.kilometres === null || leg.kilometres === undefined) return `${site} is more than ${maximumSnapKilometres} km from any ${noun} loaded, so ${from} → ${to} cannot go by ${mode}.`;
    return `${site} is ${leg.kilometres.toFixed(1)} km from the ${noun}: a link by ${mode} reaches sites within ${reach} km of it. Place a site at the ${noun} (${mode === 'rail' ? 'a rail terminal' : 'an inland port'}) and link it to ${site} by road.`;
}

// ---- what is read out of OpenStreetMap ---------------------------------------------------------------------------

// The navigability class of a waterway for freight, from its tags: its CEMT class (the European classes, I for the
// smallest barges to VII for the largest pushed convoys; 0 is for leisure craft), or 'ship' where it is marked as
// navigable by ships with no class given. null when it is not known to be navigable for freight.
const cemtClasses = /^(I|II|III|IV|Va|Vb|VIa|VIb|VIc|VII)$/i;
export function freightClass(tags = {}) {
    if (tags.ship === 'no') return null;
    const cemt = String(tags.CEMT ?? tags.cemt ?? '').trim();
    if (cemtClasses.test(cemt)) return cemt;
    if (tags.ship === 'yes' || tags.ship === 'designated') return 'ship';
    return null;
}

// Railways a freight train may run on: OpenStreetMap's main, branch and industrial lines, not sidings, spurs, yards or
// crossovers (a site within reach of the line is at it), and not those disused, abandoned, preserved or for trams.
export const isFreightRail = (tags = {}) => tags.railway === 'rail' && !/^(siding|spur|yard|crossover)$/.test(tags.service ?? '') && !/^(tourism|military)$/.test(tags.usage ?? '');

// Joins lines that meet end to end into closed rings (a lake drawn as several ways, as most large ones are). `lines` are
// arrays of { lat, lon }; a line already closed is a ring as it is. Returns { rings, open } (how many pieces could not
// be closed: cut off at the edge of the data, usually).
export function assembleRings(lines) {
    const key = (point) => `${point.lat.toFixed(7)},${point.lon.toFixed(7)}`;
    const closed = (line) => line.length > 3 && key(line[0]) === key(line.at(-1));
    const rings = [];
    const pieces = [];
    for (const line of lines) {
        if (!Array.isArray(line) || line.length < 2) continue;
        if (closed(line)) rings.push(line); else pieces.push(line);
    }
    // Each piece by its ends.
    const byEnd = new Map();
    const note = (index) => {
        for (const point of [pieces[index][0], pieces[index].at(-1)]) {
            const at = key(point);
            if (!byEnd.has(at)) byEnd.set(at, []);
            byEnd.get(at).push(index);
        }
    };
    pieces.forEach((_piece, index) => note(index));
    const used = new Uint8Array(pieces.length);
    let open = 0;
    for (let start = 0; start < pieces.length; start += 1) {
        if (used[start]) continue;
        used[start] = 1;
        const ring = [...pieces[start]];
        for (;;) {
            if (ring.length > 3 && key(ring[0]) === key(ring.at(-1))) break;
            const next = (byEnd.get(key(ring.at(-1))) ?? []).find((index) => !used[index]);
            if (next === undefined) break;
            used[next] = 1;
            const piece = key(pieces[next][0]) === key(ring.at(-1)) ? pieces[next] : [...pieces[next]].reverse();
            ring.push(...piece.slice(1));
        }
        if (ring.length > 3 && key(ring[0]) === key(ring.at(-1))) rings.push(ring); else open += 1;
    }
    return { rings, open };
}

// Water to draw, from features read by readOverpass: lakes, reservoirs and rivers mapped as areas (a way's outline,
// or a relation's outer and inner rings, its islands), and rivers and canals as lines with whether freight can use
// them. Returns { areas: [{ name, rings }], lines: [{ name, waterway, freight, points }], open } (`open`: pieces of
// outlines that could not be closed).
export function waterOf(features) {
    const areas = [];
    const lines = [];
    let open = 0;
    for (const feature of features) {
        const tags = feature.tags ?? {};
        const isArea = tags.natural === 'water' || tags.waterway === 'riverbank';
        if (isArea && feature.ring) {
            areas.push({ name: tags.name ?? null, rings: [feature.ring] });
        } else if (isArea && feature.members?.length) {
            const outer = assembleRings(feature.members.filter((member) => member.role !== 'inner').map((member) => member.geometry));
            const inner = assembleRings(feature.members.filter((member) => member.role === 'inner').map((member) => member.geometry));
            open += outer.open + inner.open;
            if (outer.rings.length) areas.push({ name: tags.name ?? null, rings: [...outer.rings, ...inner.rings] });
        } else if (/^(river|canal|fairway)$/.test(tags.waterway ?? '') && feature.line) {
            lines.push({ name: tags.name ?? null, waterway: tags.waterway, freight: freightClass(tags), points: feature.line });
        }
    }
    return { areas, lines, open };
}

// ---- graphs to route over ----------------------------------------------------------------------------------------

// The speed a line's edges are timed at, in km/h, before a link's vehicles set its time (a link takes at least its
// length at its slowest vehicle's top speed, as on the roads): a railway's posted limit where it has one, else 100; a
// waterway 30, faster than any barge, so the barge's own speed decides.
const lineSpeed = { rail: (tags) => { const posted = Number.parseFloat(tags.maxspeed); return Number.isFinite(posted) && posted > 0 ? posted : 100; }, water: () => 30 };

// A graph of a mode's lines, in the form buildRoadGraph gives (roadGraph.mjs), for compactRoadGraph and the router:
// every node of a line is a vertex, every stretch an edge both ways with its length and time. Unlike the roads, every
// part is kept, not only the largest: a canal that joins nothing is still a waterway, and a link between two parts
// that do not meet is refused, not estimated. `features` are readOverpass's, with node ids.
export function buildLineGraph(features, mode) {
    const wanted = mode === 'rail' ? (tags) => isFreightRail(tags) : (tags) => /^(river|canal|fairway)$/.test(tags.waterway ?? '') && freightClass(tags) !== null;
    const speedOf = lineSpeed[mode];
    const vertices = new Map();
    const vertex = (id, point) => {
        if (!vertices.has(id)) vertices.set(id, { id, lat: point.lat, lon: point.lon, edges: [] });
        return vertices.get(id);
    };
    let kilometres = 0;
    for (const feature of features) {
        const geometry = feature.line ?? feature.ring;
        if (!wanted(feature.tags ?? {}) || !Array.isArray(feature.nodes) || geometry?.length !== feature.nodes.length) continue;
        const speed = speedOf(feature.tags);
        for (let index = 1; index < feature.nodes.length; index += 1) {
            const from = vertex(feature.nodes[index - 1], geometry[index - 1]);
            const to = vertex(feature.nodes[index], geometry[index]);
            if (from === to) continue;
            const metres = distance(geometry[index - 1], geometry[index]);
            kilometres += metres / 1000;
            from.edges.push({ to: to.id, metres, hours: metres / 1000 / speed });
            to.edges.push({ to: from.id, metres, hours: metres / 1000 / speed });
        }
    }
    return { vertices, mainVertices: [...vertices.values()], kilometres };
}
