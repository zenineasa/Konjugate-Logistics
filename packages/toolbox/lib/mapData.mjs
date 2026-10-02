/* Copyright © 2026 Zenin Easa Panthakkalakath */

// What the window's map draws, made small enough to hand to a window: lines and outlines simplified
// to about the width of a road at the region's scale, and coordinates rounded to about a metre.

import { clipLine, clipRing, decode } from './geography.mjs';
import { toLocal } from './geo.mjs';

const round = (value) => Math.round(value * 1e5) / 1e5;

// Douglas-Peucker in metres.
export function simplify(points, tolerance) {
    if (points.length <= 2) return points;
    const origin = points[0];
    const local = points.map((point) => toLocal(point, origin));
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [first, last] = stack.pop();
        const a = local[first];
        const b = local[last];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        let worst = -1;
        let worstDistance = 0;
        for (let index = first + 1; index < last; index += 1) {
            const p = local[index];
            const distance = length === 0 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / length;
            if (distance > worstDistance) { worst = index; worstDistance = distance; }
        }
        if (worst >= 0 && worstDistance > tolerance) {
            keep[worst] = 1;
            stack.push([first, worst], [worst, last]);
        }
    }
    return points.filter((_, index) => keep[index]);
}

const pack = (points) => points.map((point) => [round(point.lat), round(point.lon)]);

// `layers` is discoverRegion's; `bbox` sets the scale. Returns plain arrays of [lat, lon] pairs.
export function mapLayers(layers, bbox) {
    const spanMetres = Math.max(1000, (bbox.north - bbox.south) * 111320);
    const tolerance = spanMetres / 2000; // about half a pixel on a 1000-pixel map
    const outline = (feature) => [feature.ring, ...(feature.rings ?? [])].filter(Boolean).map((ring) => pack(simplify(ring, tolerance)));
    return {
        bbox,
        roads: layers.roads.map((feature) => ({ highway: feature.tags.highway, points: pack(simplify(feature.line ?? feature.ring ?? [], tolerance)) })).filter((road) => road.points.length > 1),
        rail: layers.rail.map((feature) => pack(simplify(feature.line, tolerance))),
        industrial: layers.industrial.flatMap(outline),
        ports: layers.ports.flatMap(outline),
        anchorages: layers.anchorages.map((feature) => [round(feature.point.lat), round(feature.point.lon)]),
        attribution: 'Map data © OpenStreetMap contributors, ODbL'
    };
}

// Land, coastlines and country borders around the region, from the Natural Earth tiles it touches (`tiles` is their
// content): cut to the region with a margin, so panning a little does not show an edge, and simplified at the map's
// scale. Borders keep whether they are settled: the window draws the others dashed.
export const geographyAttribution = 'Coast and borders: Natural Earth';
export function geographyLayers(tiles, bbox) {
    const spanMetres = Math.max(1000, (bbox.north - bbox.south) * 111320);
    const tolerance = spanMetres / 2000;
    const margin = 0.5 * Math.max(bbox.north - bbox.south, bbox.east - bbox.west);
    const box = { south: bbox.south - margin, north: bbox.north + margin, west: bbox.west - margin, east: bbox.east + margin };
    const land = [];
    const coast = [];
    const borders = [];
    for (const tile of tiles) {
        for (const ring of tile.land ?? []) {
            const cut = clipRing(decode(ring), box);
            if (cut.length >= 3) land.push(pack(simplify([...cut, cut[0]], tolerance)));
        }
        for (const line of tile.coast ?? []) for (const run of clipLine(decode(line), box)) coast.push(pack(simplify(run, tolerance)));
        for (const border of tile.borders ?? []) {
            for (const run of clipLine(decode(border.points), box)) borders.push({ settled: border.settled, points: pack(simplify(run, tolerance)) });
        }
    }
    return { land: land.filter((ring) => ring.length >= 3), coast: coast.filter((line) => line.length >= 2), borders: borders.filter((border) => border.points.length >= 2) };
}
