/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Small geometry on latitude and longitude, accurate enough for a region a few hundred kilometres
// across: distances by haversine, areas by projecting onto a local plane around the shape.

const earthRadius = 6371008.8;
const radians = (degrees) => degrees * Math.PI / 180;

// Great-circle distance in metres between { lat, lon } points.
export function distance(a, b) {
    const dLat = radians(b.lat - a.lat);
    const dLon = radians(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Metres east and north of `origin`.
export function toLocal(point, origin) {
    return {
        x: radians(point.lon - origin.lon) * earthRadius * Math.cos(radians(origin.lat)),
        y: radians(point.lat - origin.lat) * earthRadius
    };
}

// Area in square metres of a ring of { lat, lon } points (closed or not).
export function ringArea(ring) {
    if (!ring || ring.length < 3) return 0;
    const origin = ring[0];
    const local = ring.map((point) => toLocal(point, origin));
    let twice = 0;
    for (let index = 0; index < local.length; index += 1) {
        const a = local[index];
        const b = local[(index + 1) % local.length];
        twice += a.x * b.y - b.x * a.y;
    }
    return Math.abs(twice) / 2;
}

// Length in metres of a line of { lat, lon } points.
export function lineLength(line) {
    let total = 0;
    for (let index = 1; index < (line?.length ?? 0); index += 1) total += distance(line[index - 1], line[index]);
    return total;
}

export function centroid(points, weights = null) {
    let lat = 0;
    let lon = 0;
    let total = 0;
    points.forEach((point, index) => {
        const weight = weights ? weights[index] : 1;
        lat += point.lat * weight;
        lon += point.lon * weight;
        total += weight;
    });
    if (!(total > 0)) return centroid(points);
    return { lat: lat / total, lon: lon / total };
}

export function pointInRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const a = ring[i];
        const b = ring[j];
        if ((a.lat > point.lat) !== (b.lat > point.lat) && point.lon < (b.lon - a.lon) * (point.lat - a.lat) / (b.lat - a.lat) + a.lon) inside = !inside;
    }
    return inside;
}

export function boundsArea(bounds) {
    return ringArea([
        { lat: bounds.minlat, lon: bounds.minlon }, { lat: bounds.minlat, lon: bounds.maxlon },
        { lat: bounds.maxlat, lon: bounds.maxlon }, { lat: bounds.maxlat, lon: bounds.minlon }
    ]);
}

// Groups items whose points lie within `radius` metres of another item in the group (single
// linkage), using a grid so large inputs stay fast. Returns arrays of the original items.
export function clusterByDistance(items, pointOf, radius) {
    if (!items.length) return [];
    const origin = pointOf(items[0]);
    const local = items.map((item) => toLocal(pointOf(item), origin));
    const cell = (value) => Math.floor(value / radius);
    const grid = new Map();
    local.forEach((point, index) => {
        const key = `${cell(point.x)},${cell(point.y)}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(index);
    });
    const parent = items.map((_, index) => index);
    const find = (index) => {
        while (parent[index] !== index) index = parent[index] = parent[parent[index]];
        return index;
    };
    local.forEach((point, index) => {
        const cx = cell(point.x);
        const cy = cell(point.y);
        for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
            for (const other of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
                if (other <= index) continue;
                if (Math.hypot(local[other].x - point.x, local[other].y - point.y) <= radius) parent[find(other)] = find(index);
            }
        }
    });
    const groups = new Map();
    items.forEach((item, index) => {
        const root = find(index);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(item);
    });
    return [...groups.values()];
}
