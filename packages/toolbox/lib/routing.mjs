/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Routing fast enough to follow the user as they place and move sites. The road graph from
// buildRoadGraph is compacted once (a chain of road nodes with no junction becomes one edge that keeps
// its geometry), sent to the window as plain arrays, and routed there:
//
//   - a site snaps onto the nearest point of the nearest road segment, found through a grid of about
//     1 km cells, not onto the nearest road node
//   - one leg is routed with A*, which stops once the destination is settled, and legs are cached by
//     their end points, so moving one site re-routes only the legs that touch it
//   - the nearest of several sources (warehouses, suppliers) for any point comes from one multi-source
//     Dijkstra over the whole graph, run again only when a source changes
//
// Legs say how they were found, as createRouter's do: `routed` over the roads (with an access leg at each
// end), `local` when two sites are close enough that local streets beat the roads mapped, or
// `straight-line` when a site is too far from any road.

import { distance } from './geo.mjs';
import { simplify } from './mapData.mjs';
import { accessSpeed, detourFactor, fallbackSpeed, maximumSnapKilometres } from './roadGraph.mjs';

// An edge's geometry is simplified to within this many metres of the road: small enough for the window to receive
// a region's roads, close enough that a site snaps where it is. Its length and time stay the road's own.
export const geometryMetres = 8;

const round = (value, digits) => Number(value.toFixed(digits));

// ---- compacting -----------------------------------------------------------------------------------------------

// `graph` is buildRoadGraph's. Only its main network is kept, as createRouter snaps only to it. Returns
// { vertices: [[lat, lon]], edges: [[from, to, metres, hours, [lat, lon, lat, lon, ...]]] }, every edge two-way, its
// geometry running from `from` to `to`.
export function compactRoadGraph(graph) {
    const main = new Map(graph.mainVertices.map((vertex) => [vertex.id, vertex]));
    // The fastest edge to each distinct neighbour: two ways drawn over each other are one road.
    const neighbours = new Map();
    for (const vertex of main.values()) {
        const best = new Map();
        for (const edge of vertex.edges) {
            if (!main.has(edge.to) || edge.to === vertex.id) continue;
            const known = best.get(edge.to);
            if (!known || edge.hours < known.hours) best.set(edge.to, edge);
        }
        neighbours.set(vertex.id, best);
    }
    const junction = new Set([...main.keys()].filter((id) => neighbours.get(id).size !== 2));
    const index = new Map();
    const vertices = [];
    const vertexIndex = (id) => {
        if (!index.has(id)) {
            index.set(id, vertices.length);
            const vertex = main.get(id);
            vertices.push([round(vertex.lat, 5), round(vertex.lon, 5)]);
        }
        return index.get(id);
    };
    const edges = [];
    const walked = new Set(); // directed first steps already taken: `${from}>${to}`
    const walkFrom = (start) => {
        for (const first of neighbours.get(start).keys()) {
            if (walked.has(`${start}>${first}`)) continue;
            let previous = start;
            let current = first;
            let metres = 0;
            let hours = 0;
            const points = [main.get(start)];
            for (;;) {
                // Each step is walked both ways at once, so the chain is not walked again from its other end.
                walked.add(`${previous}>${current}`);
                walked.add(`${current}>${previous}`);
                const edge = neighbours.get(previous).get(current);
                metres += edge.metres;
                hours += edge.hours;
                points.push(main.get(current));
                if (junction.has(current)) break;
                const next = [...neighbours.get(current).keys()].find((id) => id !== previous);
                previous = current;
                current = next;
            }
            edges.push([vertexIndex(start), vertexIndex(current), round(metres, 1), round(hours, 7), simplify(points, geometryMetres).flatMap((point) => [round(point.lat, 5), round(point.lon, 5)])]);
        }
    };
    for (const id of junction) walkFrom(id);
    // A loop with no junction on it (a ring road on its own): start it anywhere.
    for (const id of main.keys()) {
        if ([...neighbours.get(id).keys()].some((next) => !walked.has(`${id}>${next}`))) {
            junction.add(id);
            walkFrom(id);
        }
    }
    return { vertices, edges };
}

// ---- a binary heap of [key, value] ------------------------------------------------------------------------------

