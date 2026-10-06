/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Routing for the map-first workflow: the compacted road graph, snapping through the grid, A*, and the
// nearest source for any point.

import assert from 'node:assert/strict';
import test from 'node:test';
import { distance } from '../../packages/toolbox/lib/geo.mjs';
import { readOverpass } from '../../packages/toolbox/lib/overpass.mjs';
import { buildRoadGraph, createRouter, maximumSnapKilometres } from '../../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter, geometryMetres } from '../../packages/toolbox/lib/routing.mjs';
import { gridRoads, randomPoint, seeded } from '../fixtures/roadGrid.mjs';
import { syntheticBbox, syntheticRegion } from '../fixtures/syntheticRegion.mjs';

const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);
const syntheticGraph = () => buildRoadGraph(readOverpass(syntheticRegion().roads));
const pathLength = (points) => points.slice(1).reduce((total, point, index) => total + distance(points[index], point), 0);

test('compacting keeps the main network only, joins chains between junctions and keeps every kilometre', () => {
    const graph = syntheticGraph();
    const compact = compactRoadGraph(graph);
    // The synthetic region's main network has 108 road nodes but few junctions.
    assert.ok(compact.vertices.length < graph.mainVertices.length / 4, `${compact.vertices.length} vertices from ${graph.mainVertices.length}`);
    const unique = new Map();
    for (const vertex of graph.mainVertices) {
        for (const edge of vertex.edges) {
            const key = [vertex.id, edge.to].sort().join('|');
            unique.set(key, Math.min(unique.get(key) ?? Infinity, edge.metres));
        }
    }
    const mainKilometres = [...unique.values()].reduce((total, value) => total + value, 0) / 1000;
    const compactKilometres = compact.edges.reduce((total, edge) => total + edge[2], 0) / 1000;
    close(compactKilometres, mainKilometres, 0.01, 'kilometres kept');
    // Every edge's geometry runs from its start vertex to its end vertex.
    for (const [from, to, , , flat] of compact.edges) {
        assert.deepEqual([flat[0], flat[1]], compact.vertices[from]);
        assert.deepEqual([flat.at(-2), flat.at(-1)], compact.vertices[to]);
    }
    // Plain arrays, so the window gets it as JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(compact)), compact);
});

test('a ring road with no junction on it is compacted too', () => {
    const ring = Array.from({ length: 9 }, (_, index) => ({ lat: 10 + 0.01 * Math.cos(index / 8 * 2 * Math.PI), lon: 20 + 0.01 * Math.sin(index / 8 * 2 * Math.PI) }));
    const nodes = [1, 2, 3, 4, 5, 6, 7, 8, 1];
    const graph = buildRoadGraph([{ tags: { highway: 'primary' }, nodes, line: ring, point: ring[0] }]);
    const compact = compactRoadGraph(graph);
    assert.equal(compact.edges.length, 1);
    const router = createNetworkRouter(compact);
    const leg = router.routeOnRoads(ring[0], ring[4]);
    assert.equal(leg.basis, 'routed');
    close(leg.kilometres, pathLength(ring) / 2 / 1000, 0.01, 'half way round');
});

test('between road nodes, the compacted router finds the same times as the full graph, to within its simplified geometry', () => {
    const graph = syntheticGraph();
    const full = createRouter(graph);
    const router = createNetworkRouter(compactRoadGraph(graph));
    const random = seeded(7);
    const nodes = graph.mainVertices;
    for (let index = 0; index < 60; index += 1) {
        const a = nodes[Math.floor(random() * nodes.length)];
        const b = nodes[Math.floor(random() * nodes.length)];
        const expected = full.routeOnRoads(a, b);
        const found = router.routeOnRoads(a, b);
        assert.equal(found.basis, 'routed');
        // A road node dropped by the simplification lies within geometryMetres of the road drawn: an access leg of at
        // most that much at each end.
        const slack = 2 * geometryMetres / 1000 * 1.3;
        close(found.hours, expected.hours, slack / 30 + 1e-6, `hours from ${a.id} to ${b.id}`);
        close(found.kilometres, expected.kilometres, slack + 0.002, `km from ${a.id} to ${b.id}`);
    }
});

test('the grid snaps every point onto the nearest point of the nearest road, as a search of every segment does', () => {
    const graph = syntheticGraph();
    const compact = compactRoadGraph(graph);
    const router = createNetworkRouter(compact);
    const random = seeded(11);
    const segments = compact.edges.flatMap(([, , , , flat]) => Array.from({ length: flat.length / 2 - 1 }, (_, index) => [{ lat: flat[2 * index], lon: flat[2 * index + 1] }, { lat: flat[2 * index + 2], lon: flat[2 * index + 3] }]));
    const nearest = (point) => Math.min(...segments.map(([a, b]) => {
        // The nearest point on a short segment, by fine steps: slow, and independent of the router's projection.
        let best = Infinity;
        for (let step = 0; step <= 200; step += 1) best = Math.min(best, distance(point, { lat: a.lat + (b.lat - a.lat) * step / 200, lon: a.lon + (b.lon - a.lon) * step / 200 }));
        return best;
    }));
    for (let index = 0; index < 40; index += 1) {
        const point = randomPoint(random, syntheticBbox);
        const snapped = router.snap(point);
        const expected = nearest(point);
        if (expected > maximumSnapKilometres * 1000) { assert.equal(snapped, null); continue; }
        close(snapped.metres, expected, 15, `snap distance at ${point.lat},${point.lon}`);
    }
    // A point far out at sea snaps to nothing, and its legs are straight-line estimates.
    const atSea = { lat: -31, lon: -21 };
    assert.equal(router.snap(atSea), null);
    assert.equal(router.route(atSea, { lat: -29.9, lon: -19.7 }).basis, 'straight-line');
});

