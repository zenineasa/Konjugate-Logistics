/* Copyright © 2026 Zenin Easa Panthakkalakath */

// How fast the map-first routing is on a real region: reads the road answers a live region check cached in
// out/regionCache/<region>/ (fetch one first with scripts/liveRegionCheck.mjs), compacts the graph, and times
// snapping, single legs, the nearest-source labelling and the re-routing of one moved site's links.
//
// Usage: node scripts/routingCheck.mjs [region folder name]   (the largest cached region by default)

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readOverpass } from '../packages/toolbox/lib/overpass.mjs';
import { buildRoadGraph } from '../packages/toolbox/lib/roadGraph.mjs';
import { compactRoadGraph, createNetworkRouter } from '../packages/toolbox/lib/routing.mjs';
import { logisticsRoot } from './konjugatePaths.mjs';
import { seeded } from '../tests/fixtures/roadGrid.mjs';

const root = join(logisticsRoot, 'out', 'regionCache');
const folders = (await readdir(root)).filter((name) => /^-?[\d.]+_-?[\d.]+_-?[\d.]+_-?[\d.]+$/.test(name));
if (!folders.length) throw new Error('No cached region: run scripts/liveRegionCheck.mjs for a region first.');
const sizes = await Promise.all(folders.map(async (name) => ({ name, files: (await readdir(join(root, name))).filter((file) => /^roads-.*\.json$/.test(file)) })));
const chosen = process.argv[2] ?? sizes.sort((a, b) => b.files.length - a.files.length)[0].name;

const files = (await readdir(join(root, chosen))).filter((file) => /^roads-.*\.json$/.test(file));
let bytes = 0;
const answers = [];
for (const file of files) {
    bytes += (await stat(join(root, chosen, file))).size;
    answers.push(await readFile(join(root, chosen, file), 'utf8'));
}
const time = (work) => { const started = performance.now(); const answer = work(); return [answer, performance.now() - started]; };
const [graph, building] = time(() => buildRoadGraph(readOverpass(answers)));
const [compact, compacting] = time(() => compactRoadGraph(graph));
const [router, indexing] = time(() => createNetworkRouter(compact));
const random = seeded(1);
// Points near the roads: a road vertex nudged up to 2 km.
const vertices = compact.vertices;
const nearRoad = () => {
    const [lat, lon] = vertices[Math.floor(random() * vertices.length)];
    return { lat: lat + (random() - 0.5) * 0.036, lon: lon + (random() - 0.5) * 0.036 };
};
const [, snapping] = time(() => { for (let index = 0; index < 200; index += 1) router.snap(nearRoad()); });
const [, routing] = time(() => { for (let index = 0; index < 100; index += 1) router.route(nearRoad(), nearRoad()); });
const warehouses = Array.from({ length: 5 }, (_, index) => ({ id: index, ...nearRoad() }));
const [nearest, labelling] = time(() => router.nearestSources(warehouses));
// A store moved: its one supply link re-routed, and the nearest warehouse looked up again.
const store = nearRoad();
const [, moving] = time(() => { router.route(warehouses[nearest(store).id], store); });
const json = JSON.stringify(compact).length;
console.log(`${chosen}: ${files.length} road answers, ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`  graph: ${graph.vertices.size} road nodes (${graph.mainVertices.length} on the main network) in ${building.toFixed(0)} ms`);
console.log(`  compacted: ${compact.vertices.length} vertices and ${compact.edges.length} edges, ${(json / 1048576).toFixed(1)} MB as JSON, in ${compacting.toFixed(0)} ms; grid in ${indexing.toFixed(0)} ms`);
console.log(`  snap: ${(snapping / 200).toFixed(2)} ms; one leg: ${(routing / 100).toFixed(1)} ms; nearest of 5 warehouses for every road: ${labelling.toFixed(0)} ms; a moved store re-routed: ${moving.toFixed(1)} ms`);
