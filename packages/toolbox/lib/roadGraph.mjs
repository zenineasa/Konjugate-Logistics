/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A road graph from OpenStreetMap's major roads, small enough to route in the add-on itself: every
// road node is a vertex (so a site snaps onto the road itself, not just to a junction), and each edge
// carries its length and its travel time at a speed set by the road's class. Roads are treated as
// two-way. A routed answer also gives the road nodes it follows, so a map can draw the lane along its road.

import { distance } from './geo.mjs';

// Typical free-flow speeds in km/h by road class: assumptions, until live speeds replace them.
export const roadSpeeds = {
    motorway: 100, trunk: 80, primary: 60, motorway_link: 50, trunk_link: 40, primary_link: 40
};
// From a site to the nearest major road, and when no route is found: a straight line lengthened by
// a detour factor, at an assumed speed.
export const detourFactor = 1.3;
export const accessSpeed = 30;
export const fallbackSpeed = 50;
// A site further than this from the road graph is not routed.
export const maximumSnapKilometres = 15;

function speedOf(tags) {
    const byClass = roadSpeeds[tags.highway] ?? 50;
    const posted = Number.parseFloat(tags.maxspeed);
    // A posted limit is rarely the average speed: take 85% of it, never above the class speed.
    return Number.isFinite(posted) && posted > 0 ? Math.min(byClass, 0.85 * posted) : byClass;
}

// `features` are road ways from readOverpass (with node ids and geometry).
export function buildRoadGraph(features) {
    const ways = features.filter((feature) => feature.tags.highway && Array.isArray(feature.nodes) && (feature.line ?? feature.ring)?.length === feature.nodes.length);
    const vertices = new Map(); // osm node id -> { id, lat, lon, edges: [{ to, metres, hours }] }
    const vertex = (id, point) => {
        if (!vertices.has(id)) vertices.set(id, { id, lat: point.lat, lon: point.lon, edges: [] });
        return vertices.get(id);
    };
    const kilometresByClass = {};
    for (const way of ways) {
        const geometry = way.line ?? way.ring;
        const speed = speedOf(way.tags);
        for (let index = 1; index < way.nodes.length; index += 1) {
            const from = vertex(way.nodes[index - 1], geometry[index - 1]);
            const to = vertex(way.nodes[index], geometry[index]);
            const metres = distance(geometry[index - 1], geometry[index]);
            kilometresByClass[way.tags.highway] = (kilometresByClass[way.tags.highway] ?? 0) + metres / 1000;
            if (to === from) continue;
            const hours = metres / 1000 / speed;
            from.edges.push({ to: to.id, metres, hours });
            to.edges.push({ to: from.id, metres, hours });
        }
    }
    // Connected components, so a site snaps to the main network rather than to an isolated fragment.
    const component = new Map();
    const sizes = [];
    for (const start of vertices.keys()) {
        if (component.has(start)) continue;
        const label = sizes.length;
        const stack = [start];
        component.set(start, label);
        let size = 0;
        while (stack.length) {
            const current = stack.pop();
            size += 1;
            for (const edge of vertices.get(current).edges) if (!component.has(edge.to)) { component.set(edge.to, label); stack.push(edge.to); }
        }
        sizes.push(size);
    }
    const main = sizes.length ? sizes.indexOf(Math.max(...sizes)) : -1;
    const mainVertices = [...vertices.values()].filter((item) => component.get(item.id) === main);
    return { vertices, mainVertices, kilometresByClass, components: sizes.length };
}

function nearestVertex(graph, point) {
    let best = null;
    let bestMetres = Infinity;
    for (const candidate of graph.mainVertices) {
        const metres = distance(point, candidate);
        if (metres < bestMetres) { best = candidate; bestMetres = metres; }
    }
    return best ? { vertex: best, metres: bestMetres } : null;
}