test('A* finds the same legs as Dijkstra, and its road follows the roads from one site to the other', () => {
    const { features, bounds } = gridRoads({ size: 30, spacing: 250 });
    const compact = compactRoadGraph(buildRoadGraph(features));
    const fast = createNetworkRouter(compact);
    const plain = createNetworkRouter(compact, { astar: false });
    const random = seeded(3);
    for (let index = 0; index < 100; index += 1) {
        const a = randomPoint(random, bounds);
        const b = randomPoint(random, bounds);
        const found = fast.routeOnRoads(a, b);
        const expected = plain.routeOnRoads(a, b);
        close(found.hours, expected.hours, 1e-9, `leg ${index}`);
        close(found.kilometres, expected.kilometres, 1e-6, `leg ${index}`);
        const points = found.path.points;
        assert.deepEqual(points[0], { lat: Number(a.lat.toFixed(6)), lon: Number(a.lon.toFixed(6)) });
        assert.deepEqual(points.at(-1), { lat: Number(b.lat.toFixed(6)), lon: Number(b.lon.toFixed(6)) });
        // The drawn road is as long as the leg: its road part plus the two access legs (drawn straight, counted with
        // a detour factor).
        const access = (fast.snap(a).metres + fast.snap(b).metres) / 1000;
        const drawn = pathLength(points) / 1000;
        close(drawn - access, found.kilometres - access * 1.3, 0.01 + 0.002 * found.kilometres, `drawn length of leg ${index}`);
    }
});

test('two sites on one road are routed along it, in either direction', () => {
    const { features, at } = gridRoads({ size: 6, spacing: 500 });
    const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(features)));
    const a = { lat: at(0, 1.2).lat, lon: at(0, 1.2).lon };
    const b = { lat: at(0, 3.7).lat, lon: at(0, 3.7).lon };
    const forward = router.routeOnRoads(a, b);
    const back = router.routeOnRoads(b, a);
    close(forward.kilometres, 1.25, 0.005, 'two and a half blocks');
    close(back.kilometres, forward.kilometres, 1e-9, 'either way');
    assert.ok(forward.path.points.every((point) => Math.abs(point.lat - a.lat) < 1e-6), 'along the row');
});

test('legs between sites a few hundred metres apart go by local streets', () => {
    const { features, at } = gridRoads({ size: 6, spacing: 2000 });
    const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(features)));
    // In the middle of a 2 km block, 300 m apart: the roads around the block are slower.
    const a = at(1.5, 1.45);
    const b = at(1.5, 1.6);
    assert.equal(router.route(a, b).basis, 'local');
});

test('the nearest source for any point is the one the roads reach soonest', () => {
    const { features, bounds, at } = gridRoads({ size: 25, spacing: 300 });
    const router = createNetworkRouter(compactRoadGraph(buildRoadGraph(features)));
    const sources = [
        { id: 'north', ...at(22, 4) }, { id: 'south', ...at(2, 20) }, { id: 'centre', ...at(12.3, 12.6) }
    ];
    const nearest = router.nearestSources(sources);
    const random = seeded(5);
    for (let index = 0; index < 80; index += 1) {
        const target = randomPoint(random, bounds);
        const found = nearest(target);
        const legs = sources.map((source) => ({ id: source.id, hours: router.route(source, target).hours })).sort((x, y) => x.hours - y.hours);
        close(found.hours, legs[0].hours, 1e-9, `nearest at ${index}`);
        if (legs[1].hours - legs[0].hours > 1e-9) assert.equal(found.id, legs[0].id);
    }
    assert.equal(router.nearestSources([])({ lat: 25, lon: 55 }), null);
});

test('with no roads, every leg and every nearest source is a straight-line estimate', () => {
    const router = createNetworkRouter(null);
    const a = { lat: 0, lon: 0 };
    const b = { lat: 0, lon: 0.5 };
    const leg = router.route(a, b);
    assert.equal(leg.basis, 'straight-line');
    close(leg.kilometres, distance(a, b) / 1000 * 1.3, 1e-9, 'lengthened for detours');
    assert.equal(router.nearestSources([{ id: 'x', ...a }])(b).id, 'x');
});

test('a city of 40,000 road nodes routes a leg in milliseconds, and labels every node with its nearest source in well under a second', () => {
    const { features, bounds } = gridRoads({ size: 200, spacing: 150 });
    const graph = buildRoadGraph(features);
    let started = performance.now();
    const compact = compactRoadGraph(graph);
    const router = createNetworkRouter(compact);
    const preparing = performance.now() - started;
    const random = seeded(9);
    started = performance.now();
    for (let index = 0; index < 50; index += 1) router.route(randomPoint(random, bounds), randomPoint(random, bounds));
    const perLeg = (performance.now() - started) / 50;
    started = performance.now();
    const nearest = router.nearestSources(Array.from({ length: 5 }, (_, index) => ({ id: index, ...randomPoint(random, bounds) })));
    for (let index = 0; index < 100; index += 1) nearest(randomPoint(random, bounds));
    const labelling = performance.now() - started;
    assert.ok(perLeg < 60, `a leg took ${perLeg.toFixed(1)} ms`);
    assert.ok(labelling < 800, `labelling took ${labelling.toFixed(0)} ms`);
    assert.ok(preparing < 3000, `preparing took ${preparing.toFixed(0)} ms`);
});