class Heap {
    constructor() { this.items = []; }
    get size() { return this.items.length; }
    push(key, value) {
        const items = this.items;
        items.push([key, value]);
        let index = items.length - 1;
        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (items[parent][0] <= items[index][0]) break;
            [items[parent], items[index]] = [items[index], items[parent]];
            index = parent;
        }
    }
    pop() {
        const items = this.items;
        const top = items[0];
        const last = items.pop();
        if (items.length) {
            items[0] = last;
            let index = 0;
            for (;;) {
                const left = 2 * index + 1;
                const right = left + 1;
                let smallest = index;
                if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
                if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
                if (smallest === index) break;
                [items[smallest], items[index]] = [items[index], items[smallest]];
                index = smallest;
            }
        }
        return top;
    }
}

// ---- the router ----------------------------------------------------------------------------------------------

export const gridCellKilometres = 1;

// `compact` is compactRoadGraph's answer (or null, or an empty graph: every leg is then a straight-line estimate).
// `astar: false` routes with plain Dijkstra instead, for tests that check A* finds the same legs.
export function createNetworkRouter(compact, { astar = true } = {}) {
    const vertices = compact?.vertices ?? [];
    const edges = (compact?.edges ?? []).map(([from, to, metres, hours, flat]) => {
        const points = [];
        for (let index = 0; index < flat.length; index += 2) points.push({ lat: flat[index], lon: flat[index + 1] });
        // Metres from the edge's start to each of its points, scaled so they add up to the edge's own length.
        const cumulative = [0];
        for (let index = 1; index < points.length; index += 1) cumulative.push(cumulative[index - 1] + distance(points[index - 1], points[index]));
        const scale = cumulative.at(-1) > 0 ? metres / cumulative.at(-1) : 0;
        return { from, to, metres, hours, points, cumulative: cumulative.map((value) => value * scale) };
    });
    const adjacent = vertices.map(() => []);
    for (const [index, edge] of edges.entries()) {
        adjacent[edge.from].push(index);
        if (edge.to !== edge.from) adjacent[edge.to].push(index);
    }
    const fastest = Math.max(1, ...edges.filter((edge) => edge.hours > 0).map((edge) => edge.metres / 1000 / edge.hours));
    const point = (index) => ({ lat: vertices[index][0], lon: vertices[index][1] });

    // The grid: each cell lists the [edge, segment] pairs whose bounds it overlaps.
    const latitude = vertices.length ? vertices.reduce((total, vertex) => total + vertex[0], 0) / vertices.length : 0;
    const cellLat = gridCellKilometres / 111.32;
    const cellLon = cellLat / Math.max(0.05, Math.cos(latitude * Math.PI / 180));
    const cellMetres = gridCellKilometres * 1000;
    const grid = new Map();
    const cellOf = (lat, lon) => [Math.floor(lat / cellLat), Math.floor(lon / cellLon)];
    for (const [edgeIndex, edge] of edges.entries()) {
        for (let segment = 1; segment < edge.points.length; segment += 1) {
            const a = edge.points[segment - 1];
            const b = edge.points[segment];
            const [r0, c0] = cellOf(Math.min(a.lat, b.lat), Math.min(a.lon, b.lon));
            const [r1, c1] = cellOf(Math.max(a.lat, b.lat), Math.max(a.lon, b.lon));
            for (let row = r0; row <= r1; row += 1) {
                for (let column = c0; column <= c1; column += 1) {
                    const key = `${row},${column}`;
                    if (!grid.has(key)) grid.set(key, []);
                    grid.get(key).push(edgeIndex, segment);
                }
            }
        }
    }

    // The nearest point on one segment to `target`, on a local plane around it.
    const project = (edge, segment, target) => {
        const a = edge.points[segment - 1];
        const b = edge.points[segment];
        const cos = Math.cos(target.lat * Math.PI / 180);
        const ax = (a.lon - target.lon) * cos;
        const ay = a.lat - target.lat;
        const bx = (b.lon - target.lon) * cos;
        const by = b.lat - target.lat;
        const dx = bx - ax;
        const dy = by - ay;
        const length = dx * dx + dy * dy;
        const t = length > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
        const snapped = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
        return { t, point: snapped, metres: distance(target, snapped) };
    };

    const snaps = new Map();
    // The nearest point on the roads, within maximumSnapKilometres, or null: { edge, segment, along (metres from the
    // edge's start), metres (from the site), point }.
    const snap = (target) => {
        const key = `${target.lat},${target.lon}`;
        if (snaps.has(key)) return snaps.get(key);
        let best = null;
        if (edges.length) {
            const [row, column] = cellOf(target.lat, target.lon);
            const rings = Math.ceil(maximumSnapKilometres / gridCellKilometres) + 1;
            for (let ring = 0; ring <= rings; ring += 1) {
                for (let r = row - ring; r <= row + ring; r += 1) {
                    for (let c = column - ring; c <= column + ring; c += 1) {
                        if (Math.max(Math.abs(r - row), Math.abs(c - column)) !== ring) continue;
                        const listed = grid.get(`${r},${c}`);
                        if (!listed) continue;
                        for (let item = 0; item < listed.length; item += 2) {
                            const edge = edges[listed[item]];
                            const segment = listed[item + 1];
                            const found = project(edge, segment, target);
                            if (!best || found.metres < best.metres) {
                                const start = edge.cumulative[segment - 1];
                                best = { edge: listed[item], segment, along: start + (edge.cumulative[segment] - start) * found.t, metres: found.metres, point: found.point };
                            }
                        }
                    }
                }
                // Every cell further out is at least `ring` cells away.
                if (best && best.metres <= ring * cellMetres) break;
            }
        }
        const answer = best && best.metres <= maximumSnapKilometres * 1000 ? best : null;
        if (snaps.size > 20000) snaps.clear();
        snaps.set(key, answer);
        return answer;
    };

    // From a snapped point to each end of its edge: the hours, and the points along the way.
    const toEnds = (snapped) => {
        const edge = edges[snapped.edge];
        const share = edge.metres > 0 ? snapped.along / edge.metres : 0;
        const before = edge.points.slice(0, snapped.segment);
        const after = edge.points.slice(snapped.segment);
        return [
            { vertex: edge.from, hours: share * edge.hours, metres: snapped.along, points: [snapped.point, ...before.reverse()] },
            { vertex: edge.to, hours: (1 - share) * edge.hours, metres: edge.metres - snapped.along, points: [snapped.point, ...after] }
        ];
    };
    const straight = (a, b) => {
        const kilometres = distance(a, b) / 1000 * detourFactor;
        return { kilometres, hours: kilometres / fallbackSpeed, basis: 'straight-line' };
    };
    const accessHours = (metres) => metres / 1000 * detourFactor / accessSpeed;

    // A* from one snapped point to another, over the roads only.
    const roadLeg = (from, to) => {
        const starts = toEnds(from);
        const ends = toEnds(to);
        const goal = to.point;
        const heuristic = astar ? (vertex) => distance(point(vertex), goal) / 1000 / fastest : () => 0;
        let best = null;
        // On the same edge: straight along it.
        if (from.edge === to.edge) {
            const edge = edges[from.edge];
            const metres = Math.abs(to.along - from.along);
            const forward = to.along >= from.along;
            const inner = edge.points.slice(Math.min(from.segment, to.segment), Math.max(from.segment, to.segment));
            best = { hours: edge.metres > 0 ? metres / edge.metres * edge.hours : 0, metres, points: [from.point, ...(forward ? inner : inner.reverse()), to.point], direct: true };
        }
        const hours = new Map();
        const metresTo = new Map();
        const previous = new Map(); // vertex -> [vertex it was reached from, edge index] or ['start', which end]
        const heap = new Heap();
        for (const [which, start] of starts.entries()) {
            if (start.hours < (hours.get(start.vertex) ?? Infinity)) {
                hours.set(start.vertex, start.hours);
                metresTo.set(start.vertex, start.metres);
                previous.set(start.vertex, ['start', which]);
                heap.push(start.hours + heuristic(start.vertex), start.vertex);
            }
        }
        const endOf = new Map();
        for (const [which, end] of ends.entries()) {
            const known = endOf.get(end.vertex);
            if (!known || end.hours < known.end.hours) endOf.set(end.vertex, { end, which });
        }
        let reached = null;
        while (heap.size) {
            const [estimate, vertex] = heap.pop();
            if (best && estimate >= best.hours) break;
            const so = hours.get(vertex);
            if (estimate - heuristic(vertex) > so + 1e-12) continue;
            const ending = endOf.get(vertex);
            if (ending && (!best || so + ending.end.hours < best.hours)) {
                best = { hours: so + ending.end.hours, metres: metresTo.get(vertex) + ending.end.metres };
                reached = { vertex, ending };
            }
            for (const edgeIndex of adjacent[vertex]) {
                const edge = edges[edgeIndex];
                const next = edge.from === vertex ? edge.to : edge.from;
                const total = so + edge.hours;
                if (total < (hours.get(next) ?? Infinity)) {
                    hours.set(next, total);
                    metresTo.set(next, metresTo.get(vertex) + edge.metres);
                    previous.set(next, [vertex, edgeIndex]);
                    heap.push(total + heuristic(next), next);
                }
            }
        }
        if (!best) return null;
        if (!reached) return best;
        // Walk back: the points from `from` to the vertex reached, then along `to`'s edge into it.
        const chain = [];
        let vertex = reached.vertex;
        for (;;) {
            const [back, via] = previous.get(vertex);
            if (back === 'start') { chain.push(...[...starts[via].points].reverse()); break; }
            const edge = edges[via];
            const along = edge.from === back ? edge.points : [...edge.points].reverse();
            chain.push(...[...along].reverse().slice(0, -1));
            vertex = back;
        }
        chain.reverse();
        const into = [...reached.ending.end.points].reverse();
        return { ...best, points: [...chain, ...into.slice(1)] };
    };

    const legs = new Map();
    const router = {
        snap,
        fastestKilometresPerHour: fastest,
        size: { vertices: vertices.length, edges: edges.length },
        // Over the roads, by local streets when the sites are close and that is quicker, or a straight-line estimate.
        route(a, b) {
            const key = `${a.lat},${a.lon}|${b.lat},${b.lon}`;
            if (legs.has(key)) return legs.get(key);
            const routed = router.routeOnRoads(a, b);
            const localKilometres = distance(a, b) / 1000 * detourFactor;
            const local = { kilometres: localKilometres, hours: localKilometres / accessSpeed, basis: 'local' };
            const answer = routed.basis === 'routed' && local.hours < routed.hours ? local : routed;
            if (legs.size > 20000) legs.clear();
            legs.set(key, answer);
            return answer;
        },
        routeOnRoads(a, b) {
            const from = snap(a);
            const to = snap(b);
            if (!from || !to) return straight(a, b);
            const leg = roadLeg(from, to);
            if (!leg) return straight(a, b);
            const accessKilometres = (from.metres + to.metres) / 1000 * detourFactor;
            return {
                kilometres: leg.metres / 1000 + accessKilometres,
                hours: leg.hours + accessKilometres / accessSpeed,
                basis: 'routed',
                path: { points: [a, ...(leg.points ?? []), b].map((item) => ({ lat: round(item.lat, 6), lon: round(item.lon, 6) })) }
            };
        },
        // For each of `sources` ({ id, lat, lon }), one multi-source Dijkstra over the roads; returns a lookup giving
        // the nearest source to any point by travel time, { id, hours }, or null when there are no sources.
        nearestSources(sources) {
            const label = new Map(); // vertex -> { id, hours }
            const heap = new Heap();
            const unsnapped = [];
            const snappedSources = [];
            for (const source of sources) {
                const snapped = snap(source);
                if (!snapped) { unsnapped.push(source); continue; }
                snappedSources.push({ source, snapped });
                for (const end of toEnds(snapped)) {
                    const total = accessHours(snapped.metres) + end.hours;
                    if (total < (label.get(end.vertex)?.hours ?? Infinity)) {
                        label.set(end.vertex, { id: source.id, hours: total });
                        heap.push(total, end.vertex);
                    }
                }
            }
            while (heap.size) {
                const [time, vertex] = heap.pop();
                const current = label.get(vertex);
                if (time > current.hours) continue;
                for (const edgeIndex of adjacent[vertex]) {
                    const edge = edges[edgeIndex];
                    const next = edge.from === vertex ? edge.to : edge.from;
                    const total = time + edge.hours;
                    if (total < (label.get(next)?.hours ?? Infinity)) {
                        label.set(next, { id: current.id, hours: total });
                        heap.push(total, next);
                    }
                }
            }
            return (target) => {
                let best = null;
                const consider = (id, hours) => { if (!best || hours < best.hours) best = { id, hours }; };
                // Local streets, or a straight line, for every source: the sites may be next to each other.
                for (const source of sources) {
                    const kilometres = distance(source, target) / 1000 * detourFactor;
                    consider(source.id, kilometres / (unsnapped.includes(source) ? fallbackSpeed : accessSpeed));
                }
                const snapped = snap(target);
                if (snapped) {
                    for (const end of toEnds(snapped)) {
                        const reached = label.get(end.vertex);
                        if (reached) consider(reached.id, reached.hours + end.hours + accessHours(snapped.metres));
                    }
                    for (const { source, snapped: at } of snappedSources) {
                        if (at.edge !== snapped.edge) continue;
                        const edge = edges[at.edge];
                        const along = edge.metres > 0 ? Math.abs(at.along - snapped.along) / edge.metres * edge.hours : 0;
                        consider(source.id, along + accessHours(at.metres) + accessHours(snapped.metres));
                    }
                }
                return best;
            };
        }
    };
    return router;
}