// Shortest travel times from one vertex to every other (Dijkstra with a binary heap).
function shortestFrom(graph, sourceId) {
    const hours = new Map([[sourceId, 0]]);
    const metres = new Map([[sourceId, 0]]);
    // Each vertex's predecessor on its shortest path, so a route can be walked back to give its road.
    const previous = new Map();
    const heap = [[0, sourceId]];
    const push = (item) => {
        heap.push(item);
        let index = heap.length - 1;
        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (heap[parent][0] <= heap[index][0]) break;
            [heap[parent], heap[index]] = [heap[index], heap[parent]];
            index = parent;
        }
    };
    const pop = () => {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
            heap[0] = last;
            let index = 0;
            for (;;) {
                const left = 2 * index + 1;
                const right = left + 1;
                let smallest = index;
                if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left;
                if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right;
                if (smallest === index) break;
                [heap[smallest], heap[index]] = [heap[index], heap[smallest]];
                index = smallest;
            }
        }
        return top;
    };
    while (heap.length) {
        const [time, id] = pop();
        if (time > hours.get(id)) continue;
        for (const edge of graph.vertices.get(id).edges) {
            const next = time + edge.hours;
            if (next < (hours.get(edge.to) ?? Infinity)) {
                hours.set(edge.to, next);
                metres.set(edge.to, metres.get(id) + edge.metres);
                previous.set(edge.to, id);
                push([next, edge.to]);
            }
        }
    }
    return { hours, metres, previous };
}

// A router between { lat, lon } points. Each answer says how it was found: `routed` over the road
// graph (with a straight access leg at each end), `local` when two sites are close enough that local
// streets beat the major roads, or `straight-line` when a site is too far from the graph or the graph
// is empty. Trees from each origin are cached.
export function createRouter(graph) {
    const trees = new Map();
    const snaps = new Map();
    const snap = (point) => {
        const key = `${point.lat},${point.lon}`;
        if (!snaps.has(key)) {
            const nearest = graph ? nearestVertex(graph, point) : null;
            snaps.set(key, nearest && nearest.metres <= maximumSnapKilometres * 1000 ? nearest : null);
        }
        return snaps.get(key);
    };
    const straight = (a, b) => {
        const kilometres = distance(a, b) / 1000 * detourFactor;
        return { kilometres, hours: kilometres / fallbackSpeed, basis: 'straight-line' };
    };
    const router = {
        snap,
        route(a, b) {
            // Two sites close together are joined by local streets, which the graph of major roads leaves out.
            const localKilometres = distance(a, b) / 1000 * detourFactor;
            const local = { kilometres: localKilometres, hours: localKilometres / accessSpeed, basis: 'local' };
            const routed = router.routeOnRoads(a, b);
            return routed.basis === 'routed' && local.hours < routed.hours ? local : routed;
        },
        routeOnRoads(a, b) {
            const from = snap(a);
            const to = snap(b);
            if (!from || !to) return straight(a, b);
            if (!trees.has(from.vertex.id)) trees.set(from.vertex.id, shortestFrom(graph, from.vertex.id));
            const tree = trees.get(from.vertex.id);
            const roadHours = tree.hours.get(to.vertex.id);
            if (roadHours === undefined) return straight(a, b);
            const accessKilometres = (from.metres + to.metres) / 1000 * detourFactor;
            // The road nodes from the one nearest `a` to the one nearest `b`: ids, and their points.
            const ids = [to.vertex.id];
            while (ids[ids.length - 1] !== from.vertex.id) ids.push(tree.previous.get(ids[ids.length - 1]));
            ids.reverse();
            return {
                kilometres: tree.metres.get(to.vertex.id) / 1000 + accessKilometres,
                hours: roadHours + accessKilometres / accessSpeed,
                basis: 'routed',
                path: { ids, points: ids.map((id) => ({ lat: graph.vertices.get(id).lat, lon: graph.vertices.get(id).lon })) }
            };
        }
    };
    return router;
}
